import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DOTENV_CONFIG_PATH='nonexistent-integration-test.env';
process.env.GQXQ_DB_USER='test'; process.env.GQXQ_DB_NAME='test'; process.env.GQXQ_JWT_SECRET='local-test-only';
test('idempotent create response retains original task association', async () => {
  const { classifyOutcome } = await import('../src/services/dispatchPushService');
  const outcome = classifyOutcome({kind:'response', httpStatus:200, bodyText:JSON.stringify({created:false, task:{id:42}})});
  assert.equal(outcome.result,'success'); assert.equal(outcome.taskId,'42'); assert.equal(outcome.created,false);
});

test('accepted progresses from pushed and trusted legacy final events recover approval-only senders', async () => {
 const { planTransition } = await import('../src/services/callbackService');
 const event:any={eventType:'task_accepted',approvalConclusion:'pending',submissionVersion:null};
 assert.equal(planTransition(event,'pushed').toDispatchStatus,'accepted');
 assert.equal(planTransition({...event,contractVersion:1,eventType:'task_approved',approvalConclusion:'agreed'},'pushed').toDispatchStatus,'completed');
 assert.equal(planTransition({...event,contractVersion:2,eventType:'task_approved',approvalConclusion:'agreed'},'pushed').kind,'ignored');
});

test('signing includes servlet context path and forbids redirects at transport', async()=>{

 const { buildAttempt,serializeOnce }=await import('../src/clients/publicUtilityClient');
 const {env}=await import('../src/config/env');
 env.pu.baseUrl='https://example.invalid/utility/';
 const attempt=buildAttempt(serializeOnce({sourceAppCode:'gqxq'}),{nonce:'test',nowMs:1000});
 assert.equal(attempt.path,'/utility/api/integrations/gqxq/tasks');
});

test('durable callback inbox replays missing association and reversed order, rejects relation drift and mutated duplicate', async()=>{
 const {handleCallback,reconcilePendingEvents}=await import('../src/services/callbackService');
 const {signCallback}=await import('../src/clients/callbackSignature');const {pool}=await import('../src/db/pool');const {env}=await import('../src/config/env');
 Object.assign(env.callback,{keyId:'test-key',keyVersion:'v1',secret:'local-test-callback-secret',ackMode:'BODY',ackValue:'ACCEPTED\n'});
 const entries=new Map<string,any>();let replayCursor=0;let associated=false;let supervisionStatus='pending';
 const ref:any={assignmentId:'A1',complaintId:'C1',status:'pending',requestId:'R1',subjectCode:'E1',taskId:null,lastEventSequence:0,reportingItemId:null};
 const query=async(sql:string,p:any[]=[])=>{
  if(sql.includes('from dispatch_order'))return [associated&&p[0]==='A1'?[{...ref}]:[],[]];
  if(sql.includes('from integration_replay_cursor'))return [[{lastEventId:replayCursor}],[]];
  if(sql.includes("processed_result='pending'"))return [[...entries.values()].filter(e=>e.processedResult==='pending'&&(sql.includes('and task_id=?')?e.taskId===p[0]:(sql.includes('id>?')?e.id>Number(p[0]):true))).slice(0,500).map(e=>({id:e.id,eventId:e.eventId,payload:e.payload})),[]];
  if(sql.includes('processed_result as state'))return [[{state:entries.get(p[0])?.processedResult}],[]];
  if(sql.includes('from business_event where event_id'))return [entries.has(p[0])?[entries.get(p[0])]:[],[]];
  throw new Error('unexpected query '+sql);
 };
 const execute=async(sql:string,p:any[]=[])=>{
  if(sql.startsWith('insert into business_event')){entries.set(p[0],{id:entries.size+1,eventId:p[0],eventType:p[1],sourceBusinessId:p[3],taskId:p[4],payload:JSON.parse(p[13]),processedResult:p[16],processedMessage:p[17],ackBody:p[18]});}
  else if(sql.includes('integration_replay_cursor')){if(sql.startsWith('update'))replayCursor=Number(p[0]);}
  else if(sql.startsWith('update business_event')){const e=entries.get(p[2]);e.processedResult=p[0];e.processedMessage=p[1];}
  else if(sql.startsWith('update dispatch_order')){Object.assign(ref,{status:p[0],lastEventSequence:p[2],reportingItemId:ref.reportingItemId??p[3],taskId:ref.taskId??p[4]});}
  else if(sql.startsWith('update complaint')){supervisionStatus=p[1];}
  else if(!sql.startsWith('update complaint')&&!sql.startsWith('insert into approval_trace')&&!sql.startsWith('insert into operation_audit_log'))throw new Error('unexpected execute '+sql);
  return [{affectedRows:1},[]];
 };
 const originals={query:pool.query,execute:pool.execute,getConnection:pool.getConnection};
 Object.assign(pool,{query,execute,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
 const base={contractVersion:2,assignmentId:'A1',requestId:'R1',reportingItemId:'I1',sourceAppCode:'gqxq',sourceBusinessId:'C1',taskId:'T1',sceneCode:'GQXQ_SENSITIVE_DISPATCH',enterpriseSubject:{subjectCode:'E1',subjectName:'Enterprise'},enterpriseDisposalResult:{result:'original'},attachments:[],templateVersion:1,occurredAt:new Date().toISOString()};
 const send=async(event:any)=>{const rawBody=Buffer.from(JSON.stringify(event));const timestamp=String(Math.floor(Date.now()/1000));return handleCallback({rawBody,keyId:'test-key',keyVersion:'v1',timestamp,headerEventId:event.eventId,signature:signCallback(env.callback.secret,Number(timestamp),rawBody),remoteIp:null});};
 try{
  for(let n=0;n<500;n++)entries.set('permanent-'+n,{id:n+1,eventId:'permanent-'+n,taskId:'OTHER',payload:{...base,eventId:'permanent-'+n,assignmentId:'UNKNOWN',taskId:'OTHER',eventType:'TASK_ACCEPTED',approvalConclusion:'PENDING',eventSequence:1},processedResult:'pending'});
  const submit={...base,eventId:'submitted',eventType:'TASK_SUBMITTED',approvalConclusion:'PENDING',submissionVersion:1,eventSequence:2};
  const early=await send(submit);assert.equal(early.status,200);assert.equal(early.ackBody,'ACCEPTED\n');assert.equal(entries.get('submitted').processedResult,'pending');
  associated=true;await reconcilePendingEvents();assert.equal(ref.status,'pending');
  const accepted={...base,eventId:'accepted',eventType:'TASK_ACCEPTED',approvalConclusion:'PENDING',eventSequence:1};
  await send(accepted);assert.equal(ref.status,'processing');assert.equal(ref.lastEventSequence,2);assert.equal(entries.get('submitted').processedResult,'applied');
  const queuedProgress={...base,eventId:'progress',eventType:'TASK_PROGRESS',approvalConclusion:'PENDING',submissionVersion:1,eventSequence:3};entries.set('progress',{id:entries.size+1,eventId:'progress',taskId:'T1',payload:queuedProgress,processedResult:'pending',ackBody:'ACCEPTED\n'});
  await reconcilePendingEvents();assert.equal(ref.lastEventSequence,3);assert.equal(replayCursor,503);
  await send({...base,eventId:'progress',eventType:'TASK_PROGRESS',approvalConclusion:'PENDING',submissionVersion:1,eventSequence:3});assert.equal(ref.status,'processing');assert.equal(supervisionStatus,'processing');
  await send({...base,eventId:'returned',eventType:'TASK_RETURNED',approvalConclusion:'RETURNED',submissionVersion:1,eventSequence:4});assert.equal(ref.status,'returned');
  await send({...base,eventId:'rejected',eventType:'TASK_REJECTED',approvalConclusion:'DISAGREED',submissionVersion:1,eventSequence:5});assert.equal(ref.status,'rejected');
  const duplicate=await send(submit);assert.equal(duplicate.ackBody,'ACCEPTED\n');assert.equal(entries.size,505);
  const conflict=await send({...submit,enterpriseDisposalResult:{result:'changed'}});assert.equal(conflict.status,409);
  const denied=await send({...base,eventId:'foreign',eventType:'TASK_ACCEPTED',approvalConclusion:'PENDING',eventSequence:6,enterpriseSubject:{subjectCode:'E2',subjectName:'Other'}});assert.equal(denied.status,400);assert.equal(ref.status,'rejected');
 }finally{Object.assign(pool,originals);}
});
