#!/usr/bin/env node
// Read-only DB inspection for gqxq master data init (never writes business tables).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const env = {};
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const conn = await mysql.createConnection({
  host: env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(env.GQXQ_DB_PORT || 3306),
  user: env.GQXQ_DB_USER || 'root',
  password: env.GQXQ_DB_PASSWORD || '',
  database: env.GQXQ_DB_NAME || 'gqxq_service',
  charset: 'utf8mb4',
});
try {
  const [rows] = await conn.query(process.argv[2]);
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await conn.end();
}
