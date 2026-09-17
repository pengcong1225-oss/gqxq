// M3 数据回填与越界值修复。
// 幂等：3) 先插入留痕再改写，改写后不再有 completed，重跑不会重复插入。

exports.up = async (knex) => {
  // 1) 三轴默认值兜底（列为 not null default，理论上无 NULL；此处只做语义显式化）
  await knex.raw("update complaint set source_event_status = 'unknown' where source_event_status is null");
  await knex.raw("update complaint set reporting_status = 'not_started' where reporting_status is null");
  await knex.raw("update complaint set supervision_status = 'none' where supervision_status is null");

  // 2) 督办状态由既有 dispatch_order 派生；只补 supervision_status = 'none' 的行，重跑安全。
  //    来源事件状态不猜测：宜接就办未接入，一律 unknown。
  const [r2] = await knex.raw(
    "update complaint c join dispatch_order d on d.complaint_id = c.complaint_id " +
    "set c.supervision_status = case " +
    "      when d.status in ('pending','pushed','accepted','processing','returned') then d.status " +
    "      when d.status = 'archived' then 'archived' " +
    "      else 'none' end, " +
    "    c.responsible_match_reason = concat('由既有 dispatch_order(', d.assignment_id, ') status=', d.status, ' 回填') " +
    "where c.supervision_status = 'none'"
  );

  // 3) correction_status 的越界值 'completed' 不在约定集合 none/pending/corrected 内。
  //    先写 complaint_field_version 留痕，再改写。
  const [ins] = await knex.raw(
    "insert into complaint_field_version " +
    "  (version_id, complaint_id, field_name, old_value, new_value, change_source, reason, operator_name) " +
    "select concat('CFV-REPAIR-', c.id), c.complaint_id, 'correction_status', " +
    "       c.correction_status, 'corrected', 'data_repair', " +
    "       '原值 completed 不在约定枚举集合内，按语义映射为 corrected', 'system' " +
    "from complaint c where c.correction_status = 'completed'"
  );
  const [upd] = await knex.raw(
    "update complaint set correction_status = 'corrected' where correction_status = 'completed'"
  );
  const fixed = upd.affectedRows || 0;
  console.log('[M3] 督办状态回填受影响行=' + (r2.affectedRows || 0) + '，correction_status 修复=' + fixed + ' 行，留痕=' + (ins.affectedRows || 0) + ' 条');

  // 4) 校验：越界值必须归零
  const [chk] = await knex.raw("select count(*) as c from complaint where correction_status not in ('none','pending','corrected','failed')");
  if (chk[0].c > 0) {
    throw new Error('[M3] 修复后仍有 ' + chk[0].c + ' 行 correction_status 越界，请人工核对');
  }
};

exports.down = async (knex) => {
  // 用留痕反向还原 correction_status
  await knex.raw(
    "update complaint c join complaint_field_version v " +
    "  on v.complaint_id = c.complaint_id and v.field_name = 'correction_status' and v.change_source = 'data_repair' " +
    "set c.correction_status = v.old_value"
  );
};
