import { runWithAccessContext } from '../src/auth/accessScope';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { ROLE_ADMIN, ROLE_HANDLER, isAllowed, matchRule } from '../src/auth/rolePolicy';
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

test('敏感词管理路由按能力校验词表读取和参数并拒绝缺少权限的账号', async () => {
  const { dictsRouter } = await import('../src/routes/dicts');
  const { errorHandler, notFoundHandler } = await import('../src/middleware/errorHandler');

  const { pool } = await import('../src/db/pool');
  const original = { query: pool.query, execute: pool.execute };
  pool.query = (async (sql: string) => {
    assert.ok(sql.includes('from dict_item d'), sql);
    return [[{itemId:'SW1',word:'爆管',label:'爆管',status:'enabled',hitCount:0}], []];
  }) as typeof pool.query;
  pool.execute = (async (sql: string) => { assert.ok(sql.includes('insert into operation_audit_log'), sql); return [{affectedRows:1}, []]; }) as typeof pool.execute;
  const makeApp = (role: 'admin' | 'handler', granted = role === 'admin') => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'TEST-USER', username: role, roles: [role], permissionCodes: granted ? ['system.dict.manage'] : [] };
      runWithAccessContext({userId:'TEST-USER',roles:[role],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false}, next);
    });
    app.use(dictsRouter);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  };

  try {
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
  const adminWithoutGrant = await request(makeApp('admin', false)).get('/dicts/sensitive-words');
  assert.equal(adminWithoutGrant.status, 403);
  } finally { Object.assign(pool, original); }
});
