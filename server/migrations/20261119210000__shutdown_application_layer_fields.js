/**
 * 停水停气申请：补齐标书 1.2.6「停水停气图层」要求的字段
 *
 * 标书原文（招标文件 1.2.6）：
 *   建设停水停气图层，根据停水停气上报时填写的涉及的网格信息，把停水停气事件与网格关联，
 *   当网格产生一个停水停气事件则产生一个打点标识，点击标识可查看停水停气企业、业务类型、
 *   时间范围、涉及户数、该事件产生的诉求量等信息，点击诉求量，可查看诉求详情。
 *   同时根据停水停气事件的划分也将图层划分为计划性停水、计划性停气、突发性停水、突发性停气图层。
 *   此外，若停水停气事件涉及多个网格，当选去一个标识时，属于同一事件引起的标识会高亮显示。
 *   点击事件详情查看时，可查看到事件的基本信息，包括企业名称、业务类型、时间范围、涉及户数、
 *   影响区域、应急预案、房屋信息、该网格停水停气历史数据等信息。
 *
 * 现状问题：原表只有 enterprise_code / business_type / shutdown_type / affected_area /
 * affected_households / planned_start_time / planned_end_time / status，
 * 缺少「涉及网格 / 应急预案 / 房屋信息 / 来源追溯 / 坐标口径」，
 * 无法支撑打点图层渲染与事件详情展示。
 *
 * 本迁移只做**加列 + 加索引**，不改既有列、不动数据（现有 2 行保持可用，新列留 NULL）。
 *
 * 编码口径：admin_grid_codes 存 admin_grid.code（6 位区县 / 9 位街道），
 * 与边界图层、管线图层同一套编码，前端可直接用于打点定位（街道面质心）。
 */
exports.up = async (db) => {
  const hasTable = await db.schema.hasTable('shutdown_application');
  if (!hasTable) {
    await db.raw(`
      create table shutdown_application (
        id bigint unsigned not null auto_increment,
        shutdown_id varchar(64) not null,
        app_no varchar(64) not null,
        enterprise_code varchar(64) null,
        enterprise_name varchar(255) null,
        business_type varchar(32) not null comment 'water=停水 / gas=停气',
        shutdown_type varchar(32) not null comment 'planned=计划性 / emergency=突发性',
        affected_area varchar(1000) null comment '影响区域描述（标书要求）',
        affected_households int null comment '涉及户数（标书要求）',
        planned_start_time datetime null comment '时间范围-始（标书要求）',
        planned_end_time datetime null comment '时间范围-止（标书要求）',
        status varchar(32) not null default 'draft',
        admin_grid_codes json null comment '涉及网格编码数组（标书：填写涉及的网格信息）',
        emergency_plan text null comment '应急预案（标书要求）',
        housing_info text null comment '房屋信息（标书要求）',
        source_apply_no varchar(64) null comment '来源申请号（公用事业填报系统）',
        source_feed_id bigint null comment '来源 feedId',
        source_revision varchar(128) null comment '来源版本摘要',
        source_version bigint null comment '来源版本序号',
        coordinate_system varchar(32) null comment '影响范围多边形坐标系（WGS84/GCJ02）',
        coordinate_note varchar(255) null comment '坐标系推定说明（推定值必须写清依据）',
        approval_status varchar(32) null comment '审批状态：approved/rejected/pending',
        received_at datetime null comment '数据接入时间',
        primary key (id),
        unique key uk_shutdown_id (shutdown_id),
        unique key uk_shutdown_app_no (app_no),
        key idx_shutdown_type (business_type, shutdown_type),
        key idx_shutdown_period (planned_start_time, planned_end_time),
        key idx_shutdown_source (source_apply_no)
      ) engine=InnoDB default charset=utf8mb4 comment='停水停气申请（标书 1.2.6 停水停气图层）'
    `);
    return;
  }

  // 表已存在：逐列补齐（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，先查再加）
  const specs = [
    ['admin_grid_codes', 'json null comment \'涉及网格编码数组（标书：填写涉及的网格信息）\''],
    ['emergency_plan', 'text null comment \'应急预案（标书要求）\''],
    ['housing_info', 'text null comment \'房屋信息（标书要求）\''],
    ['source_apply_no', 'varchar(64) null comment \'来源申请号\''],
    ['source_feed_id', 'bigint null comment \'来源 feedId\''],
    ['source_revision', 'varchar(128) null comment \'来源版本摘要\''],
    ['source_version', 'bigint null comment \'来源版本序号\''],
    ['coordinate_system', 'varchar(32) null comment \'影响范围多边形坐标系\''],
    ['coordinate_note', 'varchar(255) null comment \'坐标系推定说明\''],
    ['approval_status', 'varchar(32) null comment \'审批状态\''],
    ['received_at', 'datetime null comment \'数据接入时间\''],
  ];

  const [cols] = await db.raw(
    'select column_name from information_schema.columns where table_schema = database() and table_name = ?',
    ['shutdown_application']
  );
  const existing = new Set(cols.map((c) => String(c.column_name ?? c.COLUMN_NAME)));
  for (const [name, def] of specs) {
    if (existing.has(name)) continue;
    await db.raw(`alter table shutdown_application add column ${name} ${def}`);
  }

  // 图层按「业务类型 + 计划/突发」分层，且按时间范围过滤
  const [idx] = await db.raw(
    'select distinct index_name from information_schema.statistics where table_schema = database() and table_name = ?',
    ['shutdown_application']
  );
  const idxNames = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));
  if (!idxNames.has('idx_shutdown_type')) {
    await db.raw('alter table shutdown_application add index idx_shutdown_type (business_type, shutdown_type)');
  }
  if (!idxNames.has('idx_shutdown_period')) {
    await db.raw('alter table shutdown_application add index idx_shutdown_period (planned_start_time, planned_end_time)');
  }
  if (!idxNames.has('idx_shutdown_source')) {
    await db.raw('alter table shutdown_application add index idx_shutdown_source (source_apply_no)');
  }
};

exports.down = async () => {
  // 只回滚本次新增的列会丢来源数据，故不提供自动回滚；如需回滚请手工 ALTER
  throw new Error('shutdown_application 字段扩充不提供自动回滚（避免误删来源数据），如需回滚请手工 ALTER');
};