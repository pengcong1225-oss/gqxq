import { assertLockedComplaintAccess,currentAccessContext,runWithAccessContext } from '../auth/accessScope';
import {lockAuthorization,resolveAuthorizationFrom} from '../repositories/roleRepo';
import {readUserScope} from '../repositories/userScopeRepo';
import {findAuthIdentity} from '../repositories/userRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {toIso} from '../repositories/complaintMapper';
import {enqueueInTx,readOutbox,canRecoverUnknown,type OutboxRow} from '../repositories/dispatchOutboxRepo';
import {currentTransportIdentity} from '../clients/publicUtilityClient';
import { projectTransportMessage } from './complaintProjection';
import { randomUUID } from 'node:crypto';
import { TERMINAL_SUPERVISION_STATUSES } from '../domain/enums';
// Operator push persists scoped intent; the server worker sends immutable bytes.
import { AppError } from '../http/errors';
import type { DispatchRequestLogItem, PushDispatchResult, PushResultKind } from '../types/api';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { lowercaseHexSha256 } from '../clients/publicUtilityClient';
import { cut } from '../repositories/complaintSourceLogRepo';
import {
  assertPuCredentials,
  buildAttempt,
  integrationTaskPath,
  postIntegrationTask,
  serializeOnce,
  type PuTransportOutcome,
} from '../clients/publicUtilityClient';
import { findOrderByAssignmentId } from '../repositories/dispatchRepo';
import { findRequestLogsByAssignment } from '../repositories/dispatchRequestLogRepo';
import {
  preparePush,
  type OperatorContext,
  type PushPreparation,
} from './dispatchService';

/** 对方 IntegrationSignatureFilter.TASK_FIELDS —— 顶层只接受这 16 个字段，多一个即 422 */
export const PU_TASK_FIELDS = [
  'sourceAppCode',
  'sourceBusinessId',
  'requestId',
  'sceneCode',
  'templateCode',
  'templateVersion',
  'title',
  'deadline',
  'focusFlag',
  'enterpriseSubjects',
  'prefilledData',
  'approvalDefinitionCode',
  'approvalDefinitionVersion',
  'callbackPolicy',
  'metadata',
  'organizationCode',
] as const;

/**
 * 库里的 datetime 存的是 Asia/Shanghai 墙钟，连接池把它读成对应时刻的 Date。
 * 这里还原成**带 +08:00 偏移**的 ISO-8601 —— 对方用 OffsetDateTime.parse 解析，缺偏移会 422。
 */
export function toOffsetIso(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

/**
 * 构造与本站白名单同步的载荷，organizationCode 显式来自场景配置。
 * metadata 固定契约、交办关联、配置版本和只读来源证据。
 */
export function buildTaskPayload(prep: PushPreparation): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sourceAppCode: env.pu.appCode,
    sourceBusinessId: prep.complaintId,
    requestId: prep.requestId,
    sceneCode: env.pu.sceneCode,
    templateCode: env.pu.templateCode,
    templateVersion: env.pu.templateVersion,
    title: cut(prep.complaintTitle, 200),
    deadline: toOffsetIso(prep.deadline),
    focusFlag: true,
    enterpriseSubjects: [
      {
        subjectCode: cut(prep.targetEnterpriseCode, 128),
        subjectName: cut(prep.targetEnterpriseName, 200),
      },
    ],
    prefilledData: {
      complaintNo: prep.complaintNo ?? undefined,
      sourceEventNo: prep.sourceEventNo ?? undefined,
      dispatchRequirement: prep.requirement ?? '',
    },
    organizationCode: env.pu.organizationCode || undefined,
    approvalDefinitionCode: env.pu.approvalCode,
    approvalDefinitionVersion: env.pu.approvalVersion,
    callbackPolicy: { subscriptionCode: env.pu.callbackSubscription, deliveryRequired: true },
    metadata: {
      contractVersion: 2,
      configurationVersion: env.pu.configurationVersion,
      assignmentId: prep.assignmentId,
      sourceContext: prep.sourceContext ?? {},
      sourceAttachments: prep.sourceAttachments ?? [],
      reason: prep.reason ?? undefined,
      dispatchType: prep.dispatchType ?? undefined,
      triggerType: prep.triggerType ?? undefined,
      focusLabel: '重点关注',
    },
  };

  // 防御：字段名一旦写错或将来被人"顺手加一个字段"，这里立刻炸，而不是等对方 422
  const unexpected = Object.keys(payload).filter(
    (key) => !(PU_TASK_FIELDS as readonly string[]).includes(key)
  );
  if (unexpected.length > 0) {
    throw AppError.internal('构造出的任务载荷含对方白名单外字段：' + unexpected.join(', '));
  }
  return payload;
}

/** Original bytes remain authoritative even after the complaint or configuration changes. */
export function restoreSnapshot(bodyText:string, expectedSha256?:string): import('../clients/publicUtilityClient').SerializedBody {
 const bodyBytes=Buffer.from(bodyText,'utf8');
 const bodySha256=lowercaseHexSha256(bodyBytes);
 if (expectedSha256 && bodySha256!==expectedSha256) throw AppError.internal('immutable push snapshot digest mismatch');
 return {bodyText,bodyBytes,bodySha256};
}

export interface ClassifiedOutcome {
  result: PushResultKind;
  httpStatus: number | null;
  errorCode: string | null;
  message: string | null;
  taskId: string | null;
  created: boolean;
  retryable: boolean;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 错误码处置表（落地计划 §3.1）逐条实现成可测分支 */
export function classifyOutcome(outcome: PuTransportOutcome): ClassifiedOutcome {
  if (outcome.kind === 'timeout') {
    return {
      result: 'timeout', httpStatus: null, errorCode: null, message: outcome.message,
      taskId: null, created: false, retryable: true,
    };
  }
  if (outcome.kind === 'network_error') {
    return {
      result: 'network_error', httpStatus: null, errorCode: null, message: outcome.message,
      taskId: null, created: false, retryable: true,
    };
  }

  const status = outcome.httpStatus;
  const body = parseJsonObject(outcome.bodyText);
  const code = body !== null && typeof body.code === 'string' ? body.code : null;
  const message =
    body !== null && typeof body.message === 'string'
      ? body.message
      : (outcome.bodyText.slice(0, 500) === '' ? null : outcome.bodyText.slice(0, 500));

  if (status === 200) {
    const created = body !== null && body.created === true;
    const task =
      body !== null && body.task !== null && typeof body.task === 'object' && !Array.isArray(body.task)
        ? (body.task as Record<string, unknown>)
        : null;
    const id=task?.id;
    const taskId = typeof id==='string'&&id.trim()&&id.length<=128?id.trim():typeof id==='number'&&Number.isSafeInteger(id)&&id>0?String(id):null;
    if (taskId !== null && taskId.trim() !== '') {
      return {
        result: 'success', httpStatus: status, errorCode: null, message: null,
        taskId, created, retryable: false,
      };
    }
    // 200 却没给出可用 task.id：对方接受了任务但拿不到任务号。
    // 未确认部署恢复契约时无法安全推断重放结果，转人工核对。
    return {
      result: 'unknown',
      httpStatus: status,
      errorCode: code,
      message:
        '对方返回 200 但未提供 task.id（created=' + String(created) + '），无法登记填报任务号，需人工核对',
      taskId: null,
      created,
      retryable: false,
    };
  }

  if (status === 401) {
    return {
      result: 'auth_failed', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }
  if (status === 409) {
    if (code === 'INTEGRATION_REPLAY') { // gate-g1-allow：对方协议错误码，必须逐字比对，不能小写化
      return {
        result: 'replay', httpStatus: status, errorCode: code, message,
        taskId: null, created: false, retryable: true,
      };
    }
    return {
      result: 'conflict', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }
  if (status === 413) {
    return {
      result: 'payload_too_large', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }
  if (status === 422) {
    return {
      result: 'validation_failed', httpStatus: status, errorCode: code, message,
      taskId: null, created: false, retryable: false,
    };
  }

  // 其它未列举状态（含 5xx）：归到传输类失败；httpStatus 原样记进日志便于定位。
  // 5xx 视为可重试，4xx 视为不可重试。
  return {
    result: 'network_error', httpStatus: status, errorCode: code, message,
    taskId: null, created: false, retryable: status >= 500,
  };
}

/** Explicit operator intent only: this endpoint persists work, never creates a remote task. */
export async function pushDispatch(assignmentId:string,ctx:OperatorContext):Promise<PushDispatchResult> {
 if(!ctx.userId||currentAccessContext().userId!==ctx.userId)throw AppError.forbidden();
 const probe=await findOrderByAssignmentId(pool,assignmentId);if(!probe)throw AppError.notFound('交办不存在');
 assertPuCredentials();
 const [snapshots]=await pool.query('select body,sha256 from dispatch_push_snapshot where assignment_id=?',[assignmentId]) as [Array<{body:string;sha256:string}>,unknown];
 const [legacy]=await pool.query('select request_body as body from dispatch_request_log where assignment_id=? and request_body is not null order by attempt,id limit 1',[assignmentId]) as [Array<{body:string}>,unknown];
 const legacyBytes=snapshots[0]??legacy[0];
 if(probe.reporting_task_id&&!legacyBytes)throw AppError.conflict('已有填报任务但缺少原始请求证据，需人工核验');
 const candidate=legacyBytes?restoreSnapshot(legacyBytes.body,'sha256' in legacyBytes?legacyBytes.sha256:undefined):serializeOnce(buildTaskPayload(await preparePush(assignmentId)));
 validatePushIdentity(candidate,assignmentId,String(probe.complaint_id),String(probe.request_id),String(probe.target_enterprise_code));
 const identity=currentTransportIdentity();
 const [versions]=await pool.query('select edit_version from complaint where complaint_id=?',[String(probe.complaint_id)]) as [Array<{edit_version:number}>,unknown];
 if(!legacyBytes){const readiness=await preflightPayload(JSON.parse(candidate.bodyText));if(!readiness.ready)throw AppError.validation('本站填报配置或账号授权未就绪',readiness.issues.map(i=>({field:i.subjectCode??i.code,message:i.message})));}
 const job=await withTransaction(async tx=>{
  // Authorization singleton comes before user/scope and business locks, like A5/C3.
  await lockAuthorization(tx);await tx.query('select user_id from app_user where user_id=? for update',[ctx.userId]);
  const auth=await resolveAuthorizationFrom(tx,ctx.userId!);const user=await findAuthIdentity(tx,ctx.userId!);
  if(!user||user.status!==1||user.mustChangePassword||auth.roleCodes.includes('readonly')||!auth.permissionCodes.includes('dispatch.push'))throw AppError.forbidden();
  const scope=await readUserScope(tx,ctx.userId!);
  const access={userId:ctx.userId!,roles:auth.roleCodes,scopeVersion:scope.scopeVersion,rules:scope.rules,canReadSource:false};
  return runWithAccessContext(access,async()=>{
   const order=await findOrderByAssignmentId(tx,assignmentId);if(!order)throw AppError.notFound('交办不存在');
   await assertLockedComplaintAccess(tx,String(order.complaint_id));
   const [locked]=await tx.query('select complaint_id,request_id,status,target_enterprise_code,reporting_task_id from dispatch_order where assignment_id=? for update',[assignmentId]) as [Array<Record<string,unknown>>,unknown];const current=locked[0];
   if(!current||String(current.complaint_id)!==String(probe.complaint_id)||String(current.request_id)!==String(probe.request_id))throw AppError.conflict('交办关联已变化，请刷新');
   if((TERMINAL_SUPERVISION_STATUSES as readonly string[]).includes(String(current.status)))throw new AppError('INVALID_STATE_TRANSITION','终态交办不允许推送');
   if(identity!==currentTransportIdentity())throw AppError.conflict('集成目标已变化，请重新预检');
   const [stored]=await tx.query('select body,sha256 from dispatch_push_snapshot where assignment_id=?',[assignmentId]) as [Array<{body:string;sha256:string}>,unknown];
   let bytes=candidate;
   if(stored[0])bytes=restoreSnapshot(stored[0].body,stored[0].sha256);
   else if(!legacyBytes){
    const [nowVersion]=await tx.query('select edit_version from complaint where complaint_id=?',[String(current.complaint_id)]) as [Array<{edit_version:number}>,unknown];
    const final=serializeOnce(buildTaskPayload(await preparePush(assignmentId,tx)));
    if(final.bodySha256!==candidate.bodySha256||String(nowVersion[0]?.edit_version)!==String(versions[0]?.edit_version))throw AppError.conflict('预检后诉求或交办信息已变化，请刷新重试');
   }
   validatePushIdentity(bytes,assignmentId,String(current.complaint_id),String(current.request_id),String(current.target_enterprise_code));
   if(!stored[0])await tx.execute('insert into dispatch_push_snapshot(assignment_id,request_id,body,sha256,created_at) values(?,?,?,?,?)',[assignmentId,String(current.request_id),bytes.bodyText,bytes.bodySha256,new Date()]);
   const before=await readOutbox(tx,String(current.request_id));
   const row=await enqueueInTx(tx,{request_id:String(current.request_id),assignment_id:assignmentId,complaint_id:String(current.complaint_id),payload_hash:bytes.bodySha256,transport_identity:identity,recovery_mode:env.pu.recoveryMode,contract_version:env.pu.recoveryContractVersion,initiator_id:ctx.userId!,initiator_name:ctx.userName??null,client_ip:ctx.clientIp,scope_version:scope.scopeVersion,authorization_version:auth.authorizationVersion},!!legacyBytes);
   // Explicit retry can schedule a supported unknown recovery, but never change immutable identity.
   if(row.state==='unknown'&&row.transport_identity===identity&&row.recovery_mode==='same-body-idempotent'&&row.contract_version&&env.pu.recoveryMode==='same-body-idempotent'&&row.contract_version===env.pu.recoveryContractVersion)await tx.execute('update dispatch_outbox set next_attempt_at=? where request_id=?',[new Date(),row.request_id]);
   if(!before)await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:assignmentId,action:'DISPATCH_PUSH',bizType:'dispatch_order',bizId:String(current.complaint_id),result:row.state==='unknown'?'unknown':'pending',clientIp:ctx.clientIp,createdAt:new Date(),detail:{assignmentId,complaintId:String(current.complaint_id),stage:'enqueue',deliveryState:row.state,scopeVersion:scope.scopeVersion,authorizationVersion:auth.authorizationVersion}});
   return row;
  });
 });
 return deliveryResult(job);
}

export function validatePushIdentity(body:import('../clients/publicUtilityClient').SerializedBody,assignmentId:string,complaintId:string,requestId:string,enterpriseCode:string):void{
 const p=JSON.parse(body.bodyText) as Record<string,unknown>;const m=p.metadata as Record<string,unknown>|undefined;const subjects=p.enterpriseSubjects as Array<Record<string,unknown>>|undefined;
 if(p.requestId!==requestId||p.sourceAppCode!==env.pu.appCode||p.sourceBusinessId!==complaintId||(m?.contractVersion===2&&m.assignmentId!==assignmentId)||!Array.isArray(subjects)||subjects.length!==1||subjects[0].subjectCode!==enterpriseCode)throw AppError.internal('immutable push snapshot identity mismatch');
}
export function deliveryResult(row:OutboxRow):PushDispatchResult {
 const state=row.state;return {assignmentId:row.assignment_id,requestId:row.request_id,accepted:state==='succeeded',created:state==='succeeded',taskId:row.task_id,attempt:Number(row.attempts),result:state==='succeeded'?'success':state==='unknown'?'unknown':row.last_result??'queued',httpStatus:row.last_http_status,errorCode:row.last_error_code,message:state==='unknown'?'结果未知，需人工核验；原请求号与报文保持不变':state==='pending'?'已排队，尚未确认对方创建任务':state==='sending'?'发送中，尚未确认对方创建任务':state==='failed'?'推送失败或已停止，请核对交办状态、配置与原始请求':null,retryable:canRecoverUnknown(row),deliveryState:state,nextAttemptAt:toIso(row.next_attempt_at)};
}
export interface PreflightResult {ready:boolean;issues:Array<{code:string;subjectCode:string|null;message:string}>}
async function preflightPayload(payload:Record<string,unknown>):Promise<PreflightResult> {
 const probe={...payload,requestId:'preflight:'+randomUUID()};
 const outcome=await postIntegrationTask(buildAttempt(serializeOnce(probe),{endpointPath:integrationTaskPath(env.pu.appCode)+'/preflight'}));
 if(outcome.kind!=='response'||outcome.httpStatus!==200) throw AppError.internal('preflight transport failed; task was not sent');
 const result=JSON.parse(outcome.bodyText) as PreflightResult;
 if(typeof result.ready!=='boolean'||!Array.isArray(result.issues))throw AppError.internal('invalid preflight response');
 return {ready:result.ready,issues:result.issues.map(issue=>({code:String(issue.code??''),subjectCode:typeof issue.subjectCode==='string'?issue.subjectCode:null,message:typeof issue.message==='string'?issue.message:'外部预检未通过'}))};
}
export async function preflightDispatch(assignmentId:string):Promise<PreflightResult>{const prep=await preparePush(assignmentId);assertPuCredentials();return preflightPayload(buildTaskPayload(prep));}

/** 推送尝试日志（按 attempt 升序），交办不存在时 404 */
export async function listPushLogs(
  assignmentId: string
): Promise<{ content: DispatchRequestLogItem[]; total: number }> {
  const order = await findOrderByAssignmentId(pool, assignmentId);
  if (!order) throw AppError.notFound('交办单不存在');
  const content = (await findRequestLogsByAssignment(assignmentId, 200)).map(item=>({...item,errorMessage:projectTransportMessage(item.result,item.errorMessage)}));
  return { content, total: content.length };
}
