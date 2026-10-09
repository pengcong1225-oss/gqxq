#!/usr/bin/env node
/**
 * seed-admin.mjs —— 创建初始管理员（仅首次 seed 使用）。
 *
 * 用法：
 *   cd server && node scripts/seed-admin.mjs
 *
 * 幂等：同名 username 已存在则跳过，退出码 0。
 * 安全：口令只从 GQXQ_BOOTSTRAP_ADMIN_PASSWORD 读取；
 *       为空则拒绝创建、打印告警并以非 0 退出——绝不写入任何默认口令。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(HERE, '..', '.env') });

function opt(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function required(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    console.error('[seed-admin] 缺少必填环境变量：' + name);
    process.exit(1);
  }
  return raw.trim();
}

const username = opt('GQXQ_BOOTSTRAP_ADMIN_USERNAME', '');
const password = process.env.GQXQ_BOOTSTRAP_ADMIN_PASSWORD === undefined
  ? ''
  : process.env.GQXQ_BOOTSTRAP_ADMIN_PASSWORD;

if (username === '') {
  console.error('[seed-admin] GQXQ_BOOTSTRAP_ADMIN_USERNAME 为空，拒绝创建。');
  process.exit(1);
}
if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
  console.error('[seed-admin] 初始口令至少 8 个字符，UTF-8 编码不得超过 72 字节。');
  console.error('[seed-admin] 请在 server/.env 中设置强口令后重试；本脚本不会写入任何默认口令。');
  process.exit(1);
}

const realNameEnv = process.env.GQXQ_BOOTSTRAP_ADMIN_REAL_NAME;
const realName = realNameEnv !== undefined && realNameEnv.trim() !== ''
  ? realNameEnv.trim()
  : '系统管理员';

async function main() {
  const conn = await mysql.createConnection({
    host: opt('GQXQ_DB_HOST', '127.0.0.1'),
    port: Number(opt('GQXQ_DB_PORT', '3306')),
    user: required('GQXQ_DB_USER'),
    password: process.env.GQXQ_DB_PASSWORD === undefined ? '' : process.env.GQXQ_DB_PASSWORD,
    database: required('GQXQ_DB_NAME'),
    charset: 'utf8mb4',
    // 与运行期连接池相同的 Asia/Shanghai 墙钟口径
    timezone: '+08:00',
  });

  try {
    await conn.beginTransaction();
    await conn.query('select version from platform_authorization_state where id = 1 for update');
    const existing = await conn.query(
      'select id, user_id, username from app_user where username = ? limit 1',
      [username]
    );
    const rows = existing[0];
    if (Array.isArray(rows) && rows.length > 0) {
      console.log('[seed-admin] 用户已存在，跳过（幂等）：username=' + username
        + ' userId=' + String(rows[0].user_id));
      await conn.commit();
      return;
    }

    const [admins] = await conn.query("select user_id from app_user where status = 1 and json_type(roles) = 'ARRAY' and json_length(roles) = 1 and json_contains(roles, json_quote('admin')) limit 1");
    if (admins.length > 0) {
      await conn.rollback();
      throw new Error('已有管理员，初始化不会新增或提权；请使用账号管理');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const roles = JSON.stringify(['admin']);
    const permissions = JSON.stringify([]);

    // 业务主键沿用仓库约定：前缀 + yyyyMMdd + 4 位序号（与 complaint_id / assignment_id 同构）
    const bizDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

    let userId;
    try {
      const seqResult = await conn.query(
        'insert into number_sequence (seq_key, biz_date, current_value) ' +
          'values (?, ?, last_insert_id(1)) ' +
          'on duplicate key update current_value = last_insert_id(current_value + 1)',
        ['app_user', bizDate]
      );
      const seq = Number(seqResult[0].insertId);
      if (!Number.isInteger(seq) || seq < 1) {
        throw new Error('发号失败：insertId=' + String(seq));
      }
      userId = 'USR' + bizDate.replace(/-/g, '') + String(seq).padStart(4, '0');

      const now = new Date();
      await conn.query(
        'insert into app_user ' +
          '(user_id, username, password_hash, real_name, roles, permissions, status, created_at, updated_at, must_change_password, session_version) ' +
          'values (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, 1)',
        [userId, username, passwordHash, realName, roles, permissions, now, now]
      );
      await conn.query('update platform_authorization_state set version = version + 1 where id = 1');
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }

    console.log('[seed-admin] 已创建初始管理员：username=' + username
      + ' userId=' + userId + ' roles=[admin]');
    console.log('[seed-admin] 口令未回显。首次登录须改密；重置请使用管理员重置入口，禁止删除账号。');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[seed-admin] 初始化失败，请核对迁移与配置；错误详情不输出，以免数据库异常泄露凭证。');
  process.exit(1);
});
