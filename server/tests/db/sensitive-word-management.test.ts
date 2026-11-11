import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { assertIsolatedDatabase } from '../helpers/isolated-database';
const testDatabase = assertIsolatedDatabase();
async function withTestTransaction<T>(run: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const { runWithAccessContext } = await import('../../src/auth/accessScope');
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
    return await runWithAccessContext({userId:'TEST-ADMIN',roles:['admin'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false}, () => run(conn));
  } finally {
    await conn.rollback();
    conn.release();
    await pool.end();
  }
}

test('真实测试库中的敏感词新增、查重、启停和审计在同一事务内完成', async () => {
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
  const service = await import('../../src/services/sensitiveWordService') as Record<string, unknown>;
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
