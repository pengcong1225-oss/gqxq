/**
 * 按标书预置「四按钮」规则（seasonal + alert），走正式 API（含校验/审计/版本）。
 *
 * 阈值校准依据（真实库 gqxq_service，2026-11-17 计算）：
 *  - g08 保供期(11-3月) 周均：2025=3.2、2026=5.4 → 均值 4.3 ⟹ 7 天窗口阈值 = ceil(4.3×1.5) = 7
 *  - w04 保畅期(6-9月)  周均：2025=8.1、2026=12.1 → 均值 10.1 ⟹ 7 天窗口阈值 = ceil(10.1×1.5) = 16
 *  - g06 日均 2.56 ⟹ 3 天窗口基线 7.68，×2 ⟹ 阈值 16
 *  - w01 日均 4.75 ⟹ 3 天窗口基线 14.25，×2 ⟹ 阈值 29
 *
 * 燃气三件套：定义与分类映射未经业务确认，规则引擎要求 definitionConfirmed=true 才可保存，
 * 因此**不落库**，由前端按「待确认」展示。
 */
const BASE = process.env.GQXQ_BASE || 'http://127.0.0.1:3100';
const USER = process.env.GQXQ_USER || 'admin';
const PASS = process.env.GQXQ_PASS || 'qwer1234';

const VALID_FROM = '2025-01-01';
const VALID_TO = '2026-12-31';
// dict_type.version（complaint_category 当前为 20），版本不符时发布会报 '分类字典已变化'
const DICT_VERSION = process.env.GQXQ_DICT_VERSION || '20';

const rules = [
  {
    ruleId: 'seasonal-winter-gas-pressure',
    kind: 'seasonal',
    name: '冬季保供 · 燃气气压问题(BY 标书 1.2.11)',
    businessType: 'gas',
    dictionaryVersion: DICT_VERSION,
    majorCodes: [],
    minorCodes: ['g08'],
    effectiveFrom: VALID_FROM,
    effectiveTo: VALID_TO,
    scene: 'winter',
    startMonth: 11,
    endMonth: 3,
    threshold: null,
    windowDays: null,
    definitionBasis:
      '标书 1.2.11：冬季保供场景统计保供期间燃气气压问题(g08)诉求；保供期定为 11 月至次年 3 月（含），与供暖季/用气高峰一致。',
    definitionConfirmed: true,
    enabled: true,
  },
  {
    ruleId: 'seasonal-summer-water-pressure',
    kind: 'seasonal',
    name: '夏季保畅 · 水压问题(BY 标书 1.2.11)',
    businessType: 'water',
    dictionaryVersion: DICT_VERSION,
    majorCodes: [],
    minorCodes: ['w04'],
    effectiveFrom: VALID_FROM,
    effectiveTo: VALID_TO,
    scene: 'summer',
    startMonth: 6,
    endMonth: 9,
    threshold: null,
    windowDays: null,
    definitionBasis:
      '标书 1.2.11：夏季保畅场景统计保畅期间水压问题(w04)诉求；保畅期定为 6 月至 9 月（含），与夏季用水高峰一致。',
    definitionConfirmed: true,
    enabled: true,
  },
  {
    ruleId: 'alert-winter-gas-pressure',
    kind: 'alert',
    name: '预警 · 冬季保供燃气气压(7日窗口)',
    businessType: 'gas',
    dictionaryVersion: DICT_VERSION,
    majorCodes: [],
    minorCodes: ['g08'],
    effectiveFrom: VALID_FROM,
    effectiveTo: VALID_TO,
    scene: 'winter',
    startMonth: null,
    endMonth: null,
    threshold: 7,
    windowDays: 7,
    definitionBasis:
      '标书 1.2.10 冬季保供：滑动 7 日窗口内 g08 诉求量达到阈值即预警。阈值取近两年保供期周均(2025=3.2、2026=5.4，均值 4.3)的 1.5 倍取整 = 7 件。数据仅 2025 年起，近 5 年口径不可用。',
    definitionConfirmed: true,
    enabled: true,
  },
  {
    ruleId: 'alert-summer-water-pressure',
    kind: 'alert',
    name: '预警 · 夏季保畅水压(7日窗口)',
    businessType: 'water',
    dictionaryVersion: DICT_VERSION,
    majorCodes: [],
    minorCodes: ['w04'],
    effectiveFrom: VALID_FROM,
    effectiveTo: VALID_TO,
    scene: 'summer',
    startMonth: null,
    endMonth: null,
    threshold: 16,
    windowDays: 7,
    definitionBasis:
      '标书 1.2.10 夏季保畅：滑动 7 日窗口内 w04 诉求量达到阈值即预警。阈值取近两年保畅期周均(2025=8.1、2026=12.1，均值 10.1)的 1.5 倍取整 = 16 件。',
    definitionConfirmed: true,
    enabled: true,
  },
  {
    ruleId: 'alert-planned-shutdown-gas',
    kind: 'alert',
    name: '预警 · 计划性停气期间停气诉求(3日窗口)',
    businessType: 'gas',
    dictionaryVersion: DICT_VERSION,
    majorCodes: [],
    minorCodes: ['g06'],
    effectiveFrom: VALID_FROM,
    effectiveTo: VALID_TO,
    scene: 'planned_shutdown',
    startMonth: null,
    endMonth: null,
    threshold: 16,
    windowDays: 3,
    definitionBasis:
      '标书 1.2.10 计划性停水停气：3 日窗口内停气问题(g06)诉求量达到阈值预警。基数为全库 g06 日均 2.56 件→3 日 7.68 件，取 2 倍并向上取整 = 16 件。',
    definitionConfirmed: true,
    enabled: true,
  },
  {
    ruleId: 'alert-planned-shutdown-water',
    kind: 'alert',
    name: '预警 · 计划性停水期间停水诉求(3日窗口)',
    businessType: 'water',
    dictionaryVersion: DICT_VERSION,
    majorCodes: [],
    minorCodes: ['w01'],
    effectiveFrom: VALID_FROM,
    effectiveTo: VALID_TO,
    scene: 'planned_shutdown',
    startMonth: null,
    endMonth: null,
    threshold: 29,
    windowDays: 3,
    definitionBasis:
      '标书 1.2.10 计划性停水停气：3 日窗口内城镇停水问题(w01)诉求量达到阈值预警。基数为全库 w01 日均 4.75 件→3 日 14.25 件，取 2 倍并向上取整 = 29 件。',
    definitionConfirmed: true,
    enabled: true,
  },
];

async function main() {
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const login = await loginRes.json();
  const token = login?.data?.token;
  if (!token) throw new Error(`登录失败: ${JSON.stringify(login).slice(0, 200)}`);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  for (const rule of rules) {
    // 已存在则跳过（幂等）
    const listRes = await fetch(`${BASE}/api/v1/business-rules`, { headers: auth });
    const list = await listRes.json();
    const exists = (list?.data ?? []).find((r) => r?.input?.ruleId === rule.ruleId);
    let editVersion;
    if (exists) {
      const body = { ...rule, expectedVersion: exists.editVersion };
      const saveRes = await fetch(`${BASE}/api/v1/business-rules`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const save = await saveRes.json();
      if (!saveRes.ok) { console.log(`✗ ${rule.ruleId} 保存失败: ${JSON.stringify(save).slice(0, 300)}`); continue; }
      editVersion = save.data.editVersion;
      console.log(`~ ${rule.ruleId} 已存在，更新到 editVersion=${editVersion}`);
    } else {
      const saveRes = await fetch(`${BASE}/api/v1/business-rules`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...rule, expectedVersion: 0 }),
      });
      const save = await saveRes.json();
      if (!saveRes.ok) { console.log(`✗ ${rule.ruleId} 保存失败: ${JSON.stringify(save).slice(0, 300)}`); continue; }
      editVersion = save.data.editVersion;
      console.log(`+ ${rule.ruleId} 已创建 editVersion=${editVersion}`);
    }
    const pubRes = await fetch(`${BASE}/api/v1/business-rules/${rule.ruleId}/publish`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ expectedVersion: editVersion }),
    });
    const pub = await pubRes.json();
    if (!pubRes.ok) { console.log(`✗ ${rule.ruleId} 发布失败: ${JSON.stringify(pub).slice(0, 300)}`); continue; }
    console.log(`  ✓ 发布 version=${pub.data.version}`);
  }

  const finalRes = await fetch(`${BASE}/api/v1/business-rules`, { headers: auth });
  const final = await finalRes.json();
  console.log(`\n最终规则数=${(final?.data ?? []).length}`);
  for (const r of final?.data ?? []) {
    console.log(` - ${r.input.ruleId} kind=${r.input.kind} scene=${r.input.scene} bt=${r.input.businessType} ` +
      `th=${r.input.threshold} win=${r.input.windowDays} 已发布版本=${r.publishedVersion}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
