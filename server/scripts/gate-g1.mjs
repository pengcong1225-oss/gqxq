#!/usr/bin/env node
/**
 * gate-g1.mjs — 诉求平台 G1 批次门禁脚本
 *
 * 零第三方依赖，只用 node: 内置模块。
 *
 * 规格来源：
 *   docs/2026-09-17-诉求平台G1详细实施方案.md §8.3（正则规则表 + 结构约束）
 *   docs/2026-09-17-gqxq_service现状核对与G1迁移设计.md §5 末行（新增两条规则）
 *
 * 用法：
 *   node server/scripts/gate-g1.mjs           人读输出
 *   node server/scripts/gate-g1.mjs --json    机器可读 JSON（stdout 只有 JSON）
 *
 * 退出码：存在 fail 级违规 -> 1；否则 0（warn 级不影响退出码）
 *
 * 行内豁免：某一行包含 gate-g1-allow 时该行整体跳过。仅用于"设计上就该 drop"的
 *   回滚迁移，例如：  await knex.schema.dropColumn('x'); // gate-g1-allow
 *   注意：豁免必须写在同一行，且是显式的人工决定。
 *
 * 已知取舍：
 *   - 规则按 §8.3 表格逐字实现，因此"失效的规则"（例如匹配不到旧 Mock 写法）不会被放宽。
 *   - uppercase-enum-literal 是 warn 级启发式，刻意做了三重降噪：跳过纯注释/import 行、
 *     跳过 env 变量名、跳过含数字的字面量（编号前缀）与已知常量表。详见 SKIP_* 常量。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const DDL_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.sql']);

/** 扫描目标。scope 决定哪些规则生效。 */
const TARGETS = [
  { name: 'server/src', dir: join(ROOT, 'server', 'src'), ext: SOURCE_EXT, scope: 'server' },
  { name: 'packages/web-admin/src', dir: join(ROOT, 'packages', 'web-admin', 'src'), ext: SOURCE_EXT, scope: 'web' },
  { name: 'server/migrations', dir: join(ROOT, 'server', 'migrations'), ext: DDL_EXT, scope: 'ddl' },
];

/**
 * §8.3 规则表 + 迁移设计 §5 新增两条。
 * scope: 'all' 全部目标 | 'server' 仅 server/src | 'ddl' 仅 server/migrations
 */
const RULES = [
  { id: 'fake-total-1247', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /1247/, desc: '仪表盘假总量 1247' },
  { id: 'sensitive-count-fallback', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /sensitiveCount\s*\|\|\s*28/, desc: '敏感数兜底 || 28' },
  { id: 'hardcoded-resolved-rate', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /resolvedRate:\s*78\.5/, desc: '硬编码办结率 78.5' },
  { id: 'mock-complaints-array', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /mockComplaints/, desc: '前端总账 Mock 数组' },
  { id: 'mock-initial-orders', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /initialOrders/, desc: '前端交办 Mock 数组' },
  { id: 'detail-example-fallback', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /complaintData/, desc: '详情示例回退' },
  { id: 'cross-request-random-item', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /randomItem\(/, desc: '跨请求随机 randomItem()' },
  { id: 'cross-request-math-random', level: 'fail', scope: 'server', kind: 'regex',
    pattern: /Math\.random\(/,
    // 失败重试的退避抖动（sleep/backoff/jitter）不影响响应确定性，不属于本规则要拦的"跨请求随机"
    skipLineIf: /sleep\(|backoff|jitter|setTimeout/i,
    desc: '跨请求随机 Math.random()（仅 server/src；退避抖动除外）' },
  { id: 'startup-seed-array', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /Array\.from\(\{\s*length:\s*(86|200)/, desc: '启动期造数' },
  { id: 'fake-success-toast', level: 'fail', scope: 'all', kind: 'regex',
    pattern: /message\.success\('(已通过填报适配器推送交办单|已拉取填报反馈并记录 SyncLog|交办单已创建并推送至目标企业)/,
    desc: '假成功提示' },
  { id: 'destructive-ddl', level: 'fail', scope: 'ddl-and-server', kind: 'regex',
    pattern: /\bdrop\s+(table|column|index)\b|\bdropTable\s*\(|\bdropColumn\s*\(|\bdropIndex\s*\(/i,
    desc: '破坏性 DDL（drop table/column/index，针对 gqxq_service；只扫迁移 up() 段）' },
  { id: 'uppercase-enum-literal', level: 'warn', scope: 'server', kind: 'upper-enum',
    desc: '大写枚举字面量（G1 起枚举一律小写）' },
];

// 已接入真实接口、因而不需要「演示数据」横幅的页面。
// 加入白名单的前提是该页确实不再展示本地示例数据（G2 起 DispatchOrders 已改为真查 /dispatch/orders）。
const VIEW_WHITELIST = new Set([
  'ComplaintList',
  'ComplaintDetail',
  'Dashboard',
  'Login',
  'DispatchOrders',
  // G5：以下四页已改为真实接口驱动，并移除了「演示数据」横幅
  'AddressCorrection',
  'DispatchArchive',
  'ReportView',
  'Analysis',
  // Task #35：系统管理页从 Mock 换成真接口（GET/POST/PATCH /users），
  // 且旧「操作日志」页签是**撤下**而非留假数据（读审计的接口本批不做，见映射表 §5）。
  'UserManager',
]);
const DEMO_MARKER = 'DemoDataNotice';

/**
 * 在**已显式声明演示数据**的页面里可以豁免的规则。
 *
 * 设计意图：交付纪律要拦的是"静默的 Mock 回退"——接口失败悄悄回落本地数组、
 * 或在没有标注的页面上直接摆假数字。而挂了 DemoDataNotice 横幅的页面，
 * 已经对用户明示"这是演示数据、不代表真实业务数据"，属于**可审计的声明**，
 * 不是隐性欺骗。因此这些页面里的本地示例字面量豁免；但 fake-success-toast 不豁免——
 * "操作成功"的假提示即使有横幅也仍然是在骗人（交付纪律第 2 条）。
 *
 * 注意：这不等于放宽。structural 规则仍然要求每个非白名单 view 必须带该标记，
 * 所以"页面既没接真实数据、又没声明演示"依然会被拦下。
 */
const DEMO_SUPPRESSIBLE_RULES = new Set([
  'mock-complaints-array',
  'mock-initial-orders',
  'detail-example-fallback',
  'fake-total-1247',
  'hardcoded-resolved-rate',
  'startup-seed-array',
  'cross-request-random-item',
]);
const MAX_MATCHES_PER_RULE_FILE = 50;

/* ---------------- uppercase-enum-literal 的降噪表 ---------------- */

const UPPER_QUOTED = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;
const UPPER_ENUM_RE = /^[A-Z][A-Z0-9_]*$/;
const ENV_PREFIX_RE = /^(GQXQ|PUBLIC|NODE|MYSQL|VITE|LEGACY|TIANBAO|MIGRATION|DSH|NPM|PNPM|CI|JAVA|SPRING)_/;

/** 出现在这些读取环境变量的调用里的大写字面量，按环境变量名处理，不算枚举。 */
const ENV_HELPER_RE = /\b(?:opt|env|envOr|getEnv|readEnv|requireEnv|process\.env|import\.meta\.env)\s*\(/;

/** 常见常量 / 协议名 / SQL 关键字 / 本仓库已知编号前缀 —— 均不视为枚举。 */
const UPPER_ALLOW = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT',
  'OK', 'ID', 'URL', 'URI', 'API', 'JSON', 'SQL', 'HTTP', 'HTTPS', 'UTF', 'UTF8', 'ASCII',
  'UTC', 'GMT', 'ISO', 'JWT', 'HMAC', 'CORS', 'CSRF', 'SSO', 'CLI', 'SDK', 'UI', 'UX',
  'IP', 'DNS', 'TLS', 'SSL', 'UUID', 'GUID', 'MD5', 'SHA', 'SHA256', 'BASE64', 'HEX',
  'CSV', 'PDF', 'HTML', 'XML', 'PNG', 'JPEG', 'JPG', 'WEBP', 'GIF', 'SVG',
  'CRUD', 'REST', 'RPC', 'ORM', 'DDL', 'DML', 'DCL', 'FK', 'PK', 'DB', 'DAO', 'DTO',
  'CPU', 'RAM', 'IO', 'QPS', 'TPS', 'RTT', 'TTL', 'CDN', 'WAF', 'VPC',
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'AS', 'ON', 'BY', 'TO', 'OF', 'IF', 'THEN',
  'ELSE', 'END', 'CASE', 'WHEN', 'SELECT', 'INSERT', 'UPDATE', 'FROM', 'WHERE',
  'CREATE', 'ALTER', 'TABLE', 'INDEX', 'KEY', 'PRIMARY', 'UNIQUE', 'DROP', 'JOIN',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ORDER', 'GROUP', 'LIMIT', 'OFFSET', 'VALUES',
  'INTO', 'SET', 'ENGINE', 'CHARSET', 'COLLATE', 'COMMENT', 'DEFAULT', 'EXISTS',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'BETWEEN', 'LIKE', 'ASC', 'DESC', 'HAVING',
  'DISTINCT', 'UNION', 'AUTO_INCREMENT', 'CURRENT_TIMESTAMP',
  'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'TODO', 'FIXME', 'NOTE',
  // 本仓库的错误码常量（http/errors.ts 的 ERROR_STATUS 键），不是业务枚举
  'FORBIDDEN', 'UNAUTHENTICATED', 'VALIDATION_FAILED', 'NOT_FOUND', 'DUPLICATE_CONFLICT',
  'INVALID_STATE_TRANSITION', 'PAYLOAD_TOO_LARGE', 'INTERNAL_ERROR', 'NOT_IMPLEMENTED',
  // 本仓库的错误码常量（http/errors.ts 的 ERROR_STATUS 键）
  'SOURCE_ADAPTER_UNAVAILABLE',
  // public-utility 契约里的审批结论与通用冲突码（外部协议固定大写，见落地计划 §3.2）
  'AGREED', 'DISAGREED', 'RETURNED', 'CONFLICT',
  // Node 进程信号
  'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGQUIT',
  // 本仓库已知编号前缀（非枚举）。AREQ 是 G2 交办幂等请求号、USR 是 Task #35 的
  // app_user.user_id 业务键前缀（均为 allocateBizNo 的 prefix 参数）。
  'GRID', 'CPL', 'ASGN', 'YJJB', 'SZRX', 'WLYQ', 'WG', 'JB', 'CS', 'SD', 'PJ', 'AREQ', 'USR',
  // 常见环境变量名（不是枚举）
  'PORT', 'HOST', 'HOSTNAME', 'TZ', 'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LOG_LEVEL',
]);

/* ---------------- 工具函数 ---------------- */

function walk(dir, extSet, out) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extSet, out);
    else if (entry.isFile() && extSet.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function resolveScope(scope, targetScope) {
  if (scope === 'all') return true;
  if (scope === 'server') return targetScope === 'server';
  if (scope === 'ddl') return targetScope === 'ddl';
  if (scope === 'ddl-and-server') return targetScope === 'ddl' || targetScope === 'server';
  return false;
}

function extractUpperEnumLiterals(line) {
  const found = [];
  UPPER_QUOTED.lastIndex = 0;
  let m;
  while ((m = UPPER_QUOTED.exec(line)) !== null) {
    const value = m[1] !== undefined ? m[1] : m[2];
    if (!value || value.length < 3) continue;
    if (!UPPER_ENUM_RE.test(value)) continue;
    if (UPPER_ALLOW.has(value)) continue;
    if (ENV_PREFIX_RE.test(value)) continue;
    if (/^ER_/.test(value)) continue;              // MySQL 错误码（ER_DUP_ENTRY 等）
    // public-utility 跨系统契约**本身就用大写**：错误码、回调码、事件类型。
    // 这些是外部协议的固定字符串，不是我们数据模型里的业务枚举（我们的业务枚举一律小写）。
    if (/^INTEGRATION_/.test(value)) continue;     // INTEGRATION_REPLAY / INTEGRATION_AUTHENTICATION_FAILED
    if (/^CALLBACK_/.test(value)) continue;        // CALLBACK_ACK_INVALID 等
    if (/^TASK_/.test(value)) continue;            // TASK_SUBMITTED / TASK_APPROVED / TASK_RETURNED / TASK_REJECTED
    // operation_audit_log.action 是自由文本的动作名（LOGIN / INTAKE_CREATE），
    // 不是数据模型里的枚举列，不纳入"枚举一律小写"的范围
    if (new RegExp("action\\s*:\\s*['\"]" + value + "['\"]").test(line)) continue;
    if (/\d/.test(value)) continue;                 // 编号前缀 / 版本号
    if (/process\.env|import\.meta\.env|\benv\./.test(line)) continue;
    if (ENV_HELPER_RE.test(line)) continue;
    found.push(value);
  }
  return found;
}

function isCommentOrImportLine(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) return true;
  if (t.startsWith('import ') || t.includes("from '")) return true;
  return false;
}

function truncate(text, max) {
  const t = text.replace(/\s+$/, '');
  return t.length > max ? t.slice(0, max) + ' …' : t;
}

/**
 * 迁移文件里 destructive-ddl 只应作用于 up() 段：
 * down() 里的 drop 是设计要求的回滚动作（见迁移设计 §4.6），不是破坏性变更。
 * 用「行区间」而不是「整文件豁免」，这样一段真正破坏性的 up() 无法靠注释蒙混过关。
 * 无法判定 up() 位置时返回 null，表示不做过滤（保守：规则照常全文件生效）。
 */
function computeUpLineSet(lines) {
  const upRe = /exports\.up\s*=|export\s+(async\s+)?function\s+up\b|export\s+const\s+up\b/;
  const downRe = /exports\.down\s*=|export\s+(async\s+)?function\s+down\b|export\s+const\s+down\b/;
  let upStart = -1;
  let downStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (upStart === -1) {
      if (upRe.test(lines[i])) upStart = i;
      continue;
    }
    if (downRe.test(lines[i])) {
      downStart = i;
      break;
    }
  }
  if (upStart === -1) return null;
  const set = new Set();
  for (let i = upStart; i < downStart; i++) set.add(i);
  return set;
}

/* ---------------- 扫描 ---------------- */

const violations = [];        // { ruleId, level, file, line, text, desc }
const structuralViolations = []; // { file, desc }
const scanStats = [];
const truncated = [];         // 被截断的规则/文件

for (const target of TARGETS) {
  const files = walk(target.dir, target.ext, []);
  scanStats.push({ target: target.name, files: files.length, exists: existsSync(target.dir) });

  for (const file of files) {
    const rel = relative(ROOT, file).split('\\').join('/');
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const upLines = target.scope === 'ddl' ? computeUpLineSet(lines) : null;
    const declaredDemo = target.scope !== 'ddl' && content.includes(DEMO_MARKER);

    for (const rule of RULES) {
      if (!resolveScope(rule.scope, target.scope)) continue;
      if (declaredDemo && DEMO_SUPPRESSIBLE_RULES.has(rule.id)) continue;
      const restrictToUp = rule.id === 'destructive-ddl' && upLines !== null;
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        if (restrictToUp && !upLines.has(i)) continue;
        const line = lines[i];
        if (line.includes('gate-g1-allow')) continue;
        if (rule.skipLineIf && rule.skipLineIf.test(line)) continue;

        if (rule.kind === 'upper-enum') {
          if (isCommentOrImportLine(line)) continue;
          const found = extractUpperEnumLiterals(line);
          if (found.length === 0) continue;
          if (hits < MAX_MATCHES_PER_RULE_FILE) {
            hits++;
            violations.push({
              ruleId: rule.id,
              level: rule.level,
              file: rel,
              line: i + 1,
              text: truncate(line, 200),
              desc: rule.desc + ' -> ' + found.join(', '),
            });
          } else {
            truncated.push({ ruleId: rule.id, file: rel });
          }
          continue;
        }

        if (rule.pattern.test(line)) {
          if (hits < MAX_MATCHES_PER_RULE_FILE) {
            hits++;
            violations.push({
              ruleId: rule.id,
              level: rule.level,
              file: rel,
              line: i + 1,
              text: truncate(line, 200),
              desc: rule.desc,
            });
          } else {
            truncated.push({ ruleId: rule.id, file: rel });
          }
        }
      }
    }
  }
}

/* ---------------- 结构约束：演示数据标记 ---------------- */

const viewsDir = join(ROOT, 'packages', 'web-admin', 'src', 'views');
const viewFiles = existsSync(viewsDir)
  ? walk(viewsDir, new Set(['.tsx']), [])
  : [];

for (const file of viewFiles) {
  const name = file.split(/[\\/]/).pop().replace(/\.tsx$/, '');
  const rel = relative(ROOT, file).split('\\').join('/');
  if (VIEW_WHITELIST.has(name)) continue;
  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!content.includes(DEMO_MARKER)) {
    structuralViolations.push({
      file: rel,
      desc: '缺少 <' + DEMO_MARKER + ' /> 演示数据标记（该页尚未接入真实数据）',
    });
  }
}

/* ---------------- 汇总与输出 ---------------- */

const failViolations = violations.filter(v => v.level === 'fail');
const warnViolations = violations.filter(v => v.level === 'warn');
const counts = {
  fail: failViolations.length + structuralViolations.length,
  failRule: failViolations.length,
  failStructural: structuralViolations.length,
  warn: warnViolations.length,
};
const exitCode = counts.fail > 0 ? 1 : 0;

if (JSON_OUT) {
  const payload = {
    script: 'gate-g1.mjs',
    generatedAt: new Date().toISOString(),
    root: ROOT,
    scan: scanStats,
    viewFilesChecked: viewFiles.length,
    viewWhitelist: Array.from(VIEW_WHITELIST),
    counts,
    exitCode,
    violations,
    structuralViolations,
    truncated,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  const out = [];
  out.push('=== G1 门禁脚本 gate-g1.mjs ===');
  out.push('根目录: ' + ROOT);
  out.push('扫描: ' + scanStats.map(s => s.target + ' ' + s.files + ' 个文件' + (s.exists ? '' : '（目录不存在，跳过）')).join('；'));
  out.push('结构约束: 检查 ' + viewFiles.length + ' 个 views/*.tsx（白名单 ' + Array.from(VIEW_WHITELIST).join(', ') + '）');
  out.push('');

  out.push('--- fail 级违规（正则规则）: ' + failViolations.length + ' 条 ---');
  if (failViolations.length === 0) out.push('（无）');
  for (const v of failViolations) {
    out.push(v.file + ':' + v.line + ': ' + v.ruleId + ': ' + v.text);
  }
  out.push('');

  out.push('--- fail 级违规（结构约束）: ' + structuralViolations.length + ' 条 ---');
  if (structuralViolations.length === 0) out.push('（无）');
  for (const v of structuralViolations) {
    out.push(v.file + ': views-demo-notice: ' + v.desc);
  }
  out.push('');

  out.push('--- warn 级违规: ' + warnViolations.length + ' 条 ---');
  if (warnViolations.length === 0) out.push('（无）');
  for (const v of warnViolations) {
    out.push(v.file + ':' + v.line + ': ' + v.ruleId + ': ' + v.text);
    out.push('    ^ ' + v.desc);
  }
  out.push('');

  if (truncated.length > 0) {
    const uniq = Array.from(new Set(truncated.map(t => t.ruleId + ' @ ' + t.file)));
    out.push('提示: 以下 规则@文件 命中超过 ' + MAX_MATCHES_PER_RULE_FILE + ' 条，已截断：' + uniq.join('; '));
    out.push('');
  }

  out.push('=== 汇总 ===');
  out.push('fail: ' + counts.fail + ' 条（规则 ' + counts.failRule + ' + 结构 ' + counts.failStructural + '）');
  out.push('warn: ' + counts.warn + ' 条');
  out.push('退出码: ' + exitCode + (exitCode === 1 ? '（存在 fail 级违规）' : '（无 fail 级违规）'));
  process.stdout.write(out.join('\n') + '\n');
}

process.exit(exitCode);
