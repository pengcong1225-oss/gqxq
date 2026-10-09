// Actual child-process crash/reopen against the guarded C4 schema; all HTTP is fake.
import assert from 'node:assert/strict';
async function main(){
assert.equal(process.env.GQXQ_C4_COMPONENT_DB,'gqxq_c4_contract_test');assert.equal(process.env.GQXQ_DB_NAME,'gqxq_c4_contract_test');assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');
const {pool}=await import('../../src/db/pool');const [identity]=await pool.query('select database() as db') as [Array<{db:string}>,unknown];assert.equal(identity[0].db,'gqxq_c4_contract_test');
const [mode,requestId]=process.argv.slice(2);assert.ok(requestId.startsWith('RPROCESS'));
if(mode==='crash-before-send'){const {claimOutbox}=await import('../../src/repositories/dispatchOutboxRepo');assert.ok(await claimOutbox(requestId,60000));process.exit(23);}
const {lowercaseHexSha256}=await import('../../src/clients/publicUtilityClient');
globalThis.fetch=async(url,init)=>{
 assert.equal(String(url),'http://127.0.0.1:1/api/integrations/gqxq/tasks');
 const bytes=Buffer.from(init!.body as Uint8Array);const payload=JSON.parse(bytes.toString());assert.equal(payload.requestId,requestId);const hash=lowercaseHexSha256(bytes);
 const headers=init!.headers as Record<string,string>;assert.ok(headers['X-PU-Nonce']);assert.ok(headers['X-PU-Signature']);
 await pool.execute('insert into c4_fake_provider(request_id,payload_hash,task_id,calls) values(?,?,?,1) on duplicate key update calls=calls+1',[requestId,hash,'TASK-'+requestId]);
 const [tasks]=await pool.query('select payload_hash,task_id from c4_fake_provider where request_id=?',[requestId]) as [Array<{payload_hash:string;task_id:string}>,unknown];assert.equal(tasks[0].payload_hash,hash);
 if(mode==='crash-after-send')process.exit(23);
 return new Response(JSON.stringify({created:true,task:{id:tasks[0].task_id}}),{status:200});
};
const {recoverDispatch}=await import('../../src/services/dispatchRecoveryService');
try{const result=await recoverDispatch(requestId);console.log('C4_FRESH_PROCESS_RESULT='+result.state);}finally{await pool.end();}
}
void main().catch(()=>{console.error('C4 worker fixture failed');process.exitCode=1;});
