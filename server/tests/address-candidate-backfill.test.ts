import assert from 'node:assert/strict';
import test from 'node:test';
import { ROLE_ADMIN, matchRule } from '../src/auth/rolePolicy';
import { addressInputHash } from '../src/services/rules/addressExtract';

test('backfill endpoints are explicitly admin only', { concurrency: false }, async () => {
  assert.deepEqual(matchRule('POST', '/address-candidates/backfill-preview')?.roles, [ROLE_ADMIN]);
  assert.deepEqual(matchRule('POST', '/address-candidates/backfill')?.roles, [ROLE_ADMIN]);
});

test('preview is read only and execution is repeatable for existing candidate rows', { concurrency: false }, async () => {
  const { previewAddressCandidateBackfill, executeAddressCandidateBackfill } =
    await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  const original = pool.getConnection;
  const originalQuery = pool.query;
  const originalExecute = pool.execute;
  pool.getConnection = (async () => db) as typeof pool.getConnection;
  pool.query = db.query.bind(db) as typeof pool.query;
  pool.execute = db.execute.bind(db) as typeof pool.execute;
  try {
    const before = db.writes;
    const preview = await previewAddressCandidateBackfill();
    assert.equal(db.writes, before);
    assert.equal(preview.total, 2);
    assert.equal(preview.extractable, 1);
    assert.equal(preview.noCandidate, 1);
    const first = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    const countAfterFirst = db.candidates.size;
    const second = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    assert.equal(first.created, 1);
    assert.equal(second.unchanged, 2);
    assert.equal(db.candidates.size, countAfterFirst);
    assert.equal(db.candidates.has('C2'), false);
  } finally { pool.getConnection = original; pool.query = originalQuery; pool.execute = originalExecute; }
});

test('execution locks and rereads current text before extracting', { concurrency: false }, async () => {
  const { executeAddressCandidateBackfill } = await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  db.updateBeforeLock = true;
  const original = pool.getConnection;
  const originalQuery = pool.query;
  const originalExecute = pool.execute;
  pool.getConnection = (async () => db) as typeof pool.getConnection;
  pool.query = db.query.bind(db) as typeof pool.query;
  pool.execute = db.execute.bind(db) as typeof pool.execute;
  try {
    await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    assert.equal(db.candidates.get('C1')?.inputHash, addressInputHash({ title: '燃气安装', content: '点军区联棚乡示例小区19号1301的居民反映进度。' }));
    assert.match(String(db.candidates.get('C1')?.candidateText), /19号1301/);
  } finally { pool.getConnection = original; pool.query = originalQuery; pool.execute = originalExecute; }
});

class BackfillFake {
  writes = 0;
  candidates = new Map<string, Record<string, unknown>>();
  updateBeforeLock = false;
  updated = false;
  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
  async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.includes('from complaint') && sql.includes('order by')) {
      if (values[0] !== '') return [[], []];
      return [[
        { complaintId: 'C1', title: '燃气安装', content: this.updated ? '点军区联棚乡示例小区19号1301的居民反映进度。' : '点军区联棚乡示例小区18号1301的居民反映进度。' },
        { complaintId: 'C2', title: '燃气报装', content: '请尽快处理。' },
      ], []];
    }
    if (sql.includes('from complaint') && sql.includes('for update')) {
      if (this.updateBeforeLock && !this.updated) this.updated = true;
      const id = String(values[0]);
      return [[{ complaintId: id, title: '燃气安装', content: id === 'C1'
        ? (this.updated ? '点军区联棚乡示例小区19号1301的居民反映进度。' : '点军区联棚乡示例小区18号1301的居民反映进度。')
        : '请尽快处理。' }], []];
    }
    if (sql.includes('from complaint_address_candidate')) {
      return [this.candidates.has(String(values[0])) ? [this.candidates.get(String(values[0]))] : [], []];
    }
    return [[], []];
  }
  async execute(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    this.writes++;
    if (sql.includes('insert into complaint_address_candidate')) this.candidates.set(String(values[0]), {
      complaintId: values[0], candidateText: values[1], evidenceText: values[2], sourceField: values[3],
      extractorVersion: values[4], inputHash: values[5],
    });
    return [{ affectedRows: 1 }, []];
  }
}
