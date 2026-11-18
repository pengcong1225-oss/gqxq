import 'dotenv/config';
import {pool, closePool} from '../src/db/pool';
import {resolveAuthorizationFrom} from '../src/repositories/roleRepo';
import {readUserScope} from '../src/repositories/userScopeRepo';
import {saveBusinessRule, publishBusinessRule} from '../src/services/businessRuleService';

const APPLY = process.argv.includes('--apply');
const RULE_ID = 'alert-gas-three-piece-installation';

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
  access: { userId, roles: auth.roleCodes, scopeVersion: scope.scopeVersion, rules: scope.rules, canReadSource: auth.permissionCodes.includes('source_document_read') },
};

const basis = [
  '标书 1.2.10「数据预警」第四场景：燃气三件套安装。',
  '业主口径确认（2026-11-18，诉求平台验收沟通）：',
  '① 三件套=可燃气体报警器+燃气自闭阀+金属波纹软管（含熄火保护等相关装置）；',
  '② 场景=三件套安装推进与收费争议相关的诉求量预警；',
  '③ 分类映射=正式分类字典 v20 小类 g01 燃气服务问题投诉、g02 燃气费用问题投诉（含捆绑销售）、g04 燃气报装点火问题、g05 燃气报损报修问题；',
  '④ 窗口=7 日；阈值=近两年周均×1.5 取整。',
  '阈值校准依据（gqxq_service 只读实测 2026-11-18）：2025-01-01~2026-11-12 共 98 个自然周，上述四小类燃气诉求合计 8,640 件，周均 88.16 件；×1.5=132.2 → 取整 133 件/7 日。同期周量分位：中位 76、P90 153、P95 167、峰值 304，故 133 落在 P90 附近，属"显著高于常态"而非长期常态。',
  '判断限制：本规则只按正式分类计数，不按正文关键词过滤；关键词口径（三件套/报警器/自闭阀/金属软管/波纹管/熄火保护）近两年仅 347 件，若按关键词计阈值将降至个位数，且规则引擎不支持关键词，故未采用。',
].join('');

const input = {
  ruleId: RULE_ID,
  kind: 'alert',
  expectedVersion: 0,
  name: '预警 · 燃气三件套安装推进与收费争议(7日窗口)',
  businessType: 'gas',
  dictionaryVersion: '20',
  majorCodes: [],
  minorCodes: ['g01','g02','g04','g05'],
  effectiveFrom: '2025-01-01',
  effectiveTo: '2027-12-31',
  scene: 'gas_three_piece',
  startMonth: null,
  endMonth: null,
  threshold: 133,
  windowDays: 7,
  definitionBasis: basis,
  definitionConfirmed: true,
  enabled: true,
};

if (!APPLY) {
  console.log(JSON.stringify({mode:'dry-run', rule:input, publishAfterSave:true}, null, 2).slice(0, 3000));
} else {
  const saved = await saveBusinessRule(input, ctx);
  console.log('saved', JSON.stringify(saved));
  const published = await publishBusinessRule(RULE_ID, saved.editVersion, ctx);
  console.log('published', JSON.stringify(published));
  const [rows] = await pool.query('select rule_id, version, kind, published_at from business_rule_version where rule_id=? order by version', [RULE_ID]);
  console.log('versions', JSON.stringify(rows));
}
await closePool();