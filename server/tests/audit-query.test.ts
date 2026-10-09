import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DOTENV_CONFIG_PATH='missing-synthetic.env';
process.env.GQXQ_DB_HOST='127.0.0.1';process.env.GQXQ_DB_PORT='1';
process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_PASSWORD='synthetic';process.env.GQXQ_DB_NAME='synthetic';process.env.GQXQ_JWT_SECRET='synthetic-audit-secret';
const access={userId:'reader',roles:['auditor'],scopeVersion:1,rules:[],canReadSource:false,permissionCodes:['system.audit.read']};
async function service():Promise<any>{
 const mod=await import('../src/services/auditQueryService');
 assert.equal(typeof (mod as any).AuditQueryService,'function','A6 must provide a capability-checked query service');
 return mod;
}
test('query service denies missing capability before accessing SQL, including admin',async()=>{
 const {AuditQueryService}=await service();let calls=0;
 const svc=new AuditQueryService({query:async()=>{calls++;return [[],[]];}});
 for(const roles of [[],['admin']])await assert.rejects(()=>svc.list({}, {page:1,size:20},{...access,roles,permissionCodes:[]}),{status:403});
 assert.equal(calls,0);
});
test('safe login and account change projections preserve necessary evidence only',async()=>{
 const {projectAuditLog}=await service();
 const row={audit_id:'A',user_id:'U',resource_code:'auth',action:'LOGIN_FAILED',biz_type:'auth',biz_id:'virtual-user',result:'failure',created_at:new Date('2026-10-09T00:00:00Z'),detail:JSON.stringify({username:'virtual-user',reason:'bad_password',password:'SECRET',token:'SECRET',signature:'SECRET',payload:'SECRET'})};
 const login=projectAuditLog(row);assert.equal(login.category,'login');assert.equal(login.result,'failed');assert.equal(login.originalResult,'failure');assert.equal(login.detail.reason,'bad_password');assert.equal(JSON.stringify(login).includes('SECRET'),false);
 const role=projectAuditLog({...row,action:'USER_UPDATE',biz_type:'user',detail:{before:{roles:['handler'],status:1,password:'SECRET'},after:{roles:['auditor'],status:0,token:'SECRET'},changed:['roles','status'],raw:'SECRET'}});
 assert.deepEqual(role.detail.before,{roles:['handler'],status:1});assert.deepEqual(role.detail.after,{roles:['auditor'],status:0});assert.equal(JSON.stringify(role).includes('SECRET'),false);
});
test('business projection omits source fields and redacts disposal JSON aliases',async()=>{
 const {projectAuditLog}=await service();
 const row={audit_id:'A',action:'CORRECTION_CONFIRM',biz_type:'complaint',biz_id:'C',result:'success',detail:{fieldName:'disposal_result',oldValue:'{"result":"旧结果","token":"SECRET"}',newValue:'{"result":"新结果","payload":"SECRET"}',payload:'SECRET'}};
 const view=projectAuditLog(row);assert.equal(JSON.stringify(view).includes('SECRET'),false);assert.equal(view.detail.newValue,'{"result":"新结果"}');
 const unsafe=projectAuditLog({...row,detail:{fieldName:'source_payload',oldValue:'SECRET',newValue:'SECRET',basis:'SECRET',reason:'SECRET'}});assert.equal(JSON.stringify(unsafe).includes('SECRET'),false);
});
test('list count and detail reuse current scope and deterministic pagination',async()=>{
 const {AuditQueryService}=await service();const sqls:string[]=[];const values:any[][]=[];
 const svc=new AuditQueryService({query:async(sql:string,p:any[])=>{sqls.push(sql);values.push(p);return sql.includes('count(*)')?[[{total:0}],[]]:[[],[]];}});
 const ctx={...access,rules:[{kind:'restricted',enterpriseCodes:['E'],districtCodes:['G']}]};
 const result=await svc.list({category:'login',result:'failed',actor:'virtual-user',businessNo:'C',from:'2026-10-09T00:00:00Z'}, {page:2,size:5},ctx);
 assert.equal(result.total,0);assert.equal(result.page,2);assert.ok(sqls[1].includes('order by a.created_at desc, a.id desc'));assert.deepEqual(values[1].slice(-2),[5,5]);
 assert.ok(sqls.every(s=>s.includes('coalesce(c.deleted, 0) = 0')));assert.ok(values.every(p=>p.includes('E')&&p.includes('G')));
 await assert.rejects(()=>svc.detail('A',ctx),{status:404});assert.ok(sqls[2].includes('coalesce(c.deleted, 0) = 0'));
});
test('query validation rejects malformed times, reversed intervals and unstable pagination',async()=>{
 const {AuditQueryService}=await service();const svc=new AuditQueryService({query:async()=>{throw Error('must reject before SQL');}});
 for(const filter of [{from:'bad'},{from:'2026-10-10T00:00:00Z',to:'2026-10-09T00:00:00Z'},{category:'bad'}])await assert.rejects(()=>svc.list(filter,{page:1,size:20},access),{status:400});
 for(const page of [0,1.2,Number.MAX_SAFE_INTEGER])await assert.rejects(()=>svc.list({}, {page,size:100},access),{status:400});
});
test('security rejection and dictionary rescan never reveal object URLs or full-domain counts',async()=>{
 const {projectAuditLog}=await service();
 const security=projectAuditLog({audit_id:'A',biz_type:'http',action:'ACCESS_DENIED',biz_id:'GET /complaints/FOREIGN_SECRET',detail:{path:'/complaints/FOREIGN_SECRET',targetId:'FOREIGN_SECRET',reason:'denied FOREIGN_SECRET',requestId:'req-1'}});
 assert.equal(security.bizId,null);assert.equal(security.businessNo,null);assert.equal(JSON.stringify(security).includes('FOREIGN_SECRET'),false);assert.equal(security.detail.reasonCode,'MISSING_PERMISSION');
 const rescan=projectAuditLog({audit_id:'B',biz_type:'sensitive_word',action:'SENSITIVE_WORD_RESCAN',biz_id:'DATASET_SECRET',detail:{total:900,updated:400,complaintIds:['FOREIGN_SECRET'],datasetFingerprint:'DATASET_SECRET',previewTokenId:'TOKEN_SECRET'}});
 assert.deepEqual(rescan.detail,{});assert.equal(rescan.bizId,null);assert.equal(JSON.stringify(rescan).includes('SECRET'),false);
});
