// Additive only: NULL legacy JSON values are inferred lazily from evidence, never bulk reset.
exports.up = async (knex) => {
  for (const [column, definition] of [
    ['edit_version', "bigint unsigned not null default 1 comment '有效值编辑与人工决定的共享乐观版本'"],
    ['source_fields', "json null comment '本次收到的结构化来源快照，来源顺序未知时不代表最新业务值'"],
    ['effective_field_state', "json null comment '字段人工决定时的有效值、保护状态、确认版本与核验依据'"],
  ]) {
    if (!(await knex.schema.hasColumn('complaint', column))) {
      await knex.raw('alter table complaint add column ?? ' + definition, [column]);
    }
  }
};
exports.down = async () => { throw new Error('A1 migration rollback requires explicit evidence-preserving restoration; no automatic column deletion'); };
