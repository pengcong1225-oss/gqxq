import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import ExcelJS from 'exceljs';

// This suite only runs against the explicitly owned synthetic schema.
test('complaint Excel batch contract in real MySQL',{skip:process.env.COMPLAINT_IMPORT_DB_TEST!=='1'},async t=>{
 assert.equal(process.env.GQXQ_DB_NAME,'gqxq_complaint_import_test_20261010');
 assert.equal(existsSync(new URL('../src/services/complaintImportService.ts',import.meta.url)),true,'batch service must exist');
 const {pool}=await import('../src/db/pool');
 const {complaintImportService:service}=await import('../src/services/complaintImportService');
 const {runWithAccessContext}=await import('../src/auth/accessScope');
 const prefix='CI-'+Date.now();
 const user=prefix+'-user',other=prefix+'-other';
 const access={userId:user,roles:['admin'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:true};
 const ctx={userId:user,userName:'Import test',clientIp:'127.0.0.1',permissionCodes:['complaint.import','complaint.read'],access,sessionVersion:1};
 const book=async(rows:{id:string;content?:string;business?:string}[])=>{const w=new ExcelJS.Workbook();const s=w.addWorksheet('Sheet0');s.addRow(['综合查询']);s.addRow(['案件公文号','诉求类型','来话内容','录入时间','案件主类型名','案件二级类型名','区','详细地址','处理结果']);for(const r of rows)s.addRow([r.id,'投诉类',r.content??'虚构供水问题','2026-10-09 10:00:00','市政公用',r.business??'供水服务','西陵区','虚构地址','来源已处理']);return {name:'fixture.xlsx',bytes:Buffer.from(await w.xlsx.writeBuffer())};};
 const preview=async(rows:Parameters<typeof book>[0])=>runWithAccessContext(access,()=>book(rows).then(f=>service.preview(f,ctx)));
 const confirm=(id:string,key='request-'+id)=>runWithAccessContext(access,()=>service.commit(id,key,ctx));
 try{
  for(const id of [user,other])await pool.execute('insert into app_user(user_id,username,password_hash,real_name,roles,permissions,status,created_at,updated_at,must_change_password,scope_rules,scope_version,account_type) values(?,?,?,?,?,?,1,now(),now(),0,?,1,?)',[id,id,'not-a-login-fixture','虚构导入测试','["admin"]','[]','[{"kind":"all"}]','internal']);
  await t.test('preview is read-only, last duplicate wins; confirmation persists facts and leaves platform workflow pending',async()=>{
   const p=await preview([{id:prefix+'-a',content:'先前行'},{id:prefix+'-b'},{id:prefix+'-a',content:'最后行'}]);assert.deepEqual(p.counts,{total:3,unique:2,duplicates:1,create:2,skip:0,error:0});assert.equal(p.canCommit,true);
   const [before]=await pool.query('select complaint_id from complaint where source_id like ?',[prefix+'%']);assert.equal((before as any[]).length,0);
   const r=await confirm(p.batchId);assert.equal(r.created,2);assert.equal(r.skipped,0);assert.deepEqual(await confirm(p.batchId),r);
   const [rows]=await pool.query('select content,enterprise_code,closed_in_system,source_event_status,status,source_payload from complaint where source_id=?',[prefix+'-a']);const row=(rows as any[])[0];assert.equal(row.content,'最后行');assert.equal(row.enterprise_code,null);assert.equal(row.closed_in_system,0);assert.equal(row.source_event_status,'unknown');assert.equal(row.status,'pending');assert.equal((typeof row.source_payload==='string'?JSON.parse(row.source_payload):row.source_payload).metadata['处理结果'],'来源已处理');
   await pool.execute('update complaint set title=?,edit_version=edit_version+1 where source_id=?',['人工更正标题',prefix+'-a']);const repeated=await preview([{id:prefix+'-a',content:'不能覆盖'}]);assert.equal(repeated.counts.skip,1);assert.equal((await confirm(repeated.batchId)).created,0);const [saved]=await pool.query('select title,content from complaint where source_id=?',[prefix+'-a']);assert.equal((saved as any[])[0].title,'人工更正标题');assert.equal((saved as any[])[0].content,'最后行');
  });
  await t.test('bad row blocks all records; batch details remain actionable',async()=>{const p=await preview([{id:prefix+'-good'},{id:prefix+'-bad',business:'未支持业务'}]);assert.equal(p.canCommit,false);assert.equal(p.counts.error,1);assert.equal((await service.get(p.batchId,ctx)).details.some(d=>d.errors.length>0),true);await assert.rejects(()=>confirm(p.batchId),{status:400});const [rows]=await pool.query('select complaint_id from complaint where source_id=?',[prefix+'-good']);assert.equal((rows as any[]).length,0);});
  await t.test('ownership, current scope, current grants and expiration fence stale previews',async()=>{
   const p=await preview([{id:prefix+'-scope'}]);await assert.rejects(()=>service.get(p.batchId,{...ctx,userId:other,access:{...access,userId:other}}),{status:404});
   await pool.execute('update app_user set scope_rules=?,scope_version=scope_version+1 where user_id=?',['[]',user]);await assert.rejects(()=>confirm(p.batchId),{status:403});await pool.execute('update app_user set scope_rules=? where user_id=?',['[{"kind":"all"}]',user]);
   await pool.execute('delete from platform_role_permission where role_code=? and permission_code=?',['admin','complaint.import']);try{await assert.rejects(()=>confirm(p.batchId),{status:403});}finally{await pool.execute('insert into platform_role_permission(role_code,permission_code) values(?,?)',['admin','complaint.import']);}
   await pool.execute('update complaint_import_batch set expires_at=date_sub(now(),interval 1 hour) where batch_id=?',[p.batchId]);await assert.rejects(()=>confirm(p.batchId),{status:409});
  });
  await t.test('concurrent confirmations of overlapping source keys create once',async()=>{const a=await preview([{id:prefix+'-race'}]),b=await preview([{id:prefix+'-race'}]);const results=await Promise.all([confirm(a.batchId),confirm(b.batchId)]);assert.equal(results.reduce((n,r)=>n+r.created,0),1);assert.equal(results.reduce((n,r)=>n+r.skipped,0),1);});
  await t.test('an injected real SQL failure rolls back all rows, logs and result; retry succeeds',async()=>{
   const p=await preview([{id:prefix+'-rollback-a'},{id:prefix+'-rollback-b'}]);
   await pool.query("create trigger complaint_import_test_failure before insert on complaint for each row begin if new.source_id='"+prefix+"-rollback-b' then signal sqlstate '45000' set message_text='synthetic rejection'; end if; end");
   try{await assert.rejects(()=>confirm(p.batchId));const [rows]=await pool.query('select complaint_id from complaint where source_id in (?,?)',[prefix+'-rollback-a',prefix+'-rollback-b']);assert.equal((rows as any[]).length,0);assert.equal((await service.get(p.batchId,ctx)).result,null);}finally{await pool.query('drop trigger complaint_import_test_failure');}
   assert.equal((await confirm(p.batchId)).created,2);
  });
  await t.test('password reset serializes with an authorized import and revoked sessions cannot stage',async()=>{
   const p=await preview([{id:prefix+'-password'}]);const conn=await pool.getConnection();const originalGet=pool.getConnection.bind(pool),originalQuery=conn.query.bind(conn);let ready!:()=>void,resume!:()=>void;const reached=new Promise<void>(r=>ready=r),continued=new Promise<void>(r=>resume=r);let resetFinished=false;
   (conn as any).query=async(sql:string,values?:unknown[])=>{const result=await originalQuery(sql,values);if(sql.startsWith('select must_change_password')){ready();await continued;}return result;};let first=true;pool.getConnection=async()=>first?(first=false,conn):originalGet();
   const importing=confirm(p.batchId);let reset:Promise<unknown>|undefined;
   try{await reached;reset=pool.execute('update app_user set must_change_password=1,session_version=session_version+1 where user_id=?',[user]).then(v=>{resetFinished=true;return v;});await new Promise(r=>setTimeout(r,40));assert.equal(resetFinished,false,'reset must wait for the live account share lock');}
   finally{resume();await importing;await reset;pool.getConnection=originalGet;}
   await pool.execute('update app_user set must_change_password=0 where user_id=?',[user]);try{await assert.rejects(()=>preview([{id:prefix+'-revoked-session'}]),{status:401});}finally{await pool.execute('update app_user set session_version=1 where user_id=?',[user]);}
  });
  await t.test('own recent batches retain results without revealing another owner',async()=>{const list=await service.list(ctx);assert.ok(list.some(b=>b.result?.created===2));assert.equal((await service.list({...ctx,userId:other,access:{...access,userId:other}})).length,0);});
 }finally{await pool.execute('update app_user set status=0,session_version=session_version+1 where user_id in (?,?)',[user,other]);await pool.end();}
});
