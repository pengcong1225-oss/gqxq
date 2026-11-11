import bcrypt from 'bcryptjs';
import { withTransaction } from '../db/tx';
import { AppError } from '../http/errors';
import { findByUserId } from '../repositories/userRepo';
import { insertAudit } from '../repositories/auditLogRepo';
import type { OperatorContext } from './dispatchService';

const ACTION_PASSWORD_RESET = 'PASSWORD_RESET'; // gate-g1-allow: audit action follows the existing uppercase audit lineage.
const ACTION_PASSWORD_CHANGE = 'PASSWORD_CHANGE'; // gate-g1-allow: audit action follows the existing uppercase audit lineage.

export function validatePassword(value: string, initial = true): void {
  if (typeof value !== 'string' || value.length < (initial ? 8 : 1) || Buffer.byteLength(value, 'utf8') > 72) {
    throw AppError.validation(initial ? '口令至少 8 个字符，UTF-8 编码不能超过 72 字节' : '口令不能为空且 UTF-8 编码不能超过 72 字节');
  }
}
/** mysql errors can contain interpolated SQL/password hashes. Never retain the
 * original exception/cause on credential-write paths. */
export function safeCredentialError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if ((err as {code?:string})?.code === 'ER_DUP_ENTRY') return AppError.conflict('用户名已存在');
  return AppError.internal('账号凭证更新失败，请稍后重试');
}
export async function changePassword(userId: string, currentPassword: string, newPassword: string, ctx: OperatorContext): Promise<void> {
  validatePassword(currentPassword, false);
  validatePassword(newPassword);
  await setPassword(userId, newPassword, ctx, false, currentPassword);
}
export async function resetPassword(userId: string, newPassword: string, ctx: OperatorContext): Promise<void> {
  validatePassword(newPassword);
  await setPassword(userId, newPassword, ctx, true);
}
async function setPassword(userId: string, password: string, ctx: OperatorContext, forced: boolean, currentPassword?: string): Promise<void> {
  try {
    await withTransaction(async tx => {
      await tx.query('select user_id from app_user where user_id = ? for update', [userId]);
      const user = await findByUserId(tx, userId);
      if (!user) throw AppError.notFound('用户不存在');
      if (!forced && user.status !== 1) throw AppError.unauthenticated('用户已停用');
      if (currentPassword !== undefined && !await bcrypt.compare(currentPassword, user.passwordHash)) throw AppError.validation('当前口令错误');
      if (await bcrypt.compare(password, user.passwordHash)) throw AppError.validation('新口令不能与当前口令相同');
      const hash = await bcrypt.hash(password, 10);
      await tx.query('update app_user set password_hash = ?, must_change_password = ?, session_version = session_version + 1, updated_at = ? where user_id = ?',
        [hash, forced ? 1 : 0, new Date(), userId]);
      await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:'user',action:forced ? ACTION_PASSWORD_RESET : ACTION_PASSWORD_CHANGE,
        bizType:'user',bizId:userId,result:'success',clientIp:ctx.clientIp,detail:{targetUserId:userId,forceChange:forced},createdAt:new Date()});
    });
  } catch(err) { throw safeCredentialError(err); }
}
