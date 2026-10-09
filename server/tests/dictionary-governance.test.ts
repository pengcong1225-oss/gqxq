import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
process.env.DOTENV_CONFIG_PATH='nonexistent-b1.env';process.env.GQXQ_DB_PORT='1';process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_NAME='synthetic';process.env.GQXQ_DB_PASSWORD='synthetic';process.env.GQXQ_JWT_SECRET='synthetic-b1-secret';
test('dictionary governance rejects state enum writes and invalid hierarchy',async()=>{
 assert.ok(existsSync(new URL('../src/services/dictService.ts',import.meta.url)), 'governed dictionary service exists');
 const {assertMutableType,validateItemHierarchy}=await import('../src/services/dictService');
 for(const code of ['status','correction_status','supervision_status','reporting_status','source_event_status'])assert.throws(()=>assertMutableType(code),/状态/);
 assert.doesNotThrow(()=>assertMutableType('complaint_category'));
 const rows=[{code:'fee',parentCode:null,status:'enabled'},{code:'price',parentCode:'fee',status:'enabled'},{code:'off',parentCode:null,status:'disabled'}];
 assert.throws(()=>validateItemHierarchy({code:'fee',parentCode:'price',status:'enabled'},rows),/环|两级/);
 assert.throws(()=>validateItemHierarchy({code:'x',parentCode:'missing',status:'enabled'},rows),/父/);
 assert.throws(()=>validateItemHierarchy({code:'x',parentCode:'off',status:'enabled'},rows),/停用/);
});
test('all-disabled choices do not resurrect enums and observed sources carry scope SQL',async()=>{
 const {pool,closePool}=await import('../src/db/pool');const original=pool.query;
 const {findDictItems}=await import('../src/repositories/dictRepo');const {runWithAccessContext}=await import('../src/auth/accessScope');
 const calls:{sql:string;params:unknown[]}[]=[];
 (pool as any).query=async(sql:string,params:unknown[]=[])=>{calls.push({sql,params});return [sql.includes('from dict_type')?[{dict_type:'complaint_type',status:'enabled'}]:[],[]];};
 try{
  assert.deepEqual(await findDictItems('complaint_type'),[],'registered empty dictionary stays empty');
  (pool as any).query=async(sql:string,params:unknown[]=[])=>{calls.push({sql,params});return [[],[]];};
  await runWithAccessContext({userId:'u',roles:[],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false},()=>findDictItems('source_system'));
  const observed=calls.find(v=>v.sql.includes('distinct c.source_system'))!;assert.ok(observed);assert.match(observed.sql,/c.enterprise_code in/);assert.deepEqual(observed.params,['E1']);
 }finally{pool.query=original;await closePool();}
});
