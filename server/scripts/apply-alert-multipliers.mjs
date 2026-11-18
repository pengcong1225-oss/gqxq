import 'dotenv/config';
import {pool, closePool} from '../src/db/pool';
import {resolveAuthorizationFrom} from '../src/repositories/roleRepo';
import {readUserScope} from '../src/repositories/userScopeRepo';
import {saveBusinessRule, publishBusinessRule, previewAlertBaseline, decodeContent} from '../src/services/businessRuleService';

/** 目标阈值（业务决策，2026-11-18 业主确认重存）：
 *  - 冬季保供 g08：保持 7（≈×3.5，冬季基数小，1.5 倍会过噪）
 *  - 夏季保畅 w04：保持 16（×1.5，与公式一致）
 *  - 计划停气 g06：16 → 10（×2.0）
 *  - 计划停水 w01：29 → 25（×2.2）
 *  - 燃气三件套：保持 133（×1.6，公式邻域）
 */
const TARGETS = {
  'alert-winter-gas-pressure': 7,
  'alert-summer-water-pressure': 16,
  'alert-planned-shutdown-gas': 10,
  'alert-planned-shutdown-water': 25,
  'alert-gas-three-piece-installation': 133,
};
const APPLY = process.argv.includes('--apply');

const [admins] = await pool.query("select user_id, username, status, must_change_password from app_user where username='admin'");
if (!admins.length) throw new Error('admin 用户不存在');
const a = admins[0];
const userId = String(a.user_id);
const auth = await resolveAuthorizationFrom(pool, userId);
const scope = await readUserScope(pool, userId);
const ctx = {
  userId,
  userName: String(a.username),
  clientIp: null,
  permissionCodes: auth.permissionCodes,
  access: { userId, roles: auth.roleCodes, scopeVersion: scope.scopeVersion, rules: scope.rules, canReadSource: false },
};

const [rows] = await pool.query('select rule_id, kind, edit_version, content from business_rule where kind=? order by rule_id', ['alert']);
const out = [];
for (const row of rows) {
  const ruleId = String(row.rule_id);
  const target = TARGETS[ruleId];
  if (target === undefined) { out.push({ ruleId, skipped: '无目标阈值' }); continue; }
  const content = decodeContent(row.content);
  const preview = await previewAlertBaseline({
    businessType: content.businessType,
    minorCodes: content.minorCodes,
    majorCodes: content.majorCodes,
    windowDays: content.windowDays,
    scene: content.scene,
  }, ctx);
  const windowBase = Number(preview.windowBase);
  // 反推一个能精确命中目标阈值的倍数（两位小数，扫描 1.00–5.00）
  // 优先使用"有业务含义"的整数档（1.5 高 50%、2.0 翻倍…），只有都命中不了目标阈值时才扫描
  const PREFERRED = [1.5, 2.0, 1.2, 1.3, 1.8, 2.2, 2.5, 3.0, 3.5];
  let multiplier = null;
  for (const m of PREFERRED) {
    if (Math.ceil(windowBase * m) === target) { multiplier = m; break; }
  }
  if (multiplier === null) {
    for (let m = 1.0; m <= 5.0001; m += 0.01) {
      const rounded = Number(m.toFixed(2));
      if (Math.ceil(windowBase * rounded) === target) { multiplier = rounded; break; }
    }
  }
  if (multiplier === null) { out.push({ ruleId, windowBase, target, error: '在 1.00–5.00 内找不到能命中目标阈值的倍数' }); continue; }
  const next = {
    ...content,
    expectedVersion: Number(row.edit_version),
    threshold: target,
    multiplier,
    baseline: {
      avgPerDay: preview.avgPerDay,
      windowBase: preview.windowBase,
      baseDays: preview.baseDays,
      daysFrom: preview.daysFrom,
      daysTo: preview.daysTo,
    },
  };
  const entry = { ruleId, oldThreshold: content.threshold, newThreshold: target, windowBase, multiplier, expectedVersion: next.expectedVersion };
  if (APPLY) {
    const saved = await saveBusinessRule(next, ctx);
    const published = await publishBusinessRule(ruleId, saved.editVersion, ctx);
    entry.saved = saved;
    entry.published = published;
  }
  out.push(entry);
}
console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', results: out }, null, 2));
await closePool();