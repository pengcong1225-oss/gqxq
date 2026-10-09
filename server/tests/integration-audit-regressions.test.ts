import { scopedTest as test } from './helpers/scopedTest';
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
  let reads=0;const audits:any[][]=[];
  const query=async()=>[reads++===0?[]:[{eventId:payload.eventId,eventType:'task_accepted',sourceBusinessId:'C',taskId:'T',processedResult:'rejected',processedMessage:'invalid relation',ackBody:'OK',payload}],[]];
  const execute=async(sql:string,p:any[]=[])=>{if(sql.startsWith('insert into business_event'))throw Object.assign(new Error('raced'),{code:'ER_DUP_ENTRY'});if(sql.startsWith('insert into operation_audit_log'))audits.push(p);return [{affectedRows:1},[]];};
  Object.assign(pool,{query,execute,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
  const rawBody=Buffer.from(JSON.stringify(payload));const timestamp=String(Math.floor(Date.now()/1000));
  const result=await handleCallback({rawBody,keyId:'test',keyVersion:'v1',timestamp,headerEventId:payload.eventId,signature:signCallback(env.callback.secret,Number(timestamp),rawBody),remoteIp:null});
  assert.equal(result.status,400,'branch valid='+valid);assert.notEqual(result.result?.accepted,true);
  assert.equal(audits.length,1,'concurrent duplicate must persist its audit');assert.equal(audits[0][4],'CALLBACK_DUPLICATE');assert.equal(audits[0][6],'C');assert.equal(audits[0][7],'rejected','rejected event remains rejected in its duplicate audit');
 }}finally{Object.assign(pool,original);}
});
test('immutable recovery restores exact original bytes and refuses digest or identity tampering',async()=>{
 const {restoreSnapshot,validatePushIdentity}=await import('../src/services/dispatchPushService');
 const {serializeOnce}=await import('../src/clients/publicUtilityClient');const {env}=await import('../src/config/env');
 Object.assign(env.pu,{appCode:'gqxq'});
 const payload={sourceAppCode:'gqxq',sourceBusinessId:'C',requestId:'R',enterpriseSubjects:[{subjectCode:'E'}],metadata:{contractVersion:2,assignmentId:'A'}};
 const serialized=serializeOnce(payload);const restored=restoreSnapshot(serialized.bodyText,serialized.bodySha256);
 assert.equal(restored.bodyText,serialized.bodyText);assert.deepEqual(restored.bodyBytes,serialized.bodyBytes);validatePushIdentity(restored,'A','C','R','E');
 assert.throws(()=>restoreSnapshot(serialized.bodyText,'corrupted'),/digest mismatch/);
 for(const [assignmentId,complaintId,requestId,enterprise] of [['OTHER','C','R','E'],['A','OTHER','R','E'],['A','C','OTHER','E'],['A','C','R','OTHER']])assert.throws(()=>validatePushIdentity(restored,assignmentId,complaintId,requestId,enterprise),/identity mismatch/);
 // Fresh readiness, legacy recovery and byte-preserving worker behavior now have actual SQL
 // coverage in push-job-mysql-component.test.ts; this pure test cannot authorize anonymous pushes.
});
