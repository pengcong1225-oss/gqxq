// M10 —— 扩展 complaint_type 字典：help（求助）/ other（其他）/ praise（表扬）。
//
// 依据：真实来源数据核对（docs/2026-09-18-宜接就办导出数据核对与导入方案.md）
//   宜接就办 2026-09-17 导出 466 行，「诉求类型」取值分布为
//   投诉类 243 / 咨询类 212 / 求助类 4 / 其他类 4 / 表扬类 2 / 建议类 1。
//   G1 只登记了 complaint/consult/suggest/report，缺 3 个码位。
//   缺码位的后果是硬性的：入站校验 isValidCode('complaint_type', v) 会直接拒单
//   （见 src/routes/externalYijiejieban.ts 的 codeFields 校验），
//   若为绕过而把「求助类」塞进 suggest、「表扬类」塞进 report，就是对来源数据的篡改。
//   因此按 G1 已确立的「字典可扩展、码位必须小写且与 domain/enums.ts 一致」原则补码。
//
// 幂等：先查再插（MySQL 不允许对同表做 insert ... select 子查询）。
// 回滚：删除本迁移新增的 3 个字典项。若已有业务数据引用这些码位，
//   标签仍可由 src/domain/enums.ts 的 DICT 兜底（该文件是校验与标签的第二真源）。

const ITEMS = [
  ['DICT-COMPLAINT-HELP', 'help', '求助'],
  ['DICT-COMPLAINT-OTHER', 'other', '其他'],
  ['DICT-COMPLAINT-PRAISE', 'praise', '表扬'],
];

exports.up = async (knex) => {
  for (const [itemId, value, label] of ITEMS) {
    const [exists] = await knex.raw(
      "select 1 from dict_item where dict_type = 'complaint_type' and item_value = ? limit 1",
      [value]
    );
    if (exists.length === 0) {
      await knex.raw(
        "insert into dict_item (item_id, dict_type, item_value, item_label, status) " +
          "values (?, 'complaint_type', ?, ?, 'enabled')",
        [itemId, value, label]
      );
      console.log('[M10] 已新增 complaint_type.' + value + ' = ' + label);
    } else {
      console.log('[M10] complaint_type.' + value + ' 已存在，跳过');
    }
  }
};

exports.down = async (knex) => {
  const [res] = await knex.raw(
    "delete from dict_item where dict_type = 'complaint_type' and item_value in ('help', 'other', 'praise')"
  );
  console.log('[M10] 回滚：删除 complaint_type 字典项 ' + (res.affectedRows || 0) + ' 条');
};
