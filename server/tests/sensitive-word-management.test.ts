import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import express from 'express';
import request from 'supertest';
import {
  ROLE_ADMIN,
  ROLE_HANDLER,
  isAllowed,
  matchRule,
} from '../src/auth/rolePolicy';

dotenv.config({ path: resolve(process.cwd(), '.env') });
const testDatabase = process.env.GQXQ_TEST_DB_NAME || 'gqxq_service_test';
assert.notEqual(testDatabase, 'gqxq_service', '敏感词集成测试禁止连接真实库');
// sensitiveWordService 的默认连接池也必须指向测试库；路由契约测试会使用它。
process.env.GQXQ_DB_NAME = testDatabase;

after(async () => {
  const { closePool } = await import('../src/db/pool');
  await closePool();
});

async function withTestTransaction<T>(run: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const pool = mysql.createPool({
    host: process.env.GQXQ_DB_HOST || '127.0.0.1',
    port: Number(process.env.GQXQ_DB_PORT || 3306),
    user: process.env.GQXQ_DB_USER,
    password: process.env.GQXQ_DB_PASSWORD,
    database: testDatabase,
    timezone: '+08:00',
    connectionLimit: 1,
  });
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    return await run(conn);
  } finally {
    await conn.rollback();
    conn.release();
    await pool.end();
  }
}

test('敏感词管理与历史重扫端点必须显式声明为管理员独占', () => {
  const routes = [
    ['GET', '/dicts/sensitive-words'],
    ['POST', '/dicts/sensitive-words'],
    ['PATCH', '/dicts/sensitive-words/DICT-SW-001'],
    ['POST', '/dicts/sensitive-words/rescan-preview'],
    ['POST', '/dicts/sensitive-words/rescan'],
  ] as const;

  for (const [method, path] of routes) {
    const rule = matchRule(method, path);
    assert.ok(rule, method + ' ' + path + ' 应有显式权限策略，不能只依赖默认拒绝');
    assert.deepEqual(rule.roles, [ROLE_ADMIN]);
    assert.equal(
      isAllowed({ id: 'admin-1', username: 'admin', roles: [ROLE_ADMIN] }, method, path).allowed,
      true
    );
    assert.equal(
      isAllowed({ id: 'handler-1', username: 'handler', roles: [ROLE_HANDLER] }, method, path).allowed,
      false
    );
  }
});

test('历史重扫预览准确区分新增敏感、取消敏感、关键词变化与无变化', async () => {
  let service: Record<string, unknown> = {};
  try {
    service = await import('../src/services/sensitiveWordService');
  } catch {
    // RED 阶段模块尚不存在：下面用行为断言给出明确失败，而不是让加载错误吞掉意图。
  }
  const buildPlan = service.buildSensitiveRescanPlan as
    | ((rows: unknown[], words: string[]) => {
        summary: Record<string, number>;
        changes: Array<{ complaintId: string; nextIsSensitive: boolean; nextKeywords: string[] }>;
      })
    | undefined;

  assert.equal(typeof buildPlan, 'function');
  const result = buildPlan?.(
    [
      {
        complaintId: 'C1', title: '居民反映燃气泄漏', content: null, address: null,
        isSensitive: false, sensitiveKeywords: [],
      },
      {
        complaintId: 'C2', title: '普通报修', content: null, address: null,
        isSensitive: true, sensitiveKeywords: ['爆管'],
      },
      {
        complaintId: 'C3', title: '发生爆管', content: null, address: null,
        isSensitive: true, sensitiveKeywords: ['爆管'],
      },
      {
        complaintId: 'C4', title: '发生爆管', content: '同时存在泄漏', address: null,
        isSensitive: true, sensitiveKeywords: ['爆管'],
      },
    ],
    ['爆管', '泄漏']
  );

  assert.deepEqual(result?.summary, {
    total: 4,
    wouldBecomeSensitive: 1,
    wouldBecomeNonSensitive: 1,
    keywordsChanged: 1,
    unchanged: 1,
  });
  assert.deepEqual(result?.changes, [
    { complaintId: 'C1', nextIsSensitive: true, nextKeywords: ['泄漏'] },
    { complaintId: 'C2', nextIsSensitive: false, nextKeywords: [] },
    { complaintId: 'C4', nextIsSensitive: true, nextKeywords: ['爆管', '泄漏'] },
  ]);
});

test('词表指纹与词条顺序无关但会随内容变化', async () => {
  let service: Record<string, unknown> = {};
  try {
    service = await import('../src/services/sensitiveWordService');
  } catch {
    // 见上一测试的 RED 说明。
  }
  const fingerprint = service.sensitiveWordFingerprint as
    | ((words: string[]) => string)
    | undefined;

  assert.equal(typeof fingerprint, 'function');
  assert.equal(fingerprint?.(['泄漏', '爆管']), fingerprint?.(['爆管', '泄漏']));
  assert.notEqual(fingerprint?.(['泄漏', '爆管']), fingerprint?.(['泄漏', '爆管', '大面积停水']));
});

test('词条保存前会去除首尾空白并拒绝空词条与存储分隔符', async () => {
  let service: Record<string, unknown> = {};
  try {
    service = await import('../src/services/sensitiveWordService');
  } catch {
    // 见上一测试的 RED 说明。
  }
  const normalize = service.normalizeSensitiveWord as ((word: string) => string) | undefined;

  assert.equal(typeof normalize, 'function');
  assert.equal(normalize?.('  爆管  '), '爆管');
  assert.throws(() => normalize?.('   '), /敏感词不能为空/);
  assert.throws(() => normalize?.('爆管,泄漏'), /不能包含/);
  assert.throws(() => normalize?.('爆管，泄漏'), /不能包含/);
  assert.throws(() => normalize?.('爆管、泄漏'), /不能包含/);
});

test('真实测试库中的敏感词新增、查重、启停和审计在同一事务内完成', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const createInTx = service.createSensitiveWordInTransaction as
    | ((db: mysql.PoolConnection, input: { word: string }, ctx: unknown) => Promise<{ itemId: string; word: string; status: string }>)
    | undefined;
  const updateInTx = service.updateSensitiveWordInTransaction as
    | ((db: mysql.PoolConnection, itemId: string, input: { word?: string; status?: string }, ctx: unknown) => Promise<{ word: string; status: string }>)
    | undefined;
  const listInDb = service.listManagedSensitiveWords as
    | ((db: mysql.PoolConnection) => Promise<Array<{ itemId: string; word: string; status: string }>>)
    | undefined;

  assert.equal(typeof createInTx, 'function');
  assert.equal(typeof updateInTx, 'function');
  assert.equal(typeof listInDb, 'function');

  await withTestTransaction(async (conn) => {
    const suffix = randomUUID().slice(0, 8);
    const word = '验收敏感词' + suffix;
    const ctx = { userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1' };
    const created = await createInTx?.(conn, { word: '  ' + word + '  ' }, ctx);
    assert.equal(created?.word, word);
    assert.equal(created?.status, 'enabled');

    const rows = await listInDb?.(conn);
    assert.equal(rows?.some((row) => row.itemId === created?.itemId && row.word === word), true);

    await assert.rejects(
      () => createInTx!(conn, { word }, ctx),
      /敏感词已存在/
    );

    const disabled = await updateInTx?.(conn, created!.itemId, { status: 'disabled' }, ctx);
    assert.equal(disabled?.status, 'disabled');

    const [auditRows] = await conn.query(
      "select action from operation_audit_log where user_id = 'TEST-ADMIN' and biz_id = ? order by id",
      [created?.itemId]
    );
    assert.deepEqual(
      (auditRows as Array<{ action: string }>).map((row) => row.action),
      ['SENSITIVE_WORD_CREATE', 'SENSITIVE_WORD_UPDATE']
    );
  });
});

test('禁止停用最后一个有效敏感词', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const createInTx = service.createSensitiveWordInTransaction as
    | ((db: mysql.PoolConnection, input: { word: string }, ctx: unknown) => Promise<{ itemId: string }>)
    | undefined;
  const updateInTx = service.updateSensitiveWordInTransaction as
    | ((db: mysql.PoolConnection, itemId: string, input: { status: string }, ctx: unknown) => Promise<unknown>)
    | undefined;
  assert.equal(typeof createInTx, 'function');
  assert.equal(typeof updateInTx, 'function');

  await withTestTransaction(async (conn) => {
    await conn.query("update dict_item set status = 'disabled' where dict_type = 'sensitive_word'");
    const created = await createInTx?.(
      conn,
      { word: '唯一有效词' + randomUUID().slice(0, 8) },
      { userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1' }
    );
    await assert.rejects(
      () => updateInTx!(conn, created!.itemId, { status: 'disabled' }, { userId: 'TEST-ADMIN' }),
      /最后一个有效敏感词/
    );
  });
});

test('启用词条的逗号串超过字段上限时拒绝写入而不截断', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const createInTx = service.createSensitiveWordInTransaction as
    (db: mysql.PoolConnection, input: { word: string }, ctx: unknown) => Promise<unknown>;
  await withTestTransaction(async (conn) => {
    const ctx = { userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1' };
    await conn.query("update dict_item set status = 'disabled' where dict_type = 'sensitive_word'");
    await createInTx(conn, { word: '甲'.repeat(128) }, ctx);
    await createInTx(conn, { word: '乙'.repeat(128) }, ctx);
    await createInTx(conn, { word: '丙'.repeat(128) }, ctx);
    await assert.rejects(
      () => createInTx(conn, { word: '丁'.repeat(115) }, ctx),
      /存储上限/
    );
  });
});

test('仅修改状态时也会拒绝重新启用含分隔符的历史词条', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const updateInTx = service.updateSensitiveWordInTransaction as
    (db: mysql.PoolConnection, itemId: string, input: { status: string }, ctx: unknown) => Promise<unknown>;
  await withTestTransaction(async (conn) => {
    const itemId = 'DICT-SW-LEGACY-' + randomUUID();
    await conn.query(
      "insert into dict_item (item_id, dict_type, item_value, item_label, status) values (?, 'sensitive_word', ?, ?, 'disabled')",
      [itemId, '历史,非法词', '历史,非法词']
    );
    await assert.rejects(
      () => updateInTx(conn, itemId, { status: 'enabled' }, {
        userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1',
      }),
      /不能包含/
    );
  });
});

test('历史重扫使用绑定操作人的一次性预览令牌并留下完整字段版本', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const createInTx = service.createSensitiveWordInTransaction as
    | ((db: mysql.PoolConnection, input: { word: string }, ctx: unknown) => Promise<unknown>)
    | undefined;
  const previewInDb = service.previewSensitiveRescan as
    | ((db: mysql.PoolConnection, ctx: unknown) => Promise<{ previewToken: string; fingerprint: string; summary: Record<string, number> }>)
    | undefined;
  const executeInTx = service.executeSensitiveRescanInTransaction as
    | ((db: mysql.PoolConnection, previewToken: string, ctx: unknown) => Promise<{ updated: number }>)
    | undefined;
  assert.equal(typeof createInTx, 'function');
  assert.equal(typeof previewInDb, 'function');
  assert.equal(typeof executeInTx, 'function');

  await withTestTransaction(async (conn) => {
    const marker = '重扫验收词' + randomUUID().slice(0, 8);
    const ctx = { userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1' };
    await conn.query("update dict_item set status = 'disabled' where dict_type = 'sensitive_word'");
    await createInTx?.(conn, { word: marker }, ctx);

    const [complaints] = await conn.query(
      'select complaint_id as complaintId from complaint where coalesce(deleted, 0) = 0 order by id limit 1'
    );
    const complaintId = String((complaints as Array<{ complaintId: string }>)[0]?.complaintId ?? '');
    assert.notEqual(complaintId, '', '测试库至少需要一条诉求用于事务内重扫');
    await conn.query(
      "update complaint set title = ?, content = null, address = null, is_sensitive = 0, sensitive_keywords = null, rule_version = 'before' where complaint_id = ?",
      [marker, complaintId]
    );

    const preview = await previewInDb?.(conn, ctx);
    assert.ok((preview?.summary.wouldBecomeSensitive ?? 0) >= 1);
    await assert.rejects(
      () => executeInTx!(conn, randomUUID(), ctx),
      /预览令牌/
    );
    await assert.rejects(
      () => executeInTx!(conn, preview!.previewToken, { ...ctx, userId: 'OTHER-ADMIN' }),
      /不属于当前操作人/
    );

    const result = await executeInTx?.(conn, preview!.previewToken, ctx);
    assert.ok((result?.updated ?? 0) >= 1);
    await assert.rejects(
      () => executeInTx!(conn, preview!.previewToken, ctx),
      /预览令牌/
    );

    const [afterRows] = await conn.query(
      'select is_sensitive as isSensitive, sensitive_keywords as keywords from complaint where complaint_id = ?',
      [complaintId]
    );
    assert.equal(Number((afterRows as Array<{ isSensitive: number }>)[0]?.isSensitive), 1);
    assert.equal(String((afterRows as Array<{ keywords: string }>)[0]?.keywords), marker);

    const [versionRows] = await conn.query(
      "select count(*) as n from complaint_field_version where complaint_id = ? and change_source = 'rule_engine'",
      [complaintId]
    );
    assert.ok(Number((versionRows as Array<{ n: number }>)[0]?.n ?? 0) >= 4);
    const [versionFields] = await conn.query(
      "select field_name as fieldName from complaint_field_version where complaint_id = ? and change_source = 'rule_engine'",
      [complaintId]
    );
    const fieldNames = new Set((versionFields as Array<{ fieldName: string }>).map((row) => row.fieldName));
    assert.equal(fieldNames.has('rule_confidence'), true);
    assert.equal(fieldNames.has('rule_version'), true);

    const [hitRows] = await conn.query(
      'select count(*) as n from sensitive_hit where complaint_id = ? and keyword = ?',
      [complaintId, marker]
    );
    assert.ok(Number((hitRows as Array<{ n: number }>)[0]?.n ?? 0) >= 1);
    const hitCountAfterFirstRun = Number((hitRows as Array<{ n: number }>)[0]?.n ?? 0);

    const secondPreview = await previewInDb?.(conn, ctx);
    const secondResult = await executeInTx?.(conn, secondPreview!.previewToken, ctx);
    assert.equal(secondResult?.updated, 0, '相同词表与数据的二次重扫应幂等');
    const [secondHitRows] = await conn.query(
      'select count(*) as n from sensitive_hit where complaint_id = ? and keyword = ?',
      [complaintId, marker]
    );
    assert.equal(
      Number((secondHitRows as Array<{ n: number }>)[0]?.n ?? 0),
      hitCountAfterFirstRun,
      '幂等重扫不应重复写入命中证据'
    );

    const [auditRows] = await conn.query(
      "select count(*) as n from operation_audit_log where user_id = 'TEST-ADMIN' and action = 'SENSITIVE_WORD_RESCAN'",
    );
    assert.equal(Number((auditRows as Array<{ n: number }>)[0]?.n ?? 0), 2);
  });
});

test('预览后诉求数据变化时服务端拒绝执行', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const previewInDb = service.previewSensitiveRescan as
    (db: mysql.PoolConnection, ctx: unknown) => Promise<{ previewToken: string }>;
  const executeInTx = service.executeSensitiveRescanInTransaction as
    (db: mysql.PoolConnection, previewToken: string, ctx: unknown) => Promise<unknown>;

  await withTestTransaction(async (conn) => {
    const ctx = { userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1' };
    const preview = await previewInDb(conn, ctx);
    const [rows] = await conn.query(
      'select complaint_id as complaintId from complaint where coalesce(deleted, 0) = 0 order by id limit 1'
    );
    const complaintId = String((rows as Array<{ complaintId: string }>)[0]?.complaintId ?? '');
    assert.notEqual(complaintId, '');
    await conn.query('update complaint set title = concat(coalesce(title, ?), ?) where complaint_id = ?', [
      '',
      '预览后变化',
      complaintId,
    ]);
    await assert.rejects(
      () => executeInTx(conn, preview.previewToken, ctx),
      /预览已失效/
    );
  });
});

test('预览后敏感词表变化时服务端拒绝执行', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const previewInDb = service.previewSensitiveRescan as
    (db: mysql.PoolConnection, ctx: unknown) => Promise<{ previewToken: string }>;
  const executeInTx = service.executeSensitiveRescanInTransaction as
    (db: mysql.PoolConnection, previewToken: string, ctx: unknown) => Promise<unknown>;

  await withTestTransaction(async (conn) => {
    const ctx = { userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1' };
    const preview = await previewInDb(conn, ctx);
    const [rows] = await conn.query(
      "select item_id as itemId from dict_item where dict_type = 'sensitive_word' and status = 'enabled' order by id limit 1"
    );
    const itemId = String((rows as Array<{ itemId: string }>)[0]?.itemId ?? '');
    assert.notEqual(itemId, '');
    await conn.query(
      "update dict_item set item_value = concat(item_value, ?), item_label = concat(item_label, ?) where item_id = ?",
      ['变', '变', itemId]
    );
    await assert.rejects(
      () => executeInTx(conn, preview.previewToken, ctx),
      /预览已失效/
    );
  });
});

test('预览令牌超过返回的有效期后不可执行', async () => {
  const service = await import('../src/services/sensitiveWordService') as Record<string, unknown>;
  const previewInDb = service.previewSensitiveRescan as
    (db: mysql.PoolConnection, ctx: unknown, now: number) => Promise<{
      previewToken: string;
      expiresAt: string;
    }>;
  const executeInTx = service.executeSensitiveRescanInTransaction as
    (db: mysql.PoolConnection, previewToken: string, ctx: unknown, now: number) => Promise<unknown>;

  await withTestTransaction(async (conn) => {
    const ctx = { userId: 'TEST-ADMIN', userName: 'test-admin', clientIp: '127.0.0.1' };
    const start = Date.now();
    const preview = await previewInDb(conn, ctx, start);
    await assert.rejects(
      () => executeInTx(conn, preview.previewToken, ctx, Date.parse(preview.expiresAt) + 1),
      /已过期/
    );
  });
});

test('敏感词管理路由可读取真实词表、校验写入参数并二次拦截非管理员', async () => {
  const { dictsRouter } = await import('../src/routes/dicts');
  const { errorHandler, notFoundHandler } = await import('../src/middleware/errorHandler');

  const makeApp = (role: 'admin' | 'handler') => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'TEST-USER', username: role, roles: [role] };
      next();
    });
    app.use(dictsRouter);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  };

  const list = await request(makeApp('admin')).get('/dicts/sensitive-words');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(Array.isArray(list.body?.data));
  assert.ok(list.body.data.some((row: { word?: string }) => row.word === '爆管'));

  const invalid = await request(makeApp('admin'))
    .post('/dicts/sensitive-words')
    .send({ word: '   ' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body?.data?.errorCode, 'VALIDATION_FAILED');

  const legacyFingerprint = await request(makeApp('admin'))
    .post('/dicts/sensitive-words/rescan')
    .send({ fingerprint: 'a'.repeat(64) });
  assert.equal(legacyFingerprint.status, 400);
  assert.equal(legacyFingerprint.body?.data?.errorCode, 'VALIDATION_FAILED');

  const forbidden = await request(makeApp('handler')).get('/dicts/sensitive-words');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body?.message, '无权限，请联系管理员');
});
