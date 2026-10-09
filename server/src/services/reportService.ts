import {randomUUID,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {pool} from '../db/pool';
import {env} from '../config/env';
import type {SqlExecutor} from '../repositories/userRepo';
import {lockAuthorization,resolveAuthorizationFrom} from '../repositories/roleRepo';
import {readUserScope} from '../repositories/userScopeRepo';
import {rowsIn} from '../repositories/serviceGridRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {insertStatisticsSnapshot,storedSnapshot} from '../repositories/statisticsSnapshotRepo';
import {authorizedReport,claimReport,fenceCurrent,findReportRequest,insertReportJob,listReportRows,readReport,reportBinary,reportView,saveReportArtifact,type ReportClaim} from '../repositories/reportRepo';
import {AppError} from '../http/errors';
import {canonical,digest,freezeReportSnapshot,parseReportInput,RENDER_PLAN,REPORT_LIMITS,type ReportSnapshot} from '../domain/reportSnapshot';
import {normalizeStatisticsQuery} from '../domain/statisticsQuery';
import {captureStatisticsIn} from './statisticsService';
import {captureHeatIn} from './heatRuleService';
import {renderReport} from './reportRenderer';
import type {MasterDataContext} from '../types/masterData';
import type {ReportPage} from '../types/report';
const reportId=(id:string)=>{if(!/^RPT-[0-9a-f-]{36}$/.test(id))throw AppError.notFound('报告不存在或不在授权范围');return id;};
async function transaction<T>(fn:(db:SqlExecutor)=>Promise<T>):Promise<T>{const c=await pool.getConnection();try{await c.query('set transaction isolation level read committed');await c.beginTransaction();const value=await fn(c);await c.commit();return value;}catch(e){await c.rollback();throw e;}finally{c.release();}}
/** Fresh identity/grants under the SAME A5 singleton used by all grant writers. */
async function actorIn(db:SqlExecutor,userId:string):Promise<MasterDataContext>{
 await lockAuthorization(db);const u=(await rowsIn(db,'select user_id,username,status,must_change_password from app_user where user_id=? for share',[userId]))[0];
 const a=await resolveAuthorizationFrom(db,userId);if(!u||Number(u.status)!==1||Number(u.must_change_password)||!a.roleCodes.length)throw AppError.forbidden('当前账号无报告数据权限');
 const scope=await readUserScope(db,userId);return {userId,userName:String(u.username),clientIp:null,permissionCodes:a.permissionCodes,access:{userId,roles:a.roleCodes,scopeVersion:scope.scopeVersion,rules:scope.rules,canReadSource:a.permissionCodes.includes('source_document.read')}};
}
function gates(ctx:MasterDataContext,s:ReportSnapshot,operation:'create'|'read'|'download'|'retry'|'finalize'):void {
 const codes=[...s.requiredPermissions,...(operation==='create'||operation==='finalize'?['report.generate']:operation==='retry'?['report.retry','report.generate']:operation==='download'?['report.read','report.download']:['report.read'])];
 if(codes.some(c=>!ctx.permissionCodes.includes(c))||['create','retry','finalize'].includes(operation)&&ctx.access.roles.includes('readonly'))throw AppError.forbidden('缺少报告内容或操作权限');
}
/** Current locking reads are separate from the immutable earlier RR capture.
 * No current rows are inserted back into the original snapshot. */
async function lockCurrentObjects(db:SqlExecutor,s:ReportSnapshot):Promise<void>{
 const enterprises=new Set(s.statistics.masterScopeFacts.map(f=>f.enterpriseCode));
 const admins=new Set<string>(),communities=new Set<string>();
 const grids=[...new Set(s.statistics.coverageEvidence.map(f=>f.coverage.code))].sort();
 const ids=[...new Set(s.statistics.scopeFacts.map(f=>f.complaintId))].sort();
 let discoveredCount=0;
 const bounded=(rows:Record<string,unknown>[])=>{
  discoveredCount+=rows.length;
  if(discoveredCount>REPORT_LIMITS.proofs)throw AppError.validation('报告当前关联超过工程限额，请缩小选择');
  return rows;
 };
 const parents=(row:Record<string,unknown>)=>{
  if(row.enterprise_code!=null)enterprises.add(String(row.enterprise_code));
  if(row.admin_grid_code!=null)admins.add(String(row.admin_grid_code));
  if(row.community_code!=null)communities.add(String(row.community_code));
 };
 // READ COMMITTED probes discover keys only. They never replace frozen facts or
 // establish authorization. Locking reads below must reproduce these references.
 const gridReferences=async(code:string,lock:boolean)=>{
  const suffix=lock?' for share':'';
  const header=await rowsIn(db,'select grid_code,version,import_state from service_grid where grid_code=?'+suffix,[code]);
  if(header.length!==1)throw AppError.notFound('报告当前网格不存在');
  const version=Number(header[0].version);
  const limit=' limit '+(REPORT_LIMITS.proofs+1);
  const enterprise=await rowsIn(db,'select enterprise_code from grid_enterprise where grid_code=? order by enterprise_code'+limit+suffix,[code]);
  const admin=await rowsIn(db,'select admin_grid_code from service_grid_admin where grid_code=? and version=? order by admin_grid_code'+limit+suffix,[code,version]);
  const community=await rowsIn(db,'select community_code from service_grid_community where grid_code=? and version=? order by community_code'+limit+suffix,[code,version]);
  bounded(enterprise);bounded(admin);bounded(community);
  return {header,enterprise,admin,community};
 };
 const priorGrids=new Map<string,Awaited<ReturnType<typeof gridReferences>>>();
 for(const code of grids){
  const refs=await gridReferences(code,false);priorGrids.set(code,refs);
  for(const row of [...refs.enterprise,...refs.admin,...refs.community])parents(row);
 }
 const complaintSql='select complaint_id,enterprise_code,admin_grid_code,community_code from complaint where complaint_id in ';
 const priorComplaints=new Map<string,string>();
 for(let i=0;i<ids.length;i+=200){
  const keys=ids.slice(i,i+200);
  const rows=bounded(await rowsIn(db,complaintSql+'('+keys.map(()=>'?').join(',')+') order by complaint_id',keys));
  for(const row of rows){parents(row);priorComplaints.set(String(row.complaint_id),canonical(row));}
 }
 const priorCommunities=new Map<string,string>();
 for(const code of [...communities].sort()){
  const row=(await rowsIn(db,'select code,admin_grid_code from community where code=?',[code]))[0];
  if(!row)throw AppError.notFound('报告当前小区关联不存在');
  admins.add(String(row.admin_grid_code));priorCommunities.set(code,String(row.admin_grid_code));
 }
 // Same parent-before-child order as B3/B4 and C2. In particular, coverage
 // enterprises are locked even when enterprise.read omitted household masters.
 for(const code of [...enterprises].sort()){
  await db.query('select enterprise_code,district_code from enterprise where enterprise_code=? for share',[code]);
 }
 for(const code of [...admins].sort()){
  const rows=await rowsIn(db,'select code,district_code from admin_grid where code=? for share',[code]);
  if(rows.length!==1)throw AppError.notFound('报告当前行政网格关联不存在');
 }
 for(const code of [...communities].sort()){
  const row=(await rowsIn(db,'select code,admin_grid_code from community where code=? for share',[code]))[0];
  if(!row||String(row.admin_grid_code)!==priorCommunities.get(code))throw AppError.conflict('报告小区父级已变化，请重试');
 }
 discoveredCount=0;
 for(const code of grids){
  const current=await gridReferences(code,true);
  if(canonical(current)!==canonical(priorGrids.get(code)))throw AppError.conflict('报告网格关联已变化，请重试');
 }
 for(let i=0;i<ids.length;i+=200){
  const keys=ids.slice(i,i+200);
  let rows:Record<string,unknown>[];
  try{
   // Legacy assignment writers hold complaint before enterprise. Keep C2/B4
   // parent order here, but never wait on their child while holding its parent.
   rows=bounded(await rowsIn(db,complaintSql+'('+keys.map(()=>'?').join(',')+') order by complaint_id for share nowait',keys));
  }catch(e){
   if((e as {code?:string}).code==='ER_LOCK_NOWAIT'){
    throw new AppError('REPORT_BUSY','报告相关诉求正在修改，请稍后刷新或重试',{cause:e});
   }
   throw e;
  }
  if(rows.length!==keys.length||rows.some(row=>canonical(row)!==priorComplaints.get(String(row.complaint_id)))){
   throw AppError.conflict('报告诉求当前关联已变化，请重试');
  }
 }
}
async function authorizeIn(db:SqlExecutor,id:string,ctx:MasterDataContext,operation:'read'|'download'|'retry'|'finalize'|'create'){
 const row=await readReport(db,id);
 if(!row)throw AppError.notFound('报告不存在或不在授权范围');
 const s=storedSnapshot(row);
 gates(ctx,s,operation);
 // Early deny only: unauthorized guessed IDs must not disclose REPORT_BUSY.
 // This ordinary read cannot replace the complete locked/current proof below.
 if(!await authorizedReport(db,id,ctx.access,ctx.permissionCodes))throw AppError.notFound('报告不存在或不在授权范围');
 await lockCurrentObjects(db,s);
 const allowed=await authorizedReport(db,id,ctx.access,ctx.permissionCodes);
 if(!allowed)throw AppError.notFound('报告不存在或不在授权范围');
 return {row:allowed,snapshot:s};
}
async function audit(db:SqlExecutor,id:string,actor:string,action:string,result:'success'|'failed',detail:Record<string,unknown>){await insertAudit(db as any,{userId:actor,appCode:'gqxq',resourceCode:'report',action,bizType:'report_record',bizId:id,result,clientIp:null,detail,createdAt:new Date()});}
const cursorKey=()=>createHash('sha256').update(env.jwtSecret+'|report-continuation-v1').digest();
function cursorEncode(id:string,user:string,size:number):string {const nonce=Buffer.from(randomUUID().replace(/-/g,''),'hex').subarray(0,12),c=createCipheriv('aes-256-gcm',cursorKey(),nonce);const bytes=Buffer.concat([c.update(JSON.stringify({id,user,size,expires:Date.now()+15*60000})),c.final()]);return Buffer.concat([nonce,c.getAuthTag(),bytes]).toString('base64url');}
function cursorDecode(token:string,user:string,size:number):string {try{if(token.length>1024)throw Error();const b=Buffer.from(token,'base64url'),c=createDecipheriv('aes-256-gcm',cursorKey(),b.subarray(0,12));c.setAuthTag(b.subarray(12,28));const x=JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());if(x.user!==user||x.size!==size||x.expires<Date.now())throw Error();return reportId(x.id);}catch{throw AppError.validation('报告续页无效，请重新刷新');}}
export async function createReport(raw:unknown,initiating:MasterDataContext){
 const input=parseReportInput(raw),clock=()=>new Date();let hash='';
 const first=await transaction(async db=>{const ctx=await actorIn(db,initiating.userId!);input.query=normalizeStatisticsQuery(input.query as any,ctx.access,clock);hash=digest(canonical(input));const required=['report.generate','statistics.read','complaint.read',input.query.dataset==='ledger'?'dashboard.read':'analysis.read',...(input.includeHeat?['heatmap.read']:[])];if(required.some(code=>!ctx.permissionCodes.includes(code))||ctx.access.roles.includes('readonly'))throw AppError.forbidden('缺少报告内容或操作权限');const prior=await findReportRequest(db,ctx.userId!,input.requestId);if(prior){if(prior.request_hash!==hash)throw AppError.conflict('同请求号的报告载荷不同');return {ctx,prior:reportView((await authorizeIn(db,String(prior.report_id),ctx,'create')).row)};}return {ctx,prior:null};});
 if(first.prior)return first.prior;
 const conn=await pool.getConnection();let snapshot:ReportSnapshot;
 try{await conn.query('set transaction isolation level repeatable read');await conn.query('start transaction with consistent snapshot, read only');
  const heat=input.includeHeat?await captureHeatIn(conn,input.query,first.ctx,clock):null;
  const capture=heat?.statistics??await captureStatisticsIn(conn,input.query,first.ctx.access,first.ctx.permissionCodes,clock);
  const links:ReportSnapshot['todoLinks']=[];
  if(input.todoIds.length){if(input.query.dataset!=='analysis')throw AppError.validation('台账报告不能关联分析待办');const included=new Map(capture.rows.filter(r=>r.analysisId).map(r=>[r.analysisId,r.complaintId]));
   for(const id of input.todoIds){const r=(await rowsIn(conn,'select todo_id,analysis_id,complaint_id,report_id from report_todo where todo_id=?',[id]))[0];if(!r||included.get(String(r.analysis_id))!==String(r.complaint_id))throw AppError.notFound('待办不属于实际冻结分析集合');if(r.report_id!=null){const linked=await readReport(conn,String(r.report_id));if(!linked||linked.state!=='succeeded')throw AppError.conflict('已有待办报告关联无法核验，不能替换');await reportBinary(conn,String(r.report_id));}links.push({todoId:id,analysisId:String(r.analysis_id),complaintId:String(r.complaint_id)});}
  }
  snapshot=freezeReportSnapshot(input,capture,first.ctx.access.rules,heat,links);gates(first.ctx,snapshot,'create');
 }finally{await conn.rollback();conn.release();}
 return transaction(async db=>{const ctx=await actorIn(db,initiating.userId!);gates(ctx,snapshot,'create');const prior=await findReportRequest(db,ctx.userId!,input.requestId);if(prior){if(prior.request_hash!==hash)throw AppError.conflict('同请求号的报告载荷不同');return reportView((await authorizeIn(db,String(prior.report_id),ctx,'create')).row);}
  const id='RPT-'+randomUUID(),sid='SNP-'+randomUUID();await lockCurrentObjects(db,snapshot);await insertStatisticsSnapshot(db,sid,snapshot);await insertReportJob(db,id,sid,ctx.userId!,hash,snapshot);await authorizeIn(db,id,ctx,'create');await audit(db,id,ctx.userId!,'REPORT_CREATE','success',{templateCode:'statistics-draft',templateVersion:'v1',format:input.format,state:'pending'});return reportView((await readReport(db,id))!);
 });
}
export async function getReport(id:string,ctx:MasterDataContext){return transaction(async db=>{const current=await actorIn(db,ctx.userId!);return reportView((await authorizeIn(db,reportId(id),current,'read')).row);});}
export async function listReports(ctx:MasterDataContext,size=20,continuation?:string):Promise<ReportPage>{
 if(!Number.isSafeInteger(size)||size<1||size>50)throw AppError.validation('报告页容量无效');
 return transaction(async db=>{const current=await actorIn(db,ctx.userId!);if(!['report.read','statistics.read','complaint.read'].every(c=>current.permissionCodes.includes(c)))throw AppError.forbidden();const before=continuation?cursorDecode(continuation,current.userId!,size):null;
  const rows=await listReportRows(db,current.access,current.permissionCodes,size+1,before);const content=rows.slice(0,size).map(reportView);return {content,hasMore:rows.length>size,continuation:rows.length>size?cursorEncode(content[content.length-1].reportId,current.userId!,size):null};
 });
}
export async function authorizeReportDownload(id:string,ctx:MasterDataContext){return transaction(async db=>{const current=await actorIn(db,ctx.userId!);const r=await authorizeIn(db,reportId(id),current,'download');if(r.row.state!=='succeeded')throw AppError.conflict('报告产物尚未生成成功');const binary=await reportBinary(db,id);await audit(db,id,current.userId!,'REPORT_DOWNLOAD','success',{format:binary.format,contentHash:binary.hash,byteLength:binary.bytes.length});return binary;});}
export async function retryReport(id:string,ctx:MasterDataContext){return transaction(async db=>{const current=await actorIn(db,ctx.userId!);const r=await authorizeIn(db,reportId(id),current,'retry');const live=(await rowsIn(db,'select state,lease_until>=current_timestamp(3) as live from report_job where report_id=? for update',[id]))[0];if(live.state==='succeeded'||live.state==='pending')return reportView(r.row);if(live.state==='generating'&&Number(live.live)===1)throw AppError.conflict('报告仍在有效生成租约内');if(r.snapshot.renderPlan!==RENDER_PLAN)throw AppError.validation('RENDERER_UNAVAILABLE');await db.query("update report_job set state='pending',execution_actor=?,fence=fence+1,owner_token=null,lease_until=null,failure_reason=null where report_id=?",[current.userId,id]);await audit(db,id,current.userId!,'REPORT_RETRY','success',{format:r.snapshot.input.format,state:'pending'});return reportView((await readReport(db,id))!);});}
export async function finalizeReport(c:ReportClaim,bytes:Buffer):Promise<boolean>{
 return transaction(async db=>{const current=await actorIn(db,c.actor);await authorizeIn(db,c.reportId,current,'finalize');if(!await fenceCurrent(db,c))return false;
  await saveReportArtifact(db,c,bytes);
  for(const link of c.snapshot.todoLinks){const row=(await rowsIn(db,'select analysis_id,complaint_id,report_id from report_todo where todo_id=? for update',[link.todoId]))[0];if(!row||row.analysis_id!==link.analysisId||row.complaint_id!==link.complaintId)throw AppError.conflict('冻结待办关联已变化');if(row.report_id!=null){const old=await readReport(db,String(row.report_id));if(!old||old.state!=='succeeded')throw AppError.conflict('已有待办关联不可核验');await reportBinary(db,String(row.report_id));continue;}await db.query("update report_todo set report_id=?,status='done' where todo_id=? and report_id is null",[c.reportId,link.todoId]);}
  await audit(db,c.reportId,c.actor,'REPORT_GENERATE','success',{format:c.snapshot.input.format,state:'succeeded',contentHash:digest(bytes),byteLength:bytes.length,fence:c.fence});return true;
 });
}
export async function failReport(c:ReportClaim,reason:'AUTH_CHANGED'|'RENDER_FAILED'|'RENDERER_UNAVAILABLE'|'REPORT_BUSY'):Promise<void>{await transaction(async db=>{if(!await fenceCurrent(db,c))return;await db.query("update report_job set state='failed',failure_reason=?,owner_token=null,lease_until=null where report_id=? and fence=?",[reason,c.reportId,c.fence]);await audit(db,c.reportId,c.actor,'REPORT_GENERATE','failed',{format:c.snapshot.input.format,state:'failed',failureReason:reason,fence:c.fence});});}
/** Explicit server-owned trust boundary: claim persisted jobs, render ONLY their
 * frozen safe input, then fresh actor + whole authorization + fence finalization.
 * Never establishes trusted all scope or refreshes business statistics. */
export async function generateReport(id?:string,leaseMs=60000):Promise<boolean>{const c=await transaction(db=>claimReport(db,id,leaseMs));if(!c)return false;let bytes:Buffer;
 try{bytes=await renderReport(c.snapshot);}catch{await failReport(c,c.snapshot.renderPlan!==RENDER_PLAN?'RENDERER_UNAVAILABLE':'RENDER_FAILED');return true;}
 try{
  await finalizeReport(c,bytes);
 }catch(e){
  const reason=e instanceof AppError&&e.errorCode==='REPORT_BUSY'?'REPORT_BUSY':
   e instanceof AppError&&[401,403,404].includes(e.status)?'AUTH_CHANGED':'RENDER_FAILED';
  await failReport(c,reason);
 }
 return true;
}
export function startReportWorker(){let busy=false;const run=async()=>{if(busy)return;busy=true;try{for(let n=0;n<3;n++)if(!await generateReport())break;}catch{console.error('[report] durable job retained for retry');}finally{busy=false;}};const timer=setInterval(()=>void run(),15000);timer.unref();void run();return ()=>clearInterval(timer);}
