import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.DOTENV_CONFIG_PATH='nonexistent-audit-regression.env';
process.env.GQXQ_DB_USER='test';process.env.GQXQ_DB_NAME='test';process.env.GQXQ_JWT_SECRET='local-test-only';
test('concurrent duplicate of rejected event stays rejected in both insert branches',async()=>{
 const {handleCallback}=await import('../src/services/callbackService');
 const {signCallback}=await import('../src/clients/callbackSignature');
 const {pool}=await import('../src/db/pool');const {env}=await import('../src/config/env');
 const original={query:pool.query,execute:pool.execute,getConnection:pool.getConnection};
 Object.assign(env.callback,{keyId:'test',keyVersion:'v1',secret:'local-test-secret',ackMode:'BODY',ackValue:'OK'});
 try{for(const valid of [false,true]){
  const payload:any=valid?{eventId:'valid-race',eventType:'TASK_ACCEPTED',sourceAppCode:'gqxq',sourceBusinessId:'C',taskId:'T',sceneCode:'GQXQ_SENSITIVE_DISPATCH',enterpriseSubject:{subjectCode:'E',subjectName:'Enterprise'},enterpriseDisposalResult:{},approvalConclusion:'PENDING',templateVersion:1,attachments:[],occurredAt:new Date().toISOString()}:{eventId:'bad-race',eventType:'BAD'};
  let reads=0;
  const query=async()=>[reads++===0?[]:[{sourceBusinessId:null,eventId:payload.eventId,eventType:'task_accepted',processedResult:'rejected',processedMessage:'invalid relation',ackBody:'OK',payload}],[]];
  const execute=async(sql:string)=>{if(sql.startsWith('insert into business_event'))throw Object.assign(new Error('raced'),{code:'ER_DUP_ENTRY'});return [{affectedRows:1},[]];};
  Object.assign(pool,{query,execute,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
  const rawBody=Buffer.from(JSON.stringify(payload));const timestamp=String(Math.floor(Date.now()/1000));
  const result=await handleCallback({rawBody,keyId:'test',keyVersion:'v1',timestamp,headerEventId:payload.eventId,signature:signCallback(env.callback.secret,Number(timestamp),rawBody),remoteIp:null});
  assert.equal(result.status,400,'branch valid='+valid);assert.notEqual(result.result?.accepted,true);
 }}finally{Object.assign(pool,original);}
});
test('operator enqueue preserves unknown snapshot bytes and refuses missing identity, revoked permission and corrupt evidence', async () => {
 const { pushDispatch } = await import('../src/services/dispatchPushService');
 const { serializeOnce } = await import('../src/clients/publicUtilityClient');
 const { runWithAccessContext } = await import('../src/auth/accessScope');
 const { pool } = await import('../src/db/pool'); const { env } = await import('../src/config/env');
 Object.assign(env.pu, {baseUrl:'https://example.invalid',appCode:'gqxq',keyId:'test',keyVersion:'v1',secret:'local-test-secret'});
 const original = {query:pool.query,execute:pool.execute,getConnection:pool.getConnection,fetch:globalThis.fetch};
 const payload = {sourceAppCode:'gqxq',sourceBusinessId:'C',requestId:'R',enterpriseSubjects:[{subjectCode:'E',subjectName:'Enterprise'}],metadata:{contractVersion:2,assignmentId:'A'}};
 const serialized = serializeOnce(payload); let snapshot = serialized; let digest = serialized.bodySha256;
 let permission = true; let outbox: any = null; let fetches = 0; let reads = 0; let stored = true;
 const order = {assignment_id:'A',complaint_id:'C',request_id:'R',status:'pending',target_enterprise_code:'E',target_enterprise_name:'Enterprise',deadline:null,requirement:null as string|null,complaint_title:'changed title'};
 const query = async (sql:string) => {
  reads++;
  if(sql.includes('dispatch_push_snapshot')) return [stored ? [{body:snapshot.bodyText,sha256:digest}] : [],[]];
  if(sql.includes('dispatch_request_log')) return [stored ? [{body:serialized.bodyText}] : [],[]];
  if(sql.includes('dispatch_outbox')) return [outbox ? [outbox] : [],[]];
  if(sql.includes('enterprise')) { if(!sql.includes('from complaint') && !sql.includes('from dispatch_order')) return [[],[]]; }
  if(sql.includes('from dispatch_order')) return [[order],[]];
  if(sql.includes('from complaint')) return [[{enterprise_code:'E',district_code:null,deleted:0,edit_version:1}],[]];
  if(sql.includes('cross join platform_authorization_state')) return [[{authorization_version:1,role_code:'handler',permission_code:permission?'dispatch.push':null}],[]];
  if(sql.includes('scope_version, scope_rules')) return [[{scope_version:1,scope_rules:[{kind:'all'}]}],[]];
  if(sql.includes('from app_user')) return [[{user_id:'operator',username:'operator',roles:['handler'],status:1,must_change_password:0,session_version:1}],[]];
  if(sql.includes('platform_authorization_state')) return [[{version:1}],[]];
  throw new Error('unexpected query '+sql);
 };
 const execute = async (sql:string, p:any[]) => {
  if(sql.startsWith('insert into dispatch_outbox')) outbox = {request_id:p[0],assignment_id:p[1],complaint_id:p[2],payload_hash:p[3],transport_identity:p[4],recovery_mode:p[5],contract_version:p[6],state:p[7],attempts:0,has_unknown:p[8],next_attempt_at:p[9],task_id:null};
  else assert.ok(sql.startsWith('insert into operation_audit_log') || sql.startsWith('update dispatch_outbox'), sql);
  return [{affectedRows:1},[]];
 };
 Object.assign(pool,{query,execute,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
 globalThis.fetch = async () => { fetches++; throw new Error('operator enqueue must not send historical bytes'); };
 const access = {userId:'operator',roles:['handler'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false};
 const push = () => runWithAccessContext(access, () => pushDispatch('A',{userId:'operator',clientIp:null}));
 try {
  await assert.rejects(() => pushDispatch('A',{userId:null,clientIp:null}), (e:any) => e.status===403);
  await assert.rejects(() => pushDispatch('A',{userId:'operator',clientIp:null}), (e:any) => e.status===403);
  assert.equal(reads,0);
  permission=false; await assert.rejects(push,(e:any)=>e.status===403); assert.equal(outbox,null);
  permission=true;
  const result = await push(); assert.equal(result.result,'unknown'); assert.equal(result.deliveryState,'unknown');
  assert.equal(outbox.payload_hash,serialized.bodySha256); assert.equal(snapshot.bodyText,serialized.bodyText); assert.equal(fetches,0);
  const first = {...outbox}; await push(); assert.deepEqual(outbox,first);
  digest='corrupted'; await assert.rejects(push,/digest mismatch/);
  snapshot=serializeOnce({...payload,requestId:'OTHER'});digest=snapshot.bodySha256;await assert.rejects(push,/identity mismatch/);
  assert.equal(fetches,0); assert.deepEqual(outbox,first);
  stored=false; outbox=null; order.deadline=new Date() as any; order.requirement='请复核处置现场';
  globalThis.fetch=async (url:any) => { assert.ok(String(url).endsWith('/preflight')); fetches++; return new Response(JSON.stringify({ready:false,issues:[{code:'TEMPLATE_UNAVAILABLE',subjectCode:null,message:'disabled'}]}),{status:200}); };
  await assert.rejects(push, (e:any)=>e.errorCode==='VALIDATION_FAILED');
  assert.equal(fetches,1); assert.equal(outbox,null);
 } finally { Object.assign(pool,{query:original.query,execute:original.execute,getConnection:original.getConnection}); globalThis.fetch=original.fetch; }
});
