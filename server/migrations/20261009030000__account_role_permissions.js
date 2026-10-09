// A5 additive authorization/session migration. Preserve app_user.user_id and audit chains.
const catalog = [["complaint.read", "诉求查询"], ["complaint.assign", "责任单位匹配"], ["complaint.disposition", "诉求归库"], ["complaint.correct", "诉求纠偏"], ["complaint.close", "本系统办结"], ["complaint.source_sync", "来源状态回填"], ["enterprise.read", "企业查询"], ["enterprise.manage", "企业维护"], ["dashboard.read", "大屏查询"], ["dict.read", "字典查询"], ["dispatch.read", "交办查询及填报材料"], ["dispatch.create", "创建交办"], ["dispatch.cancel", "撤销交办"], ["dispatch.push", "推送交办"], ["dispatch.reconcile", "交办核对"], ["dispatch.archive", "交办归档"], ["analysis.read", "分析查询"], ["report.read", "报告查询"], ["report.generate", "报告生成"], ["report.download", "报告下载"], ["source_document.read", "来源文档查询"], ["source_status.read", "来源状态查询"], ["grid.read", "网格查询"], ["grid.manage", "网格维护"], ["shutdown.read", "停供查询"], ["pipeline.read", "施工查询"], ["heatmap.read", "热力图查询"], ["system.users.manage", "平台账号管理"], ["system.roles.manage", "角色授权管理"], ["system.audit.read", "审计查询"], ["system.dict.manage", "字典维护"], ["system.address.backfill", "地址候选补提取"], ["system.integration.manage", "旧集成管理"], ["masterdata.import", "基础数据导入（另需目标维护权限与范围）"]];
const seeds = [["admin", "系统管理员", ["complaint.read", "complaint.assign", "complaint.disposition", "complaint.correct", "complaint.close", "complaint.source_sync", "enterprise.read", "enterprise.manage", "dashboard.read", "dict.read", "dispatch.read", "dispatch.create", "dispatch.cancel", "dispatch.push", "dispatch.reconcile", "dispatch.archive", "analysis.read", "report.read", "report.generate", "report.download", "source_document.read", "source_status.read", "grid.read", "grid.manage", "shutdown.read", "pipeline.read", "heatmap.read", "system.users.manage", "system.roles.manage", "system.audit.read", "system.dict.manage", "system.address.backfill", "system.integration.manage", "masterdata.import"]], ["handler", "业务经办", ["analysis.read", "complaint.assign", "complaint.close", "complaint.correct", "complaint.disposition", "complaint.read", "complaint.source_sync", "dashboard.read", "dict.read", "dispatch.archive", "dispatch.cancel", "dispatch.create", "dispatch.push", "dispatch.read", "dispatch.reconcile", "enterprise.read", "grid.read", "heatmap.read", "pipeline.read", "report.read", "shutdown.read", "source_status.read"]], ["readonly", "只读", ["analysis.read", "complaint.read", "dashboard.read", "dict.read", "dispatch.read", "enterprise.read", "grid.read", "heatmap.read", "pipeline.read", "report.read", "shutdown.read", "source_status.read"]]];
exports.up = async knex => {
  if (!(await knex.schema.hasTable('platform_permission'))) await knex.schema.createTable('platform_permission', t => {
    t.string('permission_code',64).primary(); t.string('name',128).notNullable();
  });
  if (!(await knex.schema.hasTable('platform_role'))) await knex.schema.createTable('platform_role', t => {
    t.string('role_code',64).primary(); t.string('name',64).notNullable(); t.string('description',500).notNullable().defaultTo('');
    t.boolean('enabled').notNullable().defaultTo(true); t.boolean('built_in').notNullable().defaultTo(false);
    t.bigInteger('version').unsigned().notNullable().defaultTo(1);
  });
  if (!(await knex.schema.hasTable('platform_role_permission'))) await knex.schema.createTable('platform_role_permission',t=>{
    t.string('role_code',64).notNullable().references('role_code').inTable('platform_role');
    t.string('permission_code',64).notNullable().references('permission_code').inTable('platform_permission');
    t.primary(['role_code','permission_code']);
  });
  if (!(await knex.schema.hasTable('platform_authorization_state'))) await knex.schema.createTable('platform_authorization_state',t=>{
    t.integer('id').primary();t.bigInteger('version').unsigned().notNullable().defaultTo(1);
  });
  for (const [column,definition] of [
    ['session_version','bigint unsigned not null default 1'],
    ['must_change_password','tinyint not null default 1'],
  ]) if (!(await knex.schema.hasColumn('app_user',column))) await knex.raw('alter table app_user add column ?? '+definition,[column]);
  await knex.transaction(async tx => {
    await tx('platform_authorization_state').insert({id:1,version:1}).onConflict('id').ignore();
    for(const [code,name] of catalog) await tx('platform_permission').insert({permission_code:code,name}).onConflict('permission_code').ignore();
    for(const [code,name,permissions] of seeds) {
      const existing=await tx('platform_role').where('role_code',code).first();
      // Re-running an interrupted migration never resets a configured role.
      if(!existing) {
        await tx('platform_role').insert({role_code:code,name,description:'内置角色',enabled:1,built_in:1,version:1});
        for(const permission of permissions) await tx('platform_role_permission').insert({role_code:code,permission_code:permission});
      }
    }
    const [invalid] = await tx.raw("select u.user_id from app_user u left join platform_role r on r.role_code = json_unquote(json_extract(u.roles, '$[0]')) where json_type(u.roles) <> 'ARRAY' or json_length(u.roles) > 1 or (json_length(u.roles) = 1 and r.role_code is null) limit 1");
    if(invalid.length) throw new Error('Existing account roles require explicit inventory before A5 migration');
  });
};
exports.down = async()=>{throw new Error('A5 rollback requires evidence-preserving restoration; no automatic account/role deletion');};
