// M4 补上 complaint.correction_confidence。
//
// 起因（主线自查发现的缺陷）：迁移设计 §3.3 与平台侧 spec §7.2 都含这一列，
// 但 live gqxq_service.complaint（由 zhuxin-platform 的 V1 建表）**没有**它，
// 导致共享列清单 complaintMapper.COMPLAINT_COLUMNS 引用了一个不存在的列，
// 查询与接收两条线都会撞 ER_BAD_FIELD_ERROR。
//
// 历史行一律留 NULL：既有 address_correction 的两条记录 status 都是 'pending'、
// corrected_address 为 NULL，并不存在"已生效的纠偏置信度"可回填。不伪造数值。

const COLUMN = 'correction_confidence';

exports.up = async (knex) => {
  const [cols] = await knex.raw(
    'select column_name as c from information_schema.columns ' +
      'where table_schema = database() and table_name = ? and column_name = ?',
    ['complaint', COLUMN]
  );
  if (cols.length === 0) {
    await knex.raw(
      "alter table complaint add column correction_confidence decimal(5,2) null " +
        "comment '纠偏置信度（0-1）；历史行 NULL，不伪造' after correction_status"
    );
    console.log('[M4] 已新增 complaint.correction_confidence');
  } else {
    console.log('[M4] 列已存在，跳过');
  }
};

exports.down = async (knex) => {
  await knex.raw('alter table complaint drop column correction_confidence');
};
