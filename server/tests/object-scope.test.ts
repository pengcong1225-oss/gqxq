import assert from 'node:assert/strict';
import test, { before } from 'node:test';
process.env.GQXQ_DB_HOST='127.0.0.1';process.env.GQXQ_DB_PORT='1';process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_PASSWORD='synthetic';process.env.GQXQ_DB_NAME='synthetic';process.env.GQXQ_JWT_SECRET='synthetic_scope_secret_32_characters';
let api:any={};before(async()=>{try{api=await import('../src/auth/accessScope');}catch{}});
const ctx={userId:'u',roles:['admin'],scopeVersion:1,canReadSource:false,rules:[{kind:'restricted',enterpriseCodes:['A'],districtCodes:['G1']},{kind:'restricted',enterpriseCodes:['B'],districtCodes:['G2']}]};
test('Q1 preserves paired enterprise/district intersection and rule union',()=>{
 assert.equal(typeof api.canAccessComplaint,'function');
 for(const [e,d,allow] of [['A','G1',true],['B','G2',true],['A','G2',false],['B','G1',false]])assert.equal(api.canAccessComplaint(ctx,{enterprise_code:e,district_code:d}),allow);
 assert.equal(api.canAccessComplaint({...ctx,rules:[]},{}),false);
 assert.equal(api.canAccessComplaint({...ctx,rules:[{kind:'restricted',enterpriseCodes:[],districtCodes:[]}]},{}),false);
 assert.equal(api.canAccessComplaint({...ctx,rules:[{kind:'restricted',enterpriseCodes:['A'],districtCodes:[]}]},{enterprise_code:'A',district_code:'G2'}),true);
 assert.equal(api.canAccessComplaint({...ctx,rules:[{kind:'restricted',enterpriseCodes:[],districtCodes:['G1']}]},{enterprise_code:'B',district_code:'G1'}),true);
 assert.equal(api.canAccessComplaint({...ctx,rules:[{kind:'all'}]},{deleted:1}),false);
});

test('scope change after fake transport prevents local request-log and status writes',async()=>{
 const {pool}=await import('../src/db/pool');const {env}=await import('../src/config/env');
 const {serializeOnce}=await import('../src/clients/publicUtilityClient');const {pushDispatch}=await import('../src/services/dispatchPushService');
 const original={query:pool.query,execute:pool.execute,getConnection:pool.getConnection,fetch:globalThis.fetch,pu:{...env.pu}};
 Object.assign(env.pu,{baseUrl:'https://example.invalid',appCode:'gqxq',keyId:'synthetic',keyVersion:'v1',secret:'synthetic'});
 const body=serializeOnce({sourceAppCode:'gqxq',sourceBusinessId:'C1',requestId:'R1',metadata:{contractVersion:2,assignmentId:'D1'}});
 let district='G1',sent=0,writes=0;
 const query=async(sql:string)=>{
  if(sql.includes('dispatch_push_snapshot'))return [[{body:body.bodyText,sha256:body.bodySha256}],[]];
  if(sql.includes('dispatch_request_log'))return [[],[]];
  if(sql.includes('from complaint'))return [[{enterprise_code:'A',district_code:district,deleted:0}],[]];
  return [[{assignment_id:'D1',complaint_id:'C1',request_id:'R1',status:'pending'}],[]];
 };
 const execute=async()=>{writes++;return [{affectedRows:1},[]];};
 Object.assign(pool,{query,execute,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
 globalThis.fetch=async()=>{sent++;district='G2';return new Response(JSON.stringify({code:'CONFLICT',message:'synthetic'}),{status:409});};
 try{await assert.rejects(api.runWithAccessContext(ctx,()=>pushDispatch('D1',{userId:'u',userName:null,clientIp:null})),{status:404});assert.equal(sent,1);assert.equal(writes,0);}
 finally{Object.assign(pool,{query:original.query,execute:original.execute,getConnection:original.getConnection});globalThis.fetch=original.fetch;Object.assign(env.pu,original.pu);}
});
test('scope SQL binds values, validates alias and denies missing context',()=>{
 assert.equal(typeof api.buildComplaintScopeSql,'function');
 const s=api.buildComplaintScopeSql(ctx,'c');assert.deepEqual(s.params,['A','G1','B','G2']);assert.match(s.sql,/enterprise_code in \(\?\).*district_code in \(\?\)/);
 assert.throws(()=>api.buildComplaintScopeSql(ctx,'c; drop table complaint'));
 assert.equal(api.canAccessComplaint(api.currentAccessContext(),{}),false);
});
test('interleaved request contexts do not share authorization',async()=>{
 assert.equal(typeof api.runWithAccessContext,'function');
 const values=await Promise.all(['a','b'].map(userId=>api.runWithAccessContext({...ctx,userId},async()=>{await new Promise(r=>setTimeout(r,userId==='a'?10:1));return api.currentAccessContext().userId;})));
 assert.deepEqual(values,['a','b']);assert.equal(api.currentAccessContext().rules.length,0);
});

test('push failure mutation rechecks the locked current complaint',async()=>{
 const {pool}=await import('../src/db/pool');
 const {recordPushFailure}=await import('../src/services/dispatchService');
 const originalExecute=pool.execute,originalConnection=pool.getConnection;
 let writes=0;
 const fake={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},
  query:async(sql:string)=>sql.includes('from complaint')?[[{complaint_id:'C1',enterprise_code:'A',district_code:'G2',deleted:0}],[]]:[[{complaint_id:'C1',status:'pending'}],[]],
  execute:async()=>{writes++;return [{affectedRows:1},[]];}};
 (pool as any).execute=fake.execute;(pool as any).getConnection=async()=>fake;
 try{await assert.rejects(api.runWithAccessContext(ctx,()=>recordPushFailure('D1','C1',{result:'business_error',httpStatus:400,errorCode:'E',message:'failed',attempt:1},{userId:'u',userName:null,clientIp:null})),(e:any)=>e.status===404 || e.statusCode===404);assert.equal(writes,0);}
 finally{pool.execute=originalExecute;pool.getConnection=originalConnection;}
});
