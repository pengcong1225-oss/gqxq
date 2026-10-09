// Endpoint capability policy. roles is the historical built-in seed matrix;
// current HTTP requests use permissionCode plus the persisted enabled role.
// Unregistered endpoints deny effective grants, including administrator grants.
// readonly cannot mutate business; own authenticated password change is the
// narrow identity exception. Machine ingress/callbacks stay before requireAuth.
import type { PermissionCode } from './permissionCatalog';
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
  permissionCode?: PermissionCode;
  selfService?: boolean;
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
  {method:'GET',path:/^\/enterprise-reference-options$/,roles:R,permissionCode:'enterprise.read',desc:'企业维护选项（已发布字典只读）'},
  {method:'GET',path:/^\/enterprise-options$/,roles:R,permissionCode:'enterprise.read',desc:'登记目标最小选单'},
  {method:'POST',path:/^\/enterprises$/,roles:A,permissionCode:'enterprise.manage',desc:'企业新增'},
  {method:'PATCH',path:/^\/enterprises\/[^/]+$/,roles:A,permissionCode:'enterprise.manage',desc:'企业维护'},
  {method:'GET',path:/^\/enterprises\/[^/]+\/(households|department-mappings)$/,roles:R,permissionCode:'enterprise.read',desc:'企业经营历史'},
  {method:'POST',path:/^\/enterprises\/[^/]+\/(households|department-mappings)$/,roles:A,permissionCode:'enterprise.manage',desc:'企业经营数据维护'},

  {method:'GET',path:/^\/categories$/,roles:R,permissionCode:'dict.read',desc:'正式分类可选项'},
  {method:'POST',path:/^\/complaints\/[^/]+\/category$/,roles:W,permissionCode:'complaint.correct',desc:'正式分类纠偏'},
  {method:'GET',path:/^\/complaints\/[^/]+\/category-history$/,roles:R,permissionCode:'complaint.read',desc:'正式分类修订'},
  ...(['GET','POST'] as const).map(method=>({method,path:/^\/dict-types$/,roles:A,permissionCode:'system.dict.manage' as const,desc:'通用字典类型管理'})),
  ...(['PATCH','DELETE'] as const).map(method=>({method,path:/^\/dict-types\/[^/]+$/,roles:A,permissionCode:'system.dict.manage' as const,desc:'字典类型维护'})),
  ...(['GET','POST'] as const).map(method=>({method,path:/^\/dict-types\/[^/]+\/items$/,roles:A,permissionCode:'system.dict.manage' as const,desc:'字典条目管理'})),
  ...(['PATCH','DELETE'] as const).map(method=>({method,path:/^\/dict-types\/[^/]+\/items\/[^/]+$/,roles:A,permissionCode:'system.dict.manage' as const,desc:'字典条目维护'})),
  {method:'GET',path:/^\/dict-types\/[^/]+\/items\/[^/]+\/references$/,roles:A,permissionCode:'system.dict.manage',desc:'字典条目可见引用'},
  {method:'GET',path:/^\/dict-types\/[^/]+\/references$/,roles:A,permissionCode:'system.dict.manage',desc:'字典类型可见引用'},
  {method:'GET',path:/^\/audit-logs$/,roles:A,permissionCode:'system.audit.read',desc:'A6 登录与操作日志列表'},
  {method:'GET',path:/^\/audit-logs\/[^/]+$/,roles:A,permissionCode:'system.audit.read',desc:'A6 安全审计详情与当前对象范围'},
  {method:'GET',path:/^\/users\/[^/]+\/scopes$/,roles:A,permissionCode:'system.users.manage',desc:'U4 读取用户数据范围'},
  {method:'PUT',path:/^\/users\/[^/]+\/scopes$/,roles:A,permissionCode:'system.users.manage',desc:'U5 配置用户数据范围'},
  {method:'GET',path:/^\/complaints\/[^/]+\/source-document$/,roles:A,permissionCode:'source_document.read',desc:'R24 来源原件（显式能力与对象范围）'},
  {method:'POST',path:/^\/auth\/change-password$/,roles:R,selfService:true,desc:'本人改密'},
  {method:'POST',path:/^\/users\/[^/]+\/reset-password$/,roles:A,permissionCode:'system.users.manage',desc:'管理员重置口令'},
  {method:'GET',path:/^\/roles$/,roles:A,permissionCode:'system.roles.manage',desc:'角色列表'},
  {method:'POST',path:/^\/roles$/,roles:A,permissionCode:'system.roles.manage',desc:'创建角色'},
  {method:'PATCH',path:/^\/roles\/[^/]+$/,roles:A,permissionCode:'system.roles.manage',desc:'修改角色'},
  {method:'GET',path:/^\/permissions$/,roles:A,permissionCode:'system.roles.manage',desc:'权限目录'},
  // ---------- S：身份自查询（三档皆放，只看自己） ----------
  { method: 'GET', path: new RegExp('^/auth/user-info$'), roles: R, selfService: true, desc: 'S1 当前登录用户信息' },

  // ---------- R：读端点（23 条） ----------
  { method: 'GET', path: new RegExp('^/complaints$'), roles: R, permissionCode: 'complaint.read', desc: 'R1 诉求总账列表' },
  { method: 'GET', path: new RegExp('^/complaints/' + param + '$'), roles: R, permissionCode: 'complaint.read', desc: 'R2 诉求详情' },
  { method: 'GET', path: new RegExp('^/complaints/' + param + '/timeline$'), roles: R, permissionCode: 'complaint.read', desc: 'R3 诉求时间线' },
  { method: 'GET', path: new RegExp('^/complaints/' + param + '/corrections$'), roles: R, permissionCode: 'complaint.read', desc: 'R4 单条纠偏清单' },
  { method: 'GET', path: new RegExp('^/enterprises$'), roles: R, permissionCode: 'enterprise.read', desc: 'R5 企业主数据列表' },
  { method: 'GET', path: new RegExp('^/enterprises/' + param + '$'), roles: R, permissionCode: 'enterprise.read', desc: 'R6 企业详情' },
  { method: 'GET', path: new RegExp('^/dashboard/overview$'), roles: R, permissionCode: 'dashboard.read', desc: 'R7 数据大屏' },
  { method: 'GET', path: new RegExp('^/dicts/' + param + '/items$'), roles: R, permissionCode: 'dict.read', desc: 'R8 通用字典项只读查询' },
  { method: 'GET', path: new RegExp('^/dispatch/orders$'), roles: R, permissionCode: 'dispatch.read', desc: 'R9 交办列表' },
  { method: 'GET', path: new RegExp('^/dispatch/orders/' + param + '$'), roles: R, permissionCode: 'dispatch.read', desc: 'R10 交办详情' },
  { method: 'GET', path: new RegExp('^/dispatch/orders/' + param + '/push-logs$'), roles: R, permissionCode: 'dispatch.read', desc: 'R11 推送留痕' },
  { method: 'GET', path: new RegExp('^/dispatch/orders/' + param + '/approval-trace$'), roles: R, permissionCode: 'dispatch.read', desc: 'R12 审批轨迹' },
  { method: 'GET', path: new RegExp('^/corrections/pending$'), roles: R, permissionCode: 'complaint.read', desc: 'R13 待纠偏队列' },
  { method: 'GET', path: new RegExp('^/corrections/pending-complaints$'), roles: R, permissionCode: 'complaint.read', desc: 'R23 诉求级待纠偏列表' },
  { method: 'GET', path: new RegExp('^/analysis/records$'), roles: R, permissionCode: 'analysis.read', desc: 'R14 分析库列表' },
  { method: 'GET', path: new RegExp('^/analysis/records/' + param + '$'), roles: R, permissionCode: 'analysis.read', desc: 'R15 分析下钻' },
  { method: 'GET', path: new RegExp('^/report-todos$'), roles: R, permissionCode: 'report.read', desc: 'R16 待查报告待办' },
  { method: 'GET', path: new RegExp('^/source-status$'), roles: R, permissionCode: 'source_status.read', desc: 'R17 来源适配器状态' },
  { method: 'GET', path: new RegExp('^/grids$'), roles: R, permissionCode: 'grid.read', desc: 'R18 网格（501 桩，放行后仍 501）' },
  { method: 'GET', path: new RegExp('^/shutdowns$'), roles: R, permissionCode: 'shutdown.read', desc: 'R19 停供（501 桩）' },
  { method: 'GET', path: new RegExp('^/pipeline-projects$'), roles: R, permissionCode: 'pipeline.read', desc: 'R20 管道施工（501 桩）' },
  { method: 'GET', path: new RegExp('^/reports$'), roles: R, permissionCode: 'report.read', desc: 'R21 分析报告（501 桩）' },
  { method: 'GET', path: new RegExp('^/heatmap/data$'), roles: R, permissionCode: 'heatmap.read', desc: 'R22 热力图（501 桩）' },

  // ---------- W：业务写端点（13 条，readonly 一律 403） ----------
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/assignment$'), roles: W, permissionCode: 'complaint.assign', desc: 'W1 匹配/调整责任单位' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/disposition$'), roles: W, permissionCode: 'complaint.disposition', desc: 'W2 归库（无需交办/误报）' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/corrections/generate$'), roles: W, permissionCode: 'complaint.correct', desc: 'W3 生成纠偏待办' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/close$'), roles: W, permissionCode: 'complaint.close', desc: 'W4 本系统办结' },
  { method: 'POST', path: new RegExp('^/complaints/' + param + '/source-sync$'), roles: W, permissionCode: 'complaint.source_sync', desc: 'W5 来源状态回填' },
  { method: 'POST', path: new RegExp('^/corrections/generate-batch$'), roles: W, permissionCode: 'complaint.correct', desc: 'W6 批量补挂纠偏待办' },
  { method: 'POST', path: new RegExp('^/corrections/' + param + '/confirm$'), roles: W, permissionCode: 'complaint.correct', desc: 'W7 纠偏确认' },
  { method: 'POST', path: new RegExp('^/corrections/' + param + '/reject$'), roles: W, permissionCode: 'complaint.correct', desc: 'W8 判定无需纠偏' },
  { method: 'POST', path: new RegExp('^/dispatch/orders$'), roles: W, permissionCode: 'dispatch.create', desc: 'W9 创建交办' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/cancel$'), roles: W, permissionCode: 'dispatch.cancel', desc: 'W10 受控撤销（basis 必填 + 到人）' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/push$'), roles: W, permissionCode: 'dispatch.push', desc: 'W11 推送交办' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/repush$'), roles: W, permissionCode: 'dispatch.push', desc: 'W12 重推交办' },
  { method: 'POST', path: new RegExp('^/dispatch/orders/' + param + '/archive$'), roles: W, permissionCode: 'dispatch.archive', desc: 'W13 交办归档' },

  {method:'POST',path:new RegExp('^/dispatch/orders/'+param+'/preflight$'),roles:W,permissionCode: 'dispatch.push', desc:'integration readiness'},
  {method:'GET',path:new RegExp('^/dispatch/orders/'+param+'/reporting-result$'),roles:R,permissionCode: 'dispatch.read', desc:'authorized reporting result'},
  {method:'GET',path:new RegExp('^/dispatch/orders/'+param+'/reporting-attachments/'+param+'$'),roles:R,permissionCode: 'dispatch.read', desc:'authorized reporting attachment'},
  {method:'POST',path:new RegExp('^/dispatch/orders/'+param+'/reconcile$'),roles:W,permissionCode: 'dispatch.reconcile', desc:'integration reconciliation'},
  // ---------- U / X：admin 独占 ----------
  { method: 'GET', path: new RegExp('^/users$'), roles: A, permissionCode: 'system.users.manage', desc: 'U1 用户列表（原 501 桩已摘除）' },
  { method: 'POST', path: new RegExp('^/users$'), roles: A, permissionCode: 'system.users.manage', desc: 'U2 建号（bcrypt 入库，口令不回显）' },
  { method: 'PATCH', path: new RegExp('^/users/' + param + '$'), roles: A, permissionCode: 'system.users.manage', desc: 'U3 改角色/姓名/启停（无删除端点）' },
  { method: 'GET', path: new RegExp('^/dicts/sensitive-words$'), roles: A, permissionCode: 'system.dict.manage', desc: 'D1 敏感词管理列表' },
  { method: 'POST', path: new RegExp('^/dicts/sensitive-words$'), roles: A, permissionCode: 'system.dict.manage', desc: 'D2 新增敏感词' },
  { method: 'PATCH', path: new RegExp('^/dicts/sensitive-words/' + param + '$'), roles: A, permissionCode: 'system.dict.manage', desc: 'D3 编辑/启停敏感词' },
  { method: 'POST', path: new RegExp('^/dicts/sensitive-words/rescan-preview$'), roles: A, permissionCode: 'system.dict.manage', desc: 'D4 历史重扫预览' },
  { method: 'POST', path: new RegExp('^/dicts/sensitive-words/rescan$'), roles: A, permissionCode: 'system.dict.manage', desc: 'D5 确认历史重扫' },
  { method: 'POST', path: new RegExp('^/address-candidates/backfill-preview$'), roles: A, permissionCode: 'system.address.backfill', desc: '地址候选存量预览' },
  { method: 'POST', path: new RegExp('^/address-candidates/backfill$'), roles: A, permissionCode: 'system.address.backfill', desc: '地址候选存量补提取' },
  { method: 'POST', path: new RegExp('^/external/tianbao/status-callback$'), roles: A, permissionCode: 'system.integration.manage', desc: 'X1 旧轮询回调（501 桩；它在 requireAuth 之后，仍需 Bearer）' },
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

/** Identity self-service, forced-change restriction, readonly business-write
 * invariant, then the registered endpoint's effective capability. */
export function isAllowed(user: AuthUser, method: string, rawPath: string): AccessDecision {
  const rule = matchRule(method, rawPath);
  const allowedRoles = rule?.roles ?? DEFAULT_DENY_ROLES;
  const deny = (reason: string): AccessDecision => ({allowed:false,reason,allowedRoles});
  if (rule?.selfService) return {allowed:true,reason:'已认证本人身份服务',allowedRoles};
  if (user.mustChangePassword) return deny('需要先修改初始或重置口令');
  if (user.roles.includes(ROLE_READONLY) && method !== 'GET') return deny('readonly 禁止业务写入');
  // Production requireAuth always supplies permissionCodes. Legacy pure callers retain
  // the original matrix; custom role labels never get this fallback.
  if (user.permissionCodes !== undefined) {
    if (!rule || !rule.permissionCode) return deny('端点未登记权限，默认拒绝');
    const protectedCode = rule.permissionCode === 'system.users.manage' || rule.permissionCode === 'system.roles.manage';
    if (protectedCode && !user.roles.includes(ROLE_ADMIN)) return deny('受保护的管理员配置');
    const allowed = user.permissionCodes.includes(rule.permissionCode);
    return {allowed,reason:allowed ? '命中权限 '+rule.permissionCode : '缺少端点权限',allowedRoles};
  }
  if (user.roles.includes(ROLE_ADMIN)) return {allowed:true,reason:'兼容内置管理员策略',allowedRoles};
  const hit = allowedRoles.some(role => user.roles.includes(role));
  return {allowed:hit,reason:hit ? '兼容内置角色策略' : '缺少端点权限',allowedRoles};
}

export function builtinPermissionCodes(roleCode: string): PermissionCode[] {
  if (roleCode === ROLE_ADMIN) return [...new Set(ROLE_POLICY.flatMap(r => r.permissionCode ? [r.permissionCode] : []))];
  return [...new Set(ROLE_POLICY.filter(r => r.roles.includes(roleCode as Role) &&
    (roleCode !== ROLE_READONLY || r.method === 'GET')).flatMap(r => r.permissionCode ? [r.permissionCode] : []))];
}
