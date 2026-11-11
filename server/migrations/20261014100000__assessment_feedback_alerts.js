exports.up=async db=>{
 const tables=[
 ['shutdown_link_revision',`link_id char(64) not null,revision_hash char(64) not null,evidence json not null,created_at datetime(3) not null,primary key(link_id,revision_hash)`],
 ['business_rule',`rule_id varchar(64) primary key,kind varchar(32) not null,edit_version bigint unsigned not null,content json not null`],
 ['business_rule_version',`rule_id varchar(64) not null,version bigint unsigned not null,kind varchar(32) not null,content json not null,published_by varchar(64) not null,published_at datetime(3) not null,primary key(rule_id,version)`],
 ['shutdown_complaint_link',`link_id char(64) primary key,event_id char(64) not null,complaint_id varchar(64) not null,event_version bigint unsigned not null,complaint_version bigint unsigned not null,rule_version bigint unsigned,match_state varchar(16) not null,reason varchar(128),evidence json not null,updated_at datetime(3) not null,unique key uq_event_complaint(event_id,complaint_id)`],
 ['shutdown_feedback_outbox',`link_id char(64) primary key,revision_hash char(64) not null,state varchar(32) not null,attempts int unsigned not null default 0,response_summary varchar(500),updated_at datetime(3) not null`],
 ['shutdown_feedback_attempt',`attempt_id varchar(64) primary key,link_id char(64) not null,revision_hash char(64) not null,state varchar(32) not null,detail varchar(500),created_at datetime(3) not null`],
 ['business_alert',`alert_id char(64) primary key,rule_id varchar(64) not null,rule_version bigint unsigned not null,window_from date not null,window_to date not null,enterprise_code varchar(64),district_code varchar(64),admin_grid_code varchar(64),quantity int unsigned not null,threshold_value int unsigned not null,state varchar(16) not null,evidence json not null,created_at datetime(3) not null`],
 ['business_alert_action',`action_id varchar(64) primary key,alert_id char(64) not null,action varchar(16) not null,notes varchar(2000) not null,user_id varchar(64) not null,created_at datetime(3) not null`]
 ];for(const [name,columns]of tables)await db.raw('create table if not exists ?? ('+columns+') engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin',[name]);
 // Seed capability once; rerunning migrations cannot restore a revoked grant.
 if(!await db.schema.hasColumn('platform_authorization_state','business_features_seeded'))await db.raw('alter table platform_authorization_state add column business_features_seeded tinyint not null default 0');
 await db.transaction(async tx=>{const state=await tx('platform_authorization_state').where('id',1).forUpdate().first();if(!state)throw Error('Authorization singleton required');
  const permissions=[['assessment.read','行政网格对比与研判'],['business.rules.manage','联动、保障季和预警规则'],['shutdown.feedback.manage','停供关联核算与反馈'],['alert.read','数据预警查询'],['alert.handle','预警核算及处理']];
  for(const [permission_code,name]of permissions)await tx('platform_permission').insert({permission_code,name}).onConflict('permission_code').ignore();
  if(Number(state.business_features_seeded))return;
  for(const [permission_code]of permissions)for(const role_code of ['admin',...(['assessment.read','alert.read'].includes(permission_code)?['handler','readonly']:['shutdown.feedback.manage','alert.handle'].includes(permission_code)?['handler']:[])])if(await tx('platform_role').where({role_code,built_in:1}).first())await tx('platform_role_permission').insert({role_code,permission_code}).onConflict(['role_code','permission_code']).ignore();
  await tx('platform_role').whereIn('role_code',['admin','handler','readonly']).increment('version',1);await tx('platform_authorization_state').where('id',1).update({business_features_seeded:1,version:Number(state.version)+1});
 });
};
exports.down=async()=>{throw Error('Published rules and feedback/alert evidence require audited restoration');};
