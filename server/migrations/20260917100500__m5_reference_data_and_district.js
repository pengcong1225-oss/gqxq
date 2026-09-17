// M5 参考数据修正与 district_code 回填。
//
// 起因（G1 前端接入真实接口时发现的三处数据不一致，都不是代码缺陷而是数据缺陷）：
//   1) dict_item 的 urgency_level.critical 标签是「重大」，而 domain/enums.ts 是「特急」，
//      导致筛选下拉与列表 Tag 对同一条数据展示两种中文名。
//   2) dict_item 的 complaint_type 只有 3 项，缺 report（举报），筛选选不到举报。
//   3) complaint.district_code 全为 NULL（只有 district_name），按区域筛选永远 0 条；
//      service_grid.district_code 同样是 NULL，库内没有现成映射可回填。
//
// 处理原则：
//   * 标签以 domain/enums.ts 为唯一真源修正字典（避免两套中文名）。
//   * district 用公开的行政区划代码（GB/T 2260）登记为字典；只回填 district_name 能精确匹配的行，
//     匹配不上的（如「高新区」并非标准行政区划）保持 NULL，**不猜测**。
//   * 改动 complaint 的行按 M3 的做法先写 complaint_field_version 留痕。

const DISTRICTS = [
  ['420502', '西陵区'],
  ['420503', '伍家岗区'],
  ['420504', '点军区'],
  ['420505', '猇亭区'],
  ['420506', '夷陵区'],
  ['420581', '宜都市'],
  ['420582', '当阳市'],
  ['420583', '枝江市'],
  ['420525', '远安县'],
  ['420526', '兴山县'],
  ['420527', '秭归县'],
  ['420528', '长阳土家族自治县'],
  ['420529', '五峰土家族自治县'],
];

exports.up = async (knex) => {
  // 1) 修正与 enums.ts 不一致的标签
  const [fixed] = await knex.raw(
    "update dict_item set item_label = '特急' where dict_type = 'urgency_level' and item_value = 'critical' and item_label <> '特急'"
  );
  console.log('[M5] 修正 urgency_level.critical 标签的行数=' + (fixed.affectedRows || 0));

  // 2) 补 complaint_type.report（先查再插，避免 MySQL 对同表子查询的限制）
  const [hasReport] = await knex.raw(
    "select 1 from dict_item where dict_type = 'complaint_type' and item_value = 'report' limit 1"
  );
  if (hasReport.length === 0) {
    await knex.raw(
      "insert into dict_item (item_id, dict_type, item_value, item_label, status) values (?, 'complaint_type', 'report', '举报', 'enabled')",
      ['DICT-COMPLAINT-REPORT']
    );
    console.log('[M5] 已补 complaint_type.report = 举报');
  } else {
    console.log('[M5] complaint_type.report 已存在，跳过');
  }

  // 3) 登记 district 字典类型与字典项
  const [hasType] = await knex.raw("select 1 from dict_type where dict_type = 'district' limit 1");
  if (hasType.length === 0) {
    await knex.raw(
      "insert into dict_type (dict_type, dict_name, status) values ('district', '行政区划', 'enabled')"
    );
    console.log('[M5] 已登记 dict_type=district（行政区划）');
  }
  let added = 0;
  for (const [code, name] of DISTRICTS) {
    const [exists] = await knex.raw(
      "select 1 from dict_item where dict_type = 'district' and item_value = ? limit 1",
      [code]
    );
    if (exists.length === 0) {
      await knex.raw(
        "insert into dict_item (item_id, dict_type, item_value, item_label, status) values (?, 'district', ?, ?, 'enabled')",
        ['DICT-DISTRICT-' + code, code, name]
      );
      added += 1;
    }
  }
  console.log('[M5] district 字典项新增 ' + added + ' 条');

  // 4) 回填 complaint.district_code：先留痕再改写，只动 district_code 为空且名称精确匹配的行
  let backfilled = 0;
  for (const [code, name] of DISTRICTS) {
    const [rows] = await knex.raw(
      'select complaint_id from complaint where district_code is null and district_name = ?',
      [name]
    );
    if (rows.length === 0) continue;
    for (const row of rows) {
      await knex.raw(
        'insert into complaint_field_version ' +
          '(version_id, complaint_id, field_name, old_value, new_value, change_source, reason, operator_name) ' +
          "values (?, ?, 'district_code', null, ?, 'data_repair', ?, 'system')",
        [
          'CFV-DIST-' + row.complaint_id,
          row.complaint_id,
          code,
          '按 district_name=' + name + ' 匹配 GB/T 2260 行政区划代码回填',
        ]
      );
    }
    const [upd] = await knex.raw(
      'update complaint set district_code = ? where district_code is null and district_name = ?',
      [code, name]
    );
    backfilled += upd.affectedRows || 0;
  }
  const [left] = await knex.raw(
    'select count(*) as c from complaint where district_code is null'
  );
  console.log(
    '[M5] 回填 district_code ' + backfilled + ' 行；仍为 NULL 的 ' + left[0].c +
      ' 行（district_name 不是标准行政区划，保持 NULL 不猜测）'
  );
};

exports.down = async (knex) => {
  // 用留痕反向还原 district_code
  await knex.raw(
    'update complaint c join complaint_field_version v ' +
      "  on v.complaint_id = c.complaint_id and v.field_name = 'district_code' and v.change_source = 'data_repair' " +
      'set c.district_code = v.old_value'
  );
  await knex.raw("delete from dict_item where dict_type = 'district'");
  await knex.raw("delete from dict_type where dict_type = 'district'");
  await knex.raw("delete from dict_item where dict_type = 'complaint_type' and item_value = 'report'");
  await knex.raw(
    "update dict_item set item_label = '重大' where dict_type = 'urgency_level' and item_value = 'critical'"
  );
};
