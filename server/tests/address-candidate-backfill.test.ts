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

test('a later page scan failure leaves every prior candidate change audited in its transaction', { concurrency: false }, async () => {
  const { executeAddressCandidateBackfill } = await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  db.failAfterFirstScan = true;
  const restore = installFake(pool, db);
  try {
    const result = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    assert.equal(db.candidates.has('C1'), true);
    assert.equal(db.audits.length, 1);
    assert.match(String(db.audits[0][9]), /C1/);
    assert.doesNotMatch(String(db.audits[0][9]), /示例小区18号1301/);
    assert.equal(result.failed, 1);
    assert.equal(result.errors.scan, 1);
  } finally { restore(); }
});

test('audit insertion failure rolls back that row candidate and increments audit error count', { concurrency: false }, async () => {
  const { executeAddressCandidateBackfill } = await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  db.failAudit = true;
  const restore = installFake(pool, db);
  try {
    const result = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    assert.equal(db.candidates.has('C1'), false);
    assert.equal(db.audits.length, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.errors, { scan: 0, row: 0, audit: 1 });
  } finally { restore(); }
});

test('preview includes only a small redacted sample and execution has no samples', { concurrency: false }, async () => {
  const { previewAddressCandidateBackfill, executeAddressCandidateBackfill } =
    await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  const restore = installFake(pool, db);
  try {
    const preview = await previewAddressCandidateBackfill();
    assert.equal(preview.samples.length, 2);
    assert.deepEqual(preview.samples[0], { item: 1, action: 'create', sourceField: 'content', value: '[地址已脱敏]' });
    assert.doesNotMatch(JSON.stringify(preview), /示例小区18号1301/);
    const execution = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    assert.equal('samples' in execution, false);
  } finally { restore(); }
});

function installFake(pool: import('mysql2/promise').Pool, db: BackfillFake): () => void {
  const originalConnection = pool.getConnection;
  const originalQuery = pool.query;
  const originalExecute = pool.execute;
  pool.getConnection = (async () => db) as typeof pool.getConnection;
  pool.query = db.query.bind(db) as typeof pool.query;
  pool.execute = db.execute.bind(db) as typeof pool.execute;
  return () => { pool.getConnection = originalConnection; pool.query = originalQuery; pool.execute = originalExecute; };
}

class BackfillFake {
  writes = 0;
  candidates = new Map<string, Record<string, unknown>>();
  audits: unknown[][] = [];
  updateBeforeLock = false;
  updated = false;
  failAfterFirstScan = false;
  scanCalls = 0;
  failAudit = false;
  transactionCandidates: Map<string, Record<string, unknown>> | null = null;
  async beginTransaction() { this.transactionCandidates = new Map(this.candidates); }
  async commit() { this.transactionCandidates = null; }
  async rollback() { this.candidates = this.transactionCandidates ?? this.candidates; this.transactionCandidates = null; }
  release() {}
  async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.includes('from complaint') && sql.includes('order by')) {
      this.scanCalls++;
      if (this.failAfterFirstScan && this.scanCalls > 1) throw new Error('later page scan failed');
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
    if (sql.includes('insert into operation_audit_log')) {
      if (this.failAudit) throw new Error('audit insert failed');
      this.audits.push(values);
    }
    if (sql.includes('insert into complaint_address_candidate')) this.candidates.set(String(values[0]), {
      complaintId: values[0], candidateText: values[1], evidenceText: values[2], sourceField: values[3],
      extractorVersion: values[4], inputHash: values[5],
    });
    return [{ affectedRows: 1 }, []];
  }
}
