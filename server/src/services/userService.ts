// 用户与权限服务（Task #35）：三档 RBAC 的账号 CRUD 与"审计到人"。
//
// 口径（docs/2026-09-21-角色权限映射.md §3.4）：
//   * 只有 admin 能到这里（策略表 U1–U3 + routes/users.ts 的 requireRole 双重设防）；
//   * **没有删除**：禁用（status=0）代替删除。删了行，operation_audit_log 里的 user_id
//     就成了查无此人的孤号，"落到人"这条链断掉；
//   * 口令只进不出：入参经 bcrypt 落 password_hash，任何响应与审计明细都不带它；
//   * 角色是单档（roles 数组里一个值），一人多档本批不支持（映射表 §5 待裁定）。
import bcrypt from 'bcryptjs';
import { AppError } from '../http/errors';
import { pool } from '../db/pool';
import { withTransaction, type Tx } from '../db/tx';
import { allocateBizNo, shanghaiDate } from '../db/sequence';
import { insertAudit } from '../repositories/auditLogRepo';
import {
  countEnabledAdmins,
  existsUsername,
  findAdminUserByUserId,
  insertUser,
  listAdminUsers,
  toAdminUserItem,
  updateUser,
  type AdminUserRow,
} from '../repositories/userRepo';
import { isRole, ROLE_ADMIN, ROLE_LABELS, type Role } from '../auth/rolePolicy';
import { GQXQ_APP_CODE } from './intakeService';
import type { OperatorContext } from './dispatchService';
import type {
  UserAdminItem,
  UserAdminListResult,
} from '../types/api';

/** 与 seed-admin.mjs 一致的成本因子；10 是登录路径耗时可接受的下限 */
const BCRYPT_ROUNDS = 10;

/** 审计动作名沿用既有大写风格（CORRECTION_GENERATE / COMPLAINT_CLOSE 同一族） */
const ACTION_USER_CREATE = 'USER_CREATE'; // gate-g1-allow
const ACTION_USER_UPDATE = 'USER_UPDATE'; // gate-g1-allow

const RESOURCE_CODE = 'user';
const BIZ_TYPE = 'user';

/** 管理视图补上角色中文名（前端不自建翻译表） */
function toItem(row: AdminUserRow): UserAdminItem {
  const base = toAdminUserItem(row);
  return {
    ...base,
    roleNames: base.roles.map((r) => (isRole(r) ? ROLE_LABELS[r] : '未知角色:' + r)),
  };
}

export async function listUsers(
  filter: { keyword?: string; role?: Role; status?: 0 | 1 },
  page: number,
  size: number
): Promise<UserAdminListResult> {
  const result = await listAdminUsers(pool, filter, page, size);
  return {
    content: result.content.map(toItem),
    total: result.total,
    page: result.page,
    size: result.size,
    totalPages: result.totalPages,
  };
}

export interface CreateUserInput {
  username: string;
  realName: string;
  role: Role;
  password: string;
}

/**
 * 建号。发号 + 插入 + 审计在同一事务里（与 seed-admin 同一编号格式 USRyyyyMMddNNNN）。
 * username 撞库走 409：先显式查重给明确文案，唯一约束（app_user.username）
 * 兜住并发竞态 —— 捕获 ER_DUP_ENTRY 后同样回 409，绝不退化成 500。
 */
export async function createUser(input: CreateUserInput, ctx: OperatorContext): Promise<UserAdminItem> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const roles: Role[] = [input.role];
  // permissions 列本批不参与鉴权（鉴权只看 roles，见映射表 §4-6）；
  // 沿用 seed-admin 的写法给 admin 存 ['*']，其余存空数组，为未来的权限树留位。
  const permissions = input.role === ROLE_ADMIN ? ['*'] : [];

  const now = new Date();
  const createdUserId = await withTransaction(async (tx: Tx) => {
    if (await existsUsername(tx, input.username)) {
      throw AppError.conflict('用户名已存在：' + input.username);
    }
    const isoDate = shanghaiDate(now);
    const userId = await allocateBizNo(tx, 'app_user', 'USR', isoDate);
    await insertUser(tx, {
      userId,
      username: input.username,
      passwordHash,
      realName: input.realName,
      roles,
      permissions,
      now,
    });
    await writeUserAudit(tx, ctx, ACTION_USER_CREATE, userId, {
      username: input.username,
      realName: input.realName,
      role: input.role,
      status: 1,
      // 口令不进审计：只记"设过初始口令"这个事实
      passwordSet: true,
    });
    return userId;
  }).catch((err: unknown) => {
    // 唯一约束 app_user.username 兜并发竞态：撞库照样给 409，绝不退化成 500
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw AppError.conflict('用户名已存在：' + input.username);
    }
    throw err;
  });

  const row = await findAdminUserByUserId(pool, createdUserId);
  if (row === null) {
    throw AppError.internal('建号提交后回查失败：' + createdUserId);
  }
  return toItem(row);
}

export interface UpdateUserInput {
  realName?: string;
  role?: Role;
  status?: 0 | 1;
}

export interface UpdateUserResult {
  user: UserAdminItem;
  changed: string[];
}

/**
 * 局部更新（角色 / 姓名 / 启停）。防呆三条：
 *   1. **最后一个 admin 不能自弃**：目标当前是启用中的 admin，且这次改动会
 *      让他失去 admin 角色（降级或禁用），而全库只有这一个启用 admin ⇒ 409。
 *      否则系统里再没人能建号 / 改角色，把自己永久锁在门外。
 *   2. **不能禁用自己**（即使还有别的 admin）：登录态下的自我禁用几乎总是误操作。
 *   3. **不能改自己的角色**：同上，改角色应由另一位管理员执行并留痕。
 * 三条都是"宁可拒绝也不留下无人可用的库"，与不建删除端点同一动机。
 */
export async function updateUserByAdmin(
  targetUserId: string,
  input: UpdateUserInput,
  ctx: OperatorContext
): Promise<UpdateUserResult> {
  const isSelf = ctx.userId === targetUserId;
  return withTransaction(async (tx: Tx): Promise<UpdateUserResult> => {
    const target = await findAdminUserByUserId(tx, targetUserId);
    if (target === null) {
      throw AppError.notFound('用户不存在：' + targetUserId);
    }
    const wasAdmin = target.roles.includes(ROLE_ADMIN);
    const losesAdmin =
      wasAdmin &&
      ((input.role !== undefined && input.role !== ROLE_ADMIN) || input.status === 0);

    if (losesAdmin) {
      const adminCount = await countEnabledAdmins(tx);
      if (adminCount <= 1) {
        throw AppError.conflict(
          '不能禁用或降级最后一个管理员：当前启用中的 admin 只有 1 个。' +
            '请先由另一位管理员账号执行，或先建好接替的 admin。'
        );
      }
    }
    if (isSelf && input.status === 0) {
      throw AppError.conflict('不能禁用自己的账号：请由其他管理员执行禁用');
    }
    if (isSelf && input.role !== undefined && input.role !== ROLE_ADMIN && wasAdmin) {
      throw AppError.conflict('不能把自己的角色从 admin 降为其他角色：请由其他管理员执行');
    }

    const changed: string[] = [];
    if (input.realName !== undefined && input.realName !== target.realName) changed.push('realName');
    if (input.role !== undefined && !(target.roles.length === 1 && target.roles[0] === input.role)) {
      changed.push('roles');
    }
    if (input.status !== undefined && input.status !== target.status) changed.push('status');

    if (changed.length > 0) {
      await updateUser(tx, targetUserId, {
        realName: input.realName,
        roles: input.role === undefined ? undefined : [input.role],
        status: input.status,
        now: new Date(),
      });
      await writeUserAudit(tx, ctx, ACTION_USER_UPDATE, targetUserId, {
        username: target.username,
        before: { realName: target.realName, roles: target.roles, status: target.status },
        after: {
          realName: input.realName ?? target.realName,
          roles: input.role === undefined ? target.roles : [input.role],
          status: input.status ?? target.status,
        },
        changed,
      });
    }

    const fresh = await findAdminUserByUserId(tx, targetUserId);
    return { user: toItem(fresh ?? target), changed };
  });
}

/**
 * 用户管理自身的审计（目标 5「审计到人」）。
 * userId 取 ctx.userId —— 即 requireAuth 从 JWT sub 注入的**真实操作人**，
 * 不是硬编码 admin；这条记录才回答得出发没发生过、是谁发的。
 */
async function writeUserAudit(
  tx: Tx,
  ctx: OperatorContext,
  action: string,
  targetUserId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await insertAudit(tx, {
    userId: ctx.userId,
    appCode: GQXQ_APP_CODE,
    resourceCode: RESOURCE_CODE,
    action,
    bizType: BIZ_TYPE,
    bizId: targetUserId,
    result: 'success',
    clientIp: ctx.clientIp,
    detail: { ...detail, operator: ctx.userName, targetUserId },
    createdAt: new Date(),
  });
}
