/**
 * 修正保障季规则的有效期：2025-01-01 → 2022-01-01
 *
 * ===== 背景 =====
 * 冬夏研判（标书 1.2.11）按「保障季规则」判定哪些年份算有效统计范围：
 *   · 冬季保供：燃气气压问题(g08)，保障期 11 月–次年 3 月
 *   · 夏季保畅：水压问题(w04)，保障期 6–9 月
 *
 * 两条规则的 `effectiveFrom` 都写成 2025-01-01，导致 2022–2024 季被判为
 * "规则有效期未覆盖"（outside_rule_period），界面上不显示件数。
 *
 * 但底层数据实际是存在的（实测 2026-11-20）：
 *   夏季 w04：2022=185 条 / 2023=125 条 / 2024=125 条 / 2025=145 条 / 2026=218 条
 *   冬季 g08：2021-11~2022-03=42 / 2022-11~2023-03=51 / 2023-11~2024-03=164 / 2024-11~2025-03=29
 *
 * complaint 表最早数据是 2022 年，因此把 effectiveFrom 前移到 2022-01-01，
 * 让 2022 年起的 5 个保障季都能正常统计。
 *
 * ===== 做法 =====
 * 规则是版本化存储（`business_rule_version`，publishedRules 取 max(version)），
 * 因此这里**发布 v3**，而不是修改 v2 —— 保留历史可追溯性。
 * 同时同步 `business_rule` 主表的 content 与 edit_version，保持一致。
 */

const RULES = [
  {
    ruleId: 'seasonal-winter-gas-pressure',
    effectiveFrom: '2022-01-01',
  },
  {
    ruleId: 'seasonal-summer-water-pressure',
    effectiveFrom: '2022-01-01',
  },
];

exports.up = async (db) => {
  for (const { ruleId, effectiveFrom } of RULES) {
    const [verRows] = await db.raw(
      'select version, content from business_rule_version where rule_id = ? order by version desc limit 1',
      [ruleId],
    );
    if (!verRows.length) {
      console.warn(`[migration] 规则 ${ruleId} 不存在，跳过`);
      continue;
    }
    const latest = verRows[0];
    const curVersion = Number(latest.version);
    const content = typeof latest.content === 'string' ? JSON.parse(latest.content) : latest.content;

    if (content.effectiveFrom === effectiveFrom) {
      console.log(`[migration] ${ruleId} 的 effectiveFrom 已是 ${effectiveFrom}，跳过`);
      continue;
    }

    const next = { ...content, effectiveFrom };

    // 发布新版本
    await db.raw(
      'insert into business_rule_version (rule_id, version, kind, content, published_by, published_at) values (?,?,?,?,?,now())',
      [ruleId, curVersion + 1, 'seasonal', JSON.stringify(next), 'SYSTEM-MIGRATION'],
    );

    // 同步主表（edit_version 递增，content 与最新发布版一致）
    await db.raw(
      'update business_rule set content = ?, edit_version = edit_version + 1 where rule_id = ?',
      [JSON.stringify(next), ruleId],
    );

    console.log(`[migration] ${ruleId}: v${curVersion} → v${curVersion + 1}，effectiveFrom ${content.effectiveFrom} → ${effectiveFrom}`);
  }
};

exports.down = async (db) => {
  for (const { ruleId } of RULES) {
    const [verRows] = await db.raw(
      'select version from business_rule_version where rule_id = ? order by version desc limit 1',
      [ruleId],
    );
    if (verRows.length && Number(verRows[0].version) > 2) {
      // 回滚只需删掉本次新增的版本，publishedRules 会自动退回 v2
      await db.raw('delete from business_rule_version where rule_id = ? and version > 2', [ruleId]);
    }
  }
};