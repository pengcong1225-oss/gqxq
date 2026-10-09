import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import knexFactory from 'knex';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {builtinPermissionCodes, isAllowed, ROLE_POLICY} from '../src/auth/rolePolicy';

const enabled = process.env.GQXQ_A5_COMPONENT_DB === 'gqxq_a5_contract_test';
const require = createRequire(import.meta.url);

test('A5 isolated MySQL account component (not canonical baseline acceptance)', {skip:!enabled}, async t => {
  assert.equal(process.env.GQXQ_DB_NAME,'gqxq_a5_contract_test','Only explicitly named isolated A5 database may be used');
  const db=knexFactory({client:'mysql2',connection:{host:process.env.GQXQ_DB_HOST,port:Number(process.env.GQXQ_DB_PORT),
    user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD,database:'gqxq_a5_contract_test',timezone:'+08:00'}});
  // Minimal account schema copied from 20260917100100__m1_g1_new_tables.js.
  // No M0 bypass, no fabricated nineteen-table baseline. Audit table is a test
  // fixture defined from auditLogRepo's explicit columns, not production DDL.
  const tables=['platform_role_permission','platform_permission','platform_role','platform_authorization_state','operation_audit_log','app_user','number_sequence'];
  for(const table of tables) await db.schema.dropTableIfExists(table);
  await db.raw("create table app_user (id bigint primary key auto_increment,user_id varchar(64) not null unique,username varchar(64) not null unique,password_hash varchar(100) not null,real_name varchar(64) not null,roles json not null,permissions json not null,status tinyint not null default 1,last_login_at datetime,created_at datetime not null default current_timestamp,updated_at datetime not null default current_timestamp on update current_timestamp) engine=InnoDB default charset=utf8mb4");
  await db.raw('create table number_sequence (seq_key varchar(64) not null,biz_date date not null,current_value bigint not null default 0,primary key(seq_key,biz_date)) engine=InnoDB');
  await db.raw('create table operation_audit_log (audit_id varchar(64) primary key,user_id varchar(64),app_code varchar(64),resource_code varchar(128),action varchar(64),biz_type varchar(64),biz_id varchar(128),result varchar(32),client_ip varchar(64),detail json,created_at datetime) engine=InnoDB');
  try { await require('../migrations/20261009030000__account_role_permissions.js').up(db); } catch(err) { await db.destroy(); throw new Error('A5 fixture migration failed: '+String((err as {code?:string}).code??'unknown')); }
  const {createApp}=await import('../src/app');const {closePool,pool}=await import('../src/db/pool');
  const roles=await import('../src/services/roleService');const users=await import('../src/services/userService');
  const passwords=await import('../src/services/passwordService');
  const app=createApp();const ctx={userId:'admin-a',userName:'admin-a',clientIp:'127.0.0.1'};
  const initial='Synthetic-Initial-1';const fresh='Synthetic-Changed-2';
  const addUser=async(id:string,role:string|null,forced=false)=>{
    await db('app_user').insert({user_id:id,username:id,password_hash:await bcrypt.hash(initial,10),real_name:'虚构测试账号',roles:JSON.stringify(role?[role]:[]),permissions:'[]',status:1,must_change_password:forced?1:0,session_version:1});
  };
  await addUser('admin-a','admin');await addUser('admin-b','admin');await addUser('viewer','readonly',true);await addUser('pending',null);
  const login=async(username:string,password=initial)=>{const res=await request(app).post('/api/v1/auth/login').send({username,password});assert.equal(res.status,200);return res.body.data.token as string;};
  const token=await login('admin-a');
  try {
    await t.test('seeded grants reproduce old three-tier endpoint matrix',async()=>{
      for(const code of ['admin','handler','readonly']) {
        const role=(await roles.getRoles()).find(r=>r.roleCode===code)!;
        if(code!=='admin') assert.deepEqual(role.permissionCodes.slice().sort(),builtinPermissionCodes(code).slice().sort());
        for(const rule of ROLE_POLICY){
          if(rule.selfService)continue;
          const path=rule.path.source.replace(/^\^|\$$/g,'').replace(/\[\^\/\]\+/g,'synthetic').replace(/\\\//g,'/');
          const oldAllowed=code==='admin'||(rule.roles.includes(code as any)&&(code!=='readonly'||rule.method==='GET'));
          assert.equal(isAllowed({id:'u',username:'u',roles:[code],permissionCodes:role.permissionCodes},rule.method,path).allowed,oldAllowed,rule.desc+' '+code);
        }
      }
    });
    await t.test('create/copy/update persistence, versions, unknown and protected permissions',async()=>{
      const r=await request(app).post('/api/v1/roles').set('Authorization','Bearer '+token).send({roleCode:'analyst',name:'分析员',permissionCodes:['complaint.read'],expectedVersion:0});
      assert.equal(r.status,200);
      await addUser('analyst-user','analyst');
      const first=await roles.resolveAuthorization('analyst-user');assert.deepEqual(first.permissionCodes,['complaint.read']);
      const copied=await roles.writeRole('analyst-copy',{name:'复制角色',copyFrom:'analyst',expectedVersion:0},true,ctx);assert.deepEqual(copied.permissionCodes,['complaint.read']);
      const updated=await roles.writeRole('analyst',{name:'新名称',description:'新说明',permissionCodes:['analysis.read'],expectedVersion:1},false,ctx);assert.equal(updated.version,2);
      await require('../migrations/20261009030000__account_role_permissions.js').up(db);
      assert.equal((await roles.getRoles()).find(r=>r.roleCode==='analyst')!.name,'新名称');
      assert.ok((await roles.resolveAuthorization('analyst-user')).authorizationVersion>first.authorizationVersion);
      await assert.rejects(roles.writeRole('analyst',{name:'过期',expectedVersion:1},false,ctx),{status:409});
      for(const permission of ['invented.write','*']) await assert.rejects(roles.writeRole('unknown-'+permission.replace(/\W/g,''),{name:'无效',permissionCodes:[permission],expectedVersion:0},true,ctx),{status:400});
      for(const permission of ['system.users.manage','system.roles.manage']) await assert.rejects(roles.writeRole('privileged',{name:'无效',permissionCodes:[permission],expectedVersion:0},true,ctx),{status:403});
      await assert.rejects(roles.writeRole('clone-admin',{name:'无效',copyFrom:'admin',expectedVersion:0},true,ctx),{status:403});
      await assert.rejects(roles.writeRole('admin',{name:'管理员',enabled:false,expectedVersion:1},false,ctx),{status:403});
    });
    await t.test('direct hidden API denied and current authorization refreshes old token after role changes',async()=>{
      const analystToken=await login('analyst-user');
      const denied=await request(app).post('/api/v1/users').set('Authorization','Bearer '+analystToken).send({});assert.equal(denied.status,403);
      await roles.writeRole('analyst',{name:'停用',enabled:false,expectedVersion:2},false,ctx);
      const info=await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+analystToken);assert.equal(info.status,200);assert.deepEqual(info.body.data.roles,[]);assert.deepEqual(info.body.data.permissions,[]);
      assert.equal((await request(app).get('/api/v1/analysis/records').set('Authorization','Bearer '+analystToken)).status,403);
      const before=(await roles.resolveAuthorization('analyst-user')).authorizationVersion;
      await users.updateUserByAdmin('analyst-user',{role:'handler'},ctx);
      const next=await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+analystToken);assert.deepEqual(next.body.data.roles,['handler']);assert.ok(next.body.data.authorizationVersion>before);
      await assert.rejects(users.createUser({username:'badrole',realName:'测试',role:'analyst',password:initial},ctx),{status:400});
    });
    await t.test('forced readonly own-password change succeeds; old sessions invalidate and reset forces change',async()=>{
      const viewer=await login('viewer');
      assert.equal((await request(app).post('/api/v1/auth/change-password').set('Authorization','Bearer '+viewer).send({currentPassword:'Synthetic-Incorrect-3',newPassword:fresh})).status,400);
      assert.equal((await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+viewer)).status,200);
      assert.equal((await request(app).get('/api/v1/reports').set('Authorization','Bearer '+viewer)).status,403);
      assert.equal((await request(app).post('/api/v1/auth/change-password').set('Authorization','Bearer '+viewer).send({currentPassword:initial,newPassword:fresh})).status,200);
      assert.equal((await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+viewer)).status,401);
      const changed=await login('viewer',fresh);
      assert.equal((await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+changed)).body.data.mustChangePassword,false);
      assert.equal((await request(app).post('/api/v1/dispatch/orders').set('Authorization','Bearer '+changed).send({})).status,403);
      assert.equal((await request(app).post('/api/v1/users/viewer/reset-password').set('Authorization','Bearer '+token).send({password:initial})).status,200);
      assert.equal((await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+changed)).status,401);
      const reset=await login('viewer');assert.equal((await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+reset)).body.data.mustChangePassword,true);
      assert.equal((await request(app).post('/api/v1/users/viewer/reset-password').set('Authorization','Bearer '+token).send({password:'密'.repeat(25)})).status,400);
      const created=await request(app).post('/api/v1/users').set('Authorization','Bearer '+token).send({username:'local-new',realName:'虚构新用户',role:'handler',password:initial});
      assert.equal(created.status,200);assert.equal(created.body.data.mustChangePassword,true);assert.equal('password' in created.body.data,false);assert.equal('passwordHash' in created.body.data,false);
      const local=await login('local-new');assert.equal((await request(app).get('/api/v1/reports').set('Authorization','Bearer '+local)).status,403);
      const list=await request(app).get('/api/v1/users').set('Authorization','Bearer '+token);assert.equal(list.status,200);assert.equal(list.body.data.content.some((row:any)=>'passwordHash' in row||'password' in row),false);
      await users.updateUserByAdmin(created.body.data.userId,{status:0},ctx);
      assert.equal((await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+local)).status,401);
    });
    await t.test('pending identity receives no business grants and can use own identity service',async()=>{
      const pending=await login('pending');const info=await request(app).get('/api/v1/auth/user-info').set('Authorization','Bearer '+pending);
      assert.deepEqual(info.body.data.roles,[]);assert.deepEqual(info.body.data.permissions,[]);
      assert.equal((await request(app).get('/api/v1/reports').set('Authorization','Bearer '+pending)).status,403);
      assert.equal((await request(app).post('/api/v1/auth/change-password').set('Authorization','Bearer '+pending).send({currentPassword:initial,newPassword:fresh})).status,200);
    });
    await t.test('malformed legacy role JSON cannot manufacture administrator authorization',async()=>{
      try {
        const {countEnabledAdmins}=await import('../src/repositories/userRepo');
        const {pool}=await import('../src/db/pool');
        for(const malformed of ['admin',{role:'admin'},[],['admin','handler']]) {
          await db('app_user').where('user_id','pending').update({roles:JSON.stringify(malformed)});
          assert.deepEqual((await roles.resolveAuthorization('pending')).roleCodes,[]);
          assert.deepEqual((await roles.resolveAuthorization('pending')).permissionCodes,[]);
          assert.equal(await countEnabledAdmins(pool),2);
        }
        await db('app_user').where('user_id','pending').update({roles:'["admin"]'});
        assert.deepEqual((await roles.resolveAuthorization('pending')).roleCodes,['admin']);
        assert.equal(await countEnabledAdmins(pool),3);
      } finally {await db('app_user').where('user_id','pending').update({roles:'[]'});}
    });
    await t.test('credential SQL errors cannot reach response/log with plaintext/hash',async()=>{
      const original=pool.getConnection.bind(pool);const secretMarker='DO_NOT_LOG_SYNTHETIC_CREDENTIAL';let writes=0;
      (pool as any).getConnection=async()=>{
        const conn=await original();const query=conn.query.bind(conn);
        conn.query=(async(sql:string,values:unknown[])=>{if(sql.includes('set password_hash')){writes++;throw Object.assign(new Error(secretMarker),{sql:secretMarker,sqlMessage:secretMarker});}return query(sql,values);}) as typeof conn.query;
        return conn;
      };
      const logs:string[]=[];const originalError=console.error;console.error=(...args)=>{logs.push(args.map(String).join(' '));};
      try{
        const res=await request(app).post('/api/v1/users/viewer/reset-password').set('Authorization','Bearer '+token).send({password:fresh});assert.equal(res.status,500);assert.equal(writes,1);
        assert.equal(JSON.stringify(res.body).includes(secretMarker),false);assert.equal(logs.some(log=>log.includes(secretMarker)),false);
      }finally{pool.getConnection=original;console.error=originalError;}
    });
    await t.test('real concurrent admin downgrade cannot remove last available administrator',async()=>{
      const outcomes=await Promise.allSettled([
        users.updateUserByAdmin('admin-a',{role:'handler'},{...ctx,userId:'admin-b'}),
        users.updateUserByAdmin('admin-b',{role:'handler'},ctx),
      ]);
      assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
      const rejected=outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.status,409);
      const [count]=await db.raw("select count(*) as total from app_user where status=1 and json_contains(roles,json_quote('admin'))");assert.equal(Number(count[0].total),1);
    });
    await t.test('bootstrap refuses new admin and repeated configured identity never changes password/role',async()=>{
      const before=await db('app_user').where('username','admin-a').first();
      const seed=(username:string)=>spawnSync(process.execPath,['scripts/seed-admin.mjs'],{cwd:process.cwd(),env:{...process.env,GQXQ_BOOTSTRAP_ADMIN_USERNAME:username,GQXQ_BOOTSTRAP_ADMIN_PASSWORD:fresh},encoding:'utf8'});
      const repeat=seed('admin-a');assert.equal(repeat.status,0);const after=await db('app_user').where('username','admin-a').first();
      assert.equal(before.password_hash===after.password_hash,true);assert.equal(JSON.stringify(before.roles)===JSON.stringify(after.roles),true);
      assert.equal(seed('bootstrap-extra').status,1);assert.equal(Number((await db('app_user').count({n:'id'}).where('username','bootstrap-extra'))[0].n),0);
      const audit=await db('operation_audit_log').select('detail');assert.equal(audit.some(row=>JSON.stringify(row.detail).includes(initial)||JSON.stringify(row.detail).includes(fresh)),false);
    });
    await t.test('first bootstrap is idempotent and creates a forced-change identity without password disclosure',async()=>{
      // Dedicated component database only; preserve prior audit rows for inspection.
      await db('app_user').delete();
      const seed=()=>spawnSync(process.execPath,['scripts/seed-admin.mjs'],{cwd:process.cwd(),env:{...process.env,GQXQ_BOOTSTRAP_ADMIN_USERNAME:'initial-admin',GQXQ_BOOTSTRAP_ADMIN_PASSWORD:initial},encoding:'utf8'});
      const first=seed();assert.equal(first.status,0);const before=await db('app_user').where('username','initial-admin').first();
      assert.equal(Number(before.must_change_password),1);assert.equal(Number(before.session_version),1);assert.equal(first.stdout.includes(initial),false);
      const repeated=seed();assert.equal(repeated.status,0);const after=await db('app_user').where('username','initial-admin').first();
      assert.equal(before.password_hash===after.password_hash,true);assert.equal(Number((await db('app_user').count({n:'id'}))[0].n),1);
    });
  } finally {await closePool();await db.destroy();}
});
