// 角色 × 路由 × 方法 策略表 —— 后端鉴权的**唯一真源**。
//
// 与 docs/2026-09-21-角色权限映射.md 逐条对应（编号 P/S/R/W/U/D/X 保留在 desc 里，
// 便于文档与代码互相定位）。verify:rbac 会断言本表的条目数与文档端点数一致。
//
// 交付纪律（红线，改动前必读）：
//   1) **默认拒绝**：新增路由如果没有在下面的 ROLE_POLICY 里加一条，
//      isAllowed() 会按「仅 admin」处理 —— 表现为 handler / readonly 拿 403，
//      而不是"谁都能调"。加功能时同步加策略行，是路由改动的一部分，不是可选项。
//   2) 机器对机器端点（P3 宜接就办入站、P4 公网回调）**不在本表**：
//      它们在 routes/index.ts 里挂在 requireAuth 之前，靠网络边界 / 签名鉴权，
//      不发放平台账号，因此也不参与角色判定。要给用户态端点加豁免必须走评审。
//   3) readonly 只能 GET 是**代码里的硬不变量**（见 isAllowed），
//      不靠表格自觉：即使有人误加一条 roles 含 readonly 的 POST 策略也不会放开。
import type { AuthUser } from '../http/errors';

export const ROLE_ADMIN = 'admin';
export const ROLE_HANDLER = 'handler';
export const ROLE_READONLY = 'readonly';

export const ROLES = [ROLE_ADMIN, ROLE_HANDLER, ROLE_READONLY] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** 角色中文名：用户管理页与审计明细共用，避免前后端各写一份翻译 */
export const ROLE_LABELS: Record<Role, string> = {
  [ROLE_ADMIN]: '系统管理员',
  [ROLE_HANDLER]: '业务经办',
  [ROLE_READONLY]: '只读',
};

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface PolicyRule {
  method: HttpMethod;
  /** 相对挂载前缀 /api/v1 的路径；参数段统一写成 [^/]+ */
  path: RegExp;
  roles: readonly Role[];
  /** 文档编号 + 人读依据 */
  desc: string;
}

/** 读端点：三档全放（只读档的存在意义就在这里） */
const R: readonly Role[] = [ROLE_ADMIN, ROLE_HANDLER, ROLE_READONLY];
/** 业务写端点：经办可做，只读不可 */
const W: readonly Role[] = [ROLE_ADMIN, ROLE_HANDLER];
/** 管理动作：admin 独占 */
const A: readonly Role[] = [ROLE_ADMIN];

const param = '[^/]+';

export const ROLE_POLICY: readonly PolicyRule[] = [
  // ---------- S：身份自查询（三档皆放，只看自己） ----------
  { method: 'GET', path: new RegExp('^/auth/user-info$'), roles: R, desc: 'S1 当前登录用户信息' },

  // ---------- R：读端点（22 条） ----------
  { method: 'GET', path: new RegExp('^/complaints$'), roles: R, desc: 'R1 诉求总账列表' },
  { method: 'GET', path: new RegExp('^/complaints/' + param + '$'), roles: R, desc: 'R2 诉求详情' },
  { method: 'GET', path: new RegExp('^/complaints/' + param + '/timeline$'), roles: R, desc: 'R3 诉求时间线' },
  { method: 'GET', path: new RegExp('^/complaints/' + param + '/corrections$'), roles: R, desc: 'R4 单条纠偏清单' },
  { method: 'GET', path: new RegExp('^/enterprises$'), roles: R, desc: 'R5 企业主数据列表' },
  { method: 'GET', path: new RegExp('^/enterprises/' + param + '$'), roles: R, desc: 'R6 企业详情' },
  { method: 'GET', path: new RegExp('^/dashboard/overview$'), roles: R, desc: 'R7 数据大屏' },
  { method: 'GET', path: new RegExp('^/dicts/' + param + '/items$'), roles: R, desc: 'R8 通用字典项只读查询' },
  { method: 'GET', path: new RegExp('^/dispatch/orders$'), roles: R, desc: 'R9 交办列表' },
  { method: 'GET', path: new RegExp('^/dispatch/orders/' + param + '$'), roles: R, desc: 'R10 交办详情' },
  { method: 'GET', path: new RegExp('^/dispatch/orders/' + param + '/push-logs$'), roles: R, desc: 'R11 推送留痕' },
  { method: 'GET', path: new RegExp('^/dispatch/orders/' + param + '/approval-trace$'), roles: R, desc: 'R12 审批轨迹' },
  { method: 'GET', path: new RegExp('^/corrections/pending$'), roles: R, desc: 'R13 待纠偏队列' },
  { method: 'GET', path: new RegExp('^/analysis/records$'), roles: R, desc: 'R14 分析库列表' },
  { method: 'GET', path: new RegExp('^/analysis/records/' + param + '$'), roles: R, desc: 'R15 分析下钻' },
  { method: 'GET', path: new RegExp('^/report-todos$'), roles: R, desc: 'R16 待查报告待办' },
  { method: 'GET', path: new RegExp('^/source-status$'), roles: R, desc: 'R17 来源适配器状态' },
  { method: 'GET', path: new RegExp('^/grids$'), roles: R, desc: 'R18 网格（501 桩，放行后仍 501）' },
  { method: 'GET', path: new RegExp('^/shutdowns$'), roles: R, desc: 'R19 停供（501 桩）' },
  { method: 'GET', path: new RegExp('^/pipeline-projects$'), roles: R, desc: 'R20 管道施工（501 桩）' },
  { method: 'GET', path: new RegExp('^/reports$'), roles: R, desc: 'R21 分析报告（501 桩）' },
  { method: 'GET', path: new RegExp('^/heatmap/data$'), roles: R, desc: 'R22 热力图（501 桩）' },

  // ---------- W：业务写端点（13 条，readonly 一律 403） ----------
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/assignment$'), roles: W, desc: 'W1 匹配/调整责任单位' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/disposition$'), roles: W, desc: 'W2 归库（无需交办/误报）' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/corrections/generate$'), roles: W, desc: 'W3 生成纠偏待办' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/close$'), roles: W, desc: 'W4 本系统办结' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/source-sync$'), roles: W, desc: 'W5 来源状态回填' },
  { method: 'POST', path: new RegExp('^/corrections/generate-batch$'), roles: W, desc: 'W6 批量补挂纠偏待办' },
  { method: 'POST', path: new RegExp('^/corrections/' + param + '/confirm$'), roles: W, desc: 'W7 纠偏确认' },
  { method: 'POST', path: new RegExp('^/corrections/' + param + '/reject$'), roles: W, desc: 'W8 判定无需纠偏' },
  { method: 'POST', path: new RegExp('^/dispatch/orders$'), roles: W, desc: 'W9 创建交办' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/cancel$'), roles: W, desc: 'W10 受控撤销（basis 必填 + 到人）' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/push$'), roles: W, desc: 'W11 推送交办' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/repush$'), roles: W, desc: 'W12 重推交办' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/archive$'), roles: W, desc: 'W13 交办归档' },

  // ---------- U / X：admin 独占 ----------
  { method: 'GET', path: new RegExp('^/users$'), roles: A, desc: 'U1 用户列表（原 501 桩已摘除）' },
  { method: 'POST', path: new RegExp('^/users$'), roles: A, desc: 'U2 建号（bcrypt 入库，口令不回显）' },
  { method: 'PATCH', path: new RegExp('^/users/' + param + '$'), roles: A, desc: 'U3 改角色/姓名/启停（无删除端点）' },
  { method: 'GET', path: new RegExp('^/dicts/sensitive-words$'), roles: A, desc: 'D1 敏感词管理列表' },
  { method: 'POST', path: new RegExp('^/dicts/sensitive-words$'), roles: A, desc: 'D2 新增敏感词' },
  { method: 'PATCH', path: new RegExp('^/dicts/sensitive-words/' + param + '$'), roles: A, desc: 'D3 编辑/启停敏感词' },
  { method: 'POST', path: new RegExp('^/dicts/sensitive-words/rescan-preview$'), roles: A, desc: 'D4 历史重扫预览' },
  { method: 'POST', path: new RegExp('^/dicts/sensitive-words/rescan$'), roles: A, desc: 'D5 确认历史重扫' },
  { method: 'POST', path: new RegExp('^/external/tianbao/status-callback$'), roles: A, desc: 'X1 旧轮询回调（501 桩；它在 requireAuth 之后，仍需 Bearer）' },
];

/** 未声明端点的有效角色集合 —— 默认拒绝，等价于 admin-only */
const DEFAULT_DENY_ROLES: readonly Role[] = [ROLE_ADMIN];

/** 去掉尾部斜杠：Express 默认非严格路由，/users/ 与 /users 命中同一条 handler */
function normalizePath(rawPath: string): string {
  const stripped = rawPath.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

export function matchRule(method: string, rawPath: string): PolicyRule | null {
  const path = normalizePath(rawPath);
  for (const rule of ROLE_POLICY) {
    if (rule.method !== method) continue;
    if (rule.path.test(path)) return rule;
  }
  return null;
}

export interface AccessDecision {
  allowed: boolean;
  /** 判定依据，同时写进 403 审计的 detail，便于事后复核"为什么被拒" */
  reason: string;
  /** 该端点的有效允许角色（默认拒绝时为 ['admin']） */
  allowedRoles: readonly Role[];
}

/**
 * 角色判定。三条规则按顺序生效：
 *   1. admin 全量放行（设计口径：admin = 全部）；
 *   2. 非 GET 先剔除 readonly（硬不变量）；
 *   3. 其余按策略表；**表里没有 ⇒ 仅 admin**（默认拒绝）。
 */
export function isAllowed(user: AuthUser, method: string, rawPath: string): AccessDecision {
  const held = new Set(user.roles);
  if (held.has(ROLE_ADMIN)) {
    return { allowed: true, reason: 'admin 全量放行', allowedRoles: [ROLE_ADMIN] };
  }

  const rule = matchRule(method, rawPath);
  const allowedRoles = rule === null ? DEFAULT_DENY_ROLES : rule.roles;
  const isRead = method === 'GET';
  const candidates = isRead ? allowedRoles : allowedRoles.filter((r) => r !== ROLE_READONLY);
  const hit = candidates.find((r) => held.has(r));

  if (hit !== undefined) {
    return {
      allowed: true,
      reason: (rule === null ? '默认拒绝集合' : '策略 ' + rule.desc) + ' 命中角色 ' + hit,
      allowedRoles,
    };
  }
  const basis = rule === null
    ? '端点未在 ROLE_POLICY 声明 ⇒ 默认拒绝（视同 admin-only）'
    : '策略 ' + rule.desc + ' 允许 ' + allowedRoles.join('/') + (isRead ? '' : '（非 GET 已剔除 readonly）');
  return {
    allowed: false,
    reason: basis + '；调用方角色 ' + (user.roles.length > 0 ? user.roles.join('/') : '(无)'),
    allowedRoles,
  };
}
