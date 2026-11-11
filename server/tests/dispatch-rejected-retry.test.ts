import test from 'node:test';
import assert from 'node:assert/strict';
process.env.GQXQ_DB_USER ||= 'isolated-unit';process.env.GQXQ_DB_NAME ||= 'isolated-unit';process.env.GQXQ_JWT_SECRET ||= 'isolated-unit-key';
test('explicit definite rejection retry preserves original identity and accumulated attempts',async()=>{
 const {requeueRejectedInTx}=await import('../src/repositories/dispatchOutboxRepo');
 const original={state:'failed',has_unknown:0,task_id:null,transport_identity:'same-target',last_http_status:409,payload_hash:'original-hash',request_id:'original-request',assignment_id:'original-assignment',complaint_id:'original-complaint',attempts:2} as import('../src/repositories/dispatchOutboxRepo').OutboxRow;
 const calls:Array<{sql:string;args:unknown[]}> = [];
 const tx={execute:async(sql:string,args:unknown[])=>{calls.push({sql,args});return [{affectedRows:1},[]];}} as unknown as import('../src/db/tx').Tx;
 const result=await requeueRejectedInTx(tx,original,'same-target','original-hash',true);
 assert.equal(result.state,'pending');assert.equal(result.attempts,2);
 for(const key of ['request_id','assignment_id','complaint_id','payload_hash','transport_identity'] as const)assert.equal(result[key],original[key]);
 assert.equal(calls.length,1);assert.match(calls[0].sql,/has_unknown=0 and payload_hash=\? and transport_identity=\?/);
 assert.equal(original.state,'failed');
});
test('ambiguous outcomes, changed target, changed snapshot or absent fresh preflight cannot requeue',async()=>{
 const {requeueRejectedInTx}=await import('../src/repositories/dispatchOutboxRepo');
 const original={state:'failed',has_unknown:0,task_id:null,transport_identity:'same-target',last_http_status:409,payload_hash:'original-hash',request_id:'request'} as import('../src/repositories/dispatchOutboxRepo').OutboxRow;
 const tx={execute:async()=>{throw Error('unsafe retry must never write');}} as unknown as import('../src/db/tx').Tx;
 for(const row of [{...original,state:'unknown'},{...original,has_unknown:1},{...original,last_http_status:500},{...original,last_http_status:null},...[408,425,429].map(status=>({...original,last_http_status:status})),{...original,task_id:'already-bound'}])
  assert.equal((await requeueRejectedInTx(tx,row as typeof original,'same-target','original-hash',true)).state,row.state);
 assert.equal((await requeueRejectedInTx(tx,original,'changed-target','original-hash',true)).state,'failed');
 assert.equal((await requeueRejectedInTx(tx,original,'same-target','changed-hash',true)).state,'failed');
 assert.equal((await requeueRejectedInTx(tx,original,'same-target','original-hash',false)).state,'failed');
});
