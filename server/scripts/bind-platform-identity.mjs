import 'dotenv/config';
import knexFactory from 'knex';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const knexConfig = require2('../knexfile.js');
const config = knexConfig[process.env.NODE_ENV || 'development'];
const knex = knexFactory(config);

async function main() {
  // 1) 迁移：建立 platform_identity 绑定表
  const [batch, applied] = await knex.migrate.latest();
  console.log('migrate batch:', batch, 'applied:', applied.length);

  // 2) 列出可绑定账号（不输出任何口令/哈希）
  const rows = await knex('app_user').select('user_id', 'username', 'real_name', 'status');
  console.log('local users:', JSON.stringify(rows));

  const admin = rows.find((r) => r.username === 'admin') || rows[0];
  if (!admin) {
    console.log('NO_LOCAL_USER');
    await knex.destroy();
    return;
  }

  // 3) 显式绑定：平台 sub u001 -> 本地管理员
  await knex.raw(
    'insert into platform_identity (issuer, subject, user_id) values (?,?,?) ' +
    'on duplicate key update user_id = values(user_id)',
    ['zhuxin-platform', 'u001', admin.user_id],
  );
  const bound = await knex('platform_identity').select('*');
  console.log('binding:', JSON.stringify(bound.map((b) => ({ issuer: b.issuer, subject: b.subject, user_id: b.user_id }))));
  await knex.destroy();
}

main().catch(async (err) => { console.error('SETUP_FAILED', err.message); process.exitCode = 1; });
