import {createHash,randomUUID} from 'node:crypto';
import {withTransaction,type Tx} from '../db/tx';
import {currentAccessContext,type AccessContext} from '../auth/accessScope';
import {lockAuthorization,resolveAuthorizationFrom} from '../repositories/roleRepo';
import {findAuthIdentity} from '../repositories/userRepo';
import {readUserScope} from '../repositories/userScopeRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import * as repo from '../repositories/followupRepo';
import {parseCreate,parseRevision,parseConclusion,sourceEvaluation,formalEvaluationState} from '../domain/followup';
import {AppError} from '../http/errors';
import type {FollowupInput,FollowupView,ComplaintFollowupsView} from '../types/api';
export interface FollowupContext {userId:string|null;clientIp?:string|null}
interface CurrentActor {userId:string;name:string;access:AccessContext}
/** All reads/writes load current DB grants/identity/scope under the A5 singleton.
 * The caller must be bound to authenticated ALS; no token/supplied roles authorize. */
async function currentActor(tx:Tx,ctx:FollowupContext,permission:string):Promise<CurrentActor> {
 if(!ctx.userId||currentAccessContext().userId!==ctx.userId)throw AppError.forbidden();
 await lockAuthorization(tx);
 const [rows]=await tx.query('select user_id from app_user where user_id=? for update',[ctx.userId]);if(!(rows as unknown[]).length)throw AppError.forbidden();
 const identity=await findAuthIdentity(tx,ctx.userId);const auth=await resolveAuthorizationFrom(tx,ctx.userId);
 if(!identity||identity.status!==1||identity.mustChangePassword||!auth.permissionCodes.includes(permission as any)||(permission!=='complaint.read'&&auth.roleCodes.includes('readonly')))throw AppError.forbidden();
 if(permission==='followup.conclude'&&identity.accountType!=='internal')throw AppError.forbidden('主管结论需要已确认的内部账号身份');
 const scope=await readUserScope(tx,ctx.userId);return {userId:ctx.userId,name:identity.username,access:{userId:ctx.userId,roles:auth.roleCodes,scopeVersion:scope.scopeVersion,rules:auth.roleCodes.length?scope.rules:[],canReadSource:false}};
}
export async function getFollowups(idOrNo:string,ctx:FollowupContext):Promise<ComplaintFollowupsView> {return withTransaction(async tx=>{
 const actor=await currentActor(tx,ctx,'complaint.read');const complaint=await repo.lockComplaint(tx,idOrNo,actor.access);const complaintId=String(complaint.complaint_id);
 const history=await repo.readHistory(tx,complaintId,actor.access);const heads=new Map<string,FollowupView>();for(const row of history)heads.set(row.followupId,row);
 return {complaintId,records:[...heads.values()],history,sourceEvaluation:sourceEvaluation(complaint.source_payload),formalEvaluation:{...formalEvaluationState}};
});}
export async function createFollowup(input:FollowupInput,ctx:FollowupContext):Promise<FollowupView> {
 const {complaintId,...body}=input;const parsed=parseCreate(body);return withTransaction(async tx=>{
  const actor=await currentActor(tx,ctx,'followup.create');const complaint=await repo.lockComplaint(tx,complaintId,actor.access);const canonicalId=String(complaint.complaint_id);
  const hash=hashPayload({operation:'create',complaintId:canonicalId,...parsed});const retry=await replay(tx,actor,canonicalId,'create',parsed.requestId,hash);if(retry)return retry;
  const now=new Date();const id='FUP-'+randomUUID();await repo.insertHeader(tx,id,canonicalId,actor.userId,now);const h=await repo.readHeader(tx,id,actor.access,true);
  const {requestId,...facts}=parsed;const view:FollowupView={...facts,...h,version:1,action:'create',operatorId:actor.userId,operatorName:actor.name,reason:null,revisedAt:now.toISOString(),conclusion:null,concludedBy:null,concludedAt:null};
  return persist(tx,actor,ctx,view,'create',requestId,hash);
 });
}
export async function reviseFollowup(id:string,input:unknown,ctx:FollowupContext):Promise<FollowupView> {const parsed=parseRevision(input);return change(id,parsed,ctx,'revise');}
export async function concludeFollowup(id:string,input:unknown,ctx:FollowupContext):Promise<FollowupView> {const parsed=parseConclusion(input);return change(id,parsed,ctx,'conclude');}
async function change(id:string,input:ReturnType<typeof parseRevision>|ReturnType<typeof parseConclusion>,ctx:FollowupContext,operation:'revise'|'conclude'):Promise<FollowupView> {
 if(!/^FUP-[-a-zA-Z0-9]{1,60}$/.test(id))throw AppError.notFound('回访不存在');
 return withTransaction(async tx=>{
  const actor=await currentActor(tx,ctx,operation==='revise'?'followup.create':'followup.conclude');const hint=await repo.readHeader(tx,id,actor.access);
  await repo.lockComplaint(tx,hint.complaintId,actor.access);const h=await repo.readHeader(tx,id,actor.access,true);
  if(operation==='revise'&&h.ownerId!==actor.userId)throw AppError.forbidden('只能更正本人登记的回访');
  const hash=hashPayload({operation,complaintId:h.complaintId,followupId:id,...input});const retry=await replay(tx,actor,h.complaintId,operation,input.requestId,hash);if(retry)return retry;
  if(input.expectedVersion!==h.version)throw AppError.conflict('回访版本已变化，请刷新核对');if(h.version>=Number.MAX_SAFE_INTEGER)throw AppError.conflict('回访版本超出安全范围');
  const old=await repo.readRevision(tx,id,h.version,actor.access);const now=new Date().toISOString();let view:FollowupView;
  if(operation==='conclude'){const p=input as ReturnType<typeof parseConclusion>;view={...old,conclusion:p.conclusion,concludedBy:actor.userId,concludedAt:now};}
  else {const {requestId:_request,expectedVersion:_version,reason:_reason,...facts}=input as ReturnType<typeof parseRevision>;view={...old,...facts};}
  view={...view,version:h.version+1,action:operation,operatorId:actor.userId,operatorName:actor.name,reason:input.reason,revisedAt:now};
  return persist(tx,actor,ctx,view,operation,input.requestId,hash);
 });
}
const hashPayload=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
async function replay(tx:Tx,actor:CurrentActor,complaintId:string,operation:string,requestId:string,hash:string) {const r=await repo.readRequest(tx,actor.userId,complaintId,operation,requestId);if(!r)return null;if(r.payload_hash!==hash)throw AppError.conflict('同一幂等键的回访内容不同');return repo.readRevision(tx,r.followup_id,Number(r.result_version),actor.access);}
async function persist(tx:Tx,actor:CurrentActor,ctx:FollowupContext,view:FollowupView,operation:string,requestId:string,hash:string) {
 await repo.appendRevision(tx,view);await repo.insertRequest(tx,actor.userId,view.complaintId,operation,requestId,hash,view.followupId,view.version);
 await insertAudit(tx,{userId:actor.userId,appCode:'gqxq',resourceCode:'followup',action:'FOLLOWUP_'+operation.toUpperCase(),bizType:'manual_followup',bizId:view.followupId,result:'success',clientIp:ctx.clientIp??null,createdAt:new Date(),detail:{followupId:view.followupId,version:view.version,operation,contacted:view.contacted,evaluationCode:view.evaluationCode}});
 return repo.readRevision(tx,view.followupId,view.version,actor.access);
}
