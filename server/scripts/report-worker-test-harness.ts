/** Narrow synthetic restart harness. Never starts application/provider workers. */
import assert from 'node:assert/strict';
import {pool} from '../src/db/pool';
import {claimReport} from '../src/repositories/reportRepo';
import {generateReport} from '../src/services/reportService';
async function main(){
 assert.equal(process.env.GQXQ_D3_COMPONENT_DB,'gqxq_d3_contract_test');
 assert.equal(process.env.GQXQ_DB_NAME,'gqxq_d3_contract_test');
 assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');
 assert.equal(process.env.GQXQ_DB_PORT,'3306');
 const [rows]=await pool.query('select database() as db');assert.equal((rows as any)[0].db,'gqxq_d3_contract_test');
 const [id,mode]=process.argv.slice(2);assert.match(id,/^RPT-[0-9a-f-]{36}$/);
 if(mode==='claim-hang'){
  const c=await pool.getConnection();try{await c.beginTransaction();const claim=await claimReport(c,id,1000);assert.ok(claim);await c.commit();process.send?.({event:'claimed',reportId:id,fence:claim.fence});}catch(e){await c.rollback();throw e;}finally{c.release();}
  setInterval(()=>{},1000);return;
 }
 assert.equal(mode,'generate');await generateReport(id);await pool.end();
}
main().catch(async e=>{console.error(e instanceof Error?e.message:'report harness failed');await pool.end();process.exitCode=1;});
