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
  const query=async()=>[reads++===0?[]:[{eventId:payload.eventId,eventType:'task_accepted',processedResult:'rejected',processedMessage:'invalid relation',ackBody:'OK',payload}],[]];
  const execute=async(sql:string)=>{if(sql.startsWith('insert into business_event'))throw Object.assign(new Error('raced'),{code:'ER_DUP_ENTRY'});return [{affectedRows:1},[]];};
  Object.assign(pool,{query,execute,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
  const rawBody=Buffer.from(JSON.stringify(payload));const timestamp=String(Math.floor(Date.now()/1000));
  const result=await handleCallback({rawBody,keyId:'test',keyVersion:'v1',timestamp,headerEventId:payload.eventId,signature:signCallback(env.callback.secret,Number(timestamp),rawBody),remoteIp:null});
  assert.equal(result.status,400,'branch valid='+valid);assert.notEqual(result.result?.accepted,true);
 }}finally{Object.assign(pool,original);}
});
test('unknown create recovers original bytes without rerunning current readiness; fresh snapshot still preflights',async()=>{
 const {pushDispatch}=await import('../src/services/dispatchPushService');
 const {serializeOnce}=await import('../src/clients/publicUtilityClient');
 const {pool}=await import('../src/db/pool');const {env}=await import('../src/config/env');
 Object.assign(env.pu,{baseUrl:'https://example.invalid',appCode:'gqxq',keyId:'test',keyVersion:'v1',secret:'local-test-secret'});
 const original={query:pool.query,execute:pool.execute,getConnection:pool.getConnection,fetch:globalThis.fetch};
 const payload={sourceAppCode:'gqxq',sourceBusinessId:'C',requestId:'R',metadata:{contractVersion:2,assignmentId:'A'}};
 const serialized=serializeOnce(payload);let snapshot=serialized;let digest=serialized.bodySha256;let attempted=true;let stored=true;const paths:string[]=[];
 const query=async(sql:string)=>{
  if(sql.includes('dispatch_push_snapshot'))return [stored?[{body:snapshot.bodyText,sha256:digest}]:[],[]];
  if(sql.includes('next_attempt'))return [[{next_attempt:2}],[]];
  if(sql.includes('dispatch_request_log'))return [attempted?[{body:serialized.bodyText}]:[],[]];
  if(sql.includes('from complaint '))return [[],[]];
  return [[{assignment_id:'A',complaint_id:'C',request_id:'R',status:'pending',target_enterprise_code:'E',target_enterprise_name:'Enterprise',deadline:stored?null:new Date(),complaint_title:'changed title'}],[]];
 };
 const execute=async()=>[{affectedRows:1},[]];
 Object.assign(pool,{query,execute,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
 globalThis.fetch=async(url:any,init:any)=>{
  paths.push(String(url));
  if(String(url).endsWith('/preflight'))return new Response(JSON.stringify({ready:false,issues:[{code:'TEMPLATE_UNAVAILABLE',subjectCode:null,message:'disabled'}]}),{status:200});
  assert.equal(Buffer.from(init.body).toString(),serialized.bodyText);
  return new Response(JSON.stringify({code:'CONFLICT',message:'probe'}),{status:409});
 };
 try{
  const result=await pushDispatch('A',{userId:null,clientIp:null});assert.equal(result.result,'conflict');assert.equal(paths.length,1);assert.ok(!paths[0].endsWith('/preflight'));
  attempted=false;paths.length=0;
  await pushDispatch('A',{userId:null,clientIp:null});assert.ok(!paths[0].endsWith('/preflight'));
  paths.length=0;digest='corrupted';
  await assert.rejects(()=>pushDispatch('A',{userId:null,clientIp:null}),/digest mismatch/);assert.equal(paths.length,0);
  snapshot=serializeOnce({...payload,requestId:'OTHER'});digest=snapshot.bodySha256;
  await assert.rejects(()=>pushDispatch('A',{userId:null,clientIp:null}),/identity mismatch/);assert.equal(paths.length,0);
  snapshot=serialized;digest=serialized.bodySha256;stored=false;paths.length=0;
  // Model a capacity-one pool: the transaction owns the only connection.
  Object.assign(pool,{query:async()=>{throw new Error('pool unavailable while transaction owns only connection');}});
  await assert.rejects(()=>pushDispatch('A',{userId:null,clientIp:null}),(e:any)=>e.errorCode==='VALIDATION_FAILED');assert.ok(paths[0].endsWith('/preflight'));
 }finally{Object.assign(pool,{query:original.query,execute:original.execute,getConnection:original.getConnection});globalThis.fetch=original.fetch;}
});
