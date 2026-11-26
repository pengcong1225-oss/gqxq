/**
 * 管道施工改造项目：补齐标书 1.2.7「管线图层对接」要求的字段
 *
 * 标书原文（招标文件 1.2.7）：
 *   建设管线图层，将图层分为燃气管线图层和供水管线图层，根据管道施工改造上报的信息，
 *   获取涉及的网格，若涉及改造事件的网格将形成色块高亮显示，点击可查看改造事件的信息，
 *   包括改造项目名称、企业名称、时间范围、现场施工人数、相关诉求等信息，
 *   点击查看更多可获取管道改造详情，其中基础信息包括项目名称、企业名称、时间范围、
 *   现场施工人数、改造原因、影响区域、应急预案等信息，
 *   此外对于影响区域可查看每个网格历史产生的管道改造事件信息。
 *
 * 现状问题：原表只有 pipeline_length / budget / progress / status，
 * 缺少「时间范围 / 施工人数 / 改造原因 / 影响区域 / 应急预案 / 涉及网格」，
 * 无法支撑图层渲染与详情展示。
 *
 * 本迁移只做**加列**，不改既有列、不动数据（现有 2 行保持可用，新列留 NULL）。
 *
 * 坐标系约定：admin_grid_codes 存的是 admin_grid.code（6 位区县 / 9 位街道），
 * 与边界图层同一套编码，前端可直接用于网格色块高亮。
 */

exports.up = async (db) => {
  const hasTable = await db.schema.hasTable('pipeline_project');
  if (!hasTable) {
    // 表不存在时按完整结构创建（与既有 2 行的表结构保持字段兼容）
    await db.raw(`
      create table pipeline_project (
        id bigint unsigned not null auto_increment,
        project_id varchar(64) not null,
        project_no varchar(64) null,
        project_name varchar(255) not null,
        enterprise_code varchar(64) null,
        enterprise_name varchar(255) null,
        business_type varchar(32) not null comment 'water=供水 / gas=燃气',
        pipeline_length decimal(12,2) null,
        budget decimal(16,2) null,
        progress decimal(5,2) null,
        status varchar(32) null,
        start_date date null comment '施工开始日期（标书：时间范围）',
        end_date date null comment '施工结束日期（标书：时间范围）',
        worker_count int null comment '现场施工人数（标书要求）',
        construction_reason varchar(500) null comment '改造原因（标书要求）',
        affected_area varchar(500) null comment '影响区域描述（标书要求）',
        emergency_plan text null comment '应急预案（标书要求）',
        admin_grid_codes json null comment '涉及网格编码数组（标书：获取涉及的网格）',
        source_apply_no varchar(64) null comment '来源申请号（公用事业业务系统）',
        source_event_no varchar(64) null comment '来源项目事件号',
        source_version varchar(64) null comment '来源版本',
        approval_status varchar(32) null comment '审批状态：approved/rejected/cancelled',
        received_at datetime null comment '数据接入时间',
        primary key (id),
        unique key uk_pipeline_project_id (project_id),
        key idx_pipeline_type_status (business_type, status),
        key idx_pipeline_date (start_date, end_date)
      ) engine=InnoDB default charset=utf8mb4 comment='管道施工改造项目（标书 1.2.7 管线图层）'
    `);
    return;
  }

  // 表已存在：逐列补齐（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，先查再加）
  const specs = [
    ['start_date', 'date null comment \'施工开始日期（标书：时间范围）\''],
    ['end_date', 'date null comment \'施工结束日期（标书：时间范围）\''],
    ['worker_count', 'int null comment \'现场施工人数（标书要求）\''],
    ['construction_reason', 'varchar(500) null comment \'改造原因（标书要求）\''],
    ['affected_area', 'varchar(500) null comment \'影响区域描述（标书要求）\''],
    ['emergency_plan', 'text null comment \'应急预案（标书要求）\''],
    ['admin_grid_codes', 'json null comment \'涉及网格编码数组（标书：获取涉及的网格）\''],
    ['source_apply_no', 'varchar(64) null comment \'来源申请号\''],
    ['source_event_no', 'varchar(64) null comment \'来源项目事件号\''],
    ['source_version', 'varchar(64) null comment \'来源版本\''],
    ['approval_status', 'varchar(32) null comment \'审批状态\''],
    ['received_at', 'datetime null comment \'数据接入时间\''],
  ];

  const [cols] = await db.raw(
    'select column_name from information_schema.columns where table_schema = database() and table_name = ?',
    ['pipeline_project']
  );
  const existing = new Set(cols.map((c) => String(c.column_name ?? c.COLUMN_NAME)));

  for (const [name, def] of specs) {
    if (existing.has(name)) continue;
    await db.raw(`alter table pipeline_project add column ${name} ${def}`);
  }

  // 常用查询索引（图层按业务类型 + 状态过滤）
  const [idx] = await db.raw(
    'select index_name from information_schema.statistics where table_schema = database() and table_name = ?',
    ['pipeline_project']
  );
  const idxNames = new Set(idx.map((r) => String(r.index_name ?? r.INDEX_NAME)));
  if (!idxNames.has('idx_pipeline_type_status')) {
    await db.raw('alter table pipeline_project add index idx_pipeline_type_status (business_type, status)');
  }
  if (!idxNames.has('idx_pipeline_date')) {
    await db.raw('alter table pipeline_project add index idx_pipeline_date (start_date, end_date)');
  }
};

exports.down = async () => {
  // 只回滚本次新增的列；既有数据列不动
  throw new Error('pipeline_project 字段扩充不提供自动回滚（避免误删来源数据），如需回滚请手工 ALTER');
};