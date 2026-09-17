// knex 配置：**只用于数据库迁移**。
// 运行期数据访问不用 knex，一律走 src/db/pool.ts 的 mysql2 连接池（手写参数化 SQL）。
require('dotenv').config();

const connection = (database) => ({
  client: 'mysql2',
  connection: {
    host: process.env.GQXQ_DB_HOST || '127.0.0.1',
    port: Number(process.env.GQXQ_DB_PORT || 3306),
    user: process.env.GQXQ_MIGRATE_DB_USER || process.env.GQXQ_DB_USER,
    password: process.env.GQXQ_MIGRATE_DB_PASSWORD || process.env.GQXQ_DB_PASSWORD,
    database,
    charset: 'utf8mb4',
    // 与 src/db/pool.ts 保持同一口径（DATETIME 存 Asia/Shanghai 墙钟）
    timezone: '+08:00',
    multipleStatements: false,
    dateStrings: false,
  },
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations',
    // MySQL 的 DDL 隐式提交，事务包不住；显式关闭以免误以为可回滚
    disableTransactions: true,
  },
  pool: { min: 1, max: 2 },
});

const database = process.env.GQXQ_DB_NAME || 'gqxq_service';
const testDatabase = process.env.GQXQ_TEST_DB_NAME || 'gqxq_service_test';

module.exports = {
  development: connection(database),
  test: connection(testDatabase),
  production: connection(database),
};
