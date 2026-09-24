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
    assert.equal(second.unchanged, 2, JSON.stringify(second));
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
    assert.equal(result.failed, 1, JSON.stringify(result));
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
    assert.equal(db.clues.length, 0);
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
    assert.deepEqual(preview.samples[0], { item: 1, action: 'create', category: 'township', value: '[已脱敏]' });
    assert.doesNotMatch(JSON.stringify(preview), /示例小区18号1301/);
    const execution = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    assert.equal('samples' in execution, false);
  } finally { restore(); }
});

test('preview counts clue grades and conflicts while remaining read only and redacted', { concurrency: false }, async () => {
  const { previewAddressCandidateBackfill } = await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  db.rows = [
    { complaintId: 'C1', title: '诉求一', content: '联棚乡居民来电，联系人张三，电话13800000000。' },
    { complaintId: 'C2', title: '诉求二', content: '联棚乡与艾家镇两处都有问题，联系人李四。' },
    { complaintId: 'C3', title: '诉求三', content: '张三电话13800000000，请求尽快处理。' },
  ];
  const restore = installFake(pool, db);
  try {
    const beforeWrites = db.writes;
    const preview = await previewAddressCandidateBackfill();
    assert.equal(db.writes, beforeWrites);
    assert.equal(preview.total, 3);
    assert.equal(preview.townshipClues, 3);
    assert.equal(preview.settlementClues, 0, JSON.stringify(preview));
    assert.equal(preview.conflicts, 1);
    assert.equal(preview.unresolved, 1);
    assert.equal(preview.clueCreated, 2);
    assert.equal(preview.clueUnchanged, 1);
    assert.ok(preview.samples.length <= 5);
    assert.deepEqual(preview.samples[0], { item: 1, action: 'create', category: 'township', value: '[已脱敏]' });
    assert.doesNotMatch(JSON.stringify(preview), /13800000000|张三|李四|联棚乡|艾家镇|示例家园18号1301/);
  } finally { restore(); }
});

test('execution synchronizes candidate, clues, and audit together using locked text, then becomes unchanged', { concurrency: false }, async () => {
  const { executeAddressCandidateBackfill } = await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  db.rows = [{ complaintId: 'C1', title: '燃气安装', content: '点军区联棚乡示例小区18号1301的居民反映进度。' }];
  db.updateBeforeLock = true;
  const restore = installFake(pool, db);
  try {
    const first = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    const lockedInput = { title: '燃气安装', content: '点军区联棚乡示例小区19号1301的居民反映进度。' };
    assert.equal(db.candidates.get('C1')?.inputHash, addressInputHash(lockedInput));
    assert.ok(db.clues.some((clue) => clue.complaintId === 'C1' && clue.value === '示例小区19号1301'));
    assert.equal(db.clues.some((clue) => clue.complaintId === 'C1' && clue.value === '示例小区18号1301'), false);
    assert.equal(db.audits.length, 1);
    assert.match(String(db.audits[0][9]), /"complaintId":"C1"/);
    assert.match(String(db.audits[0][9]), /"addressChange":"created"/);
    assert.match(String(db.audits[0][9]), /"clueChange":"created"/);
    assert.doesNotMatch(String(db.audits[0][9]), /示例小区19号1301|13800000000|张三/);
    assert.equal(first.created, 1);
    assert.equal(first.clueCreated, 1);

    const writesAfterFirst = db.writes;
    const second = await executeAddressCandidateBackfill({ userId: 'a1', userName: 'Admin', clientIp: null });
    assert.equal(db.writes, writesAfterFirst);
    assert.equal(second.unchanged, 1);
    assert.equal(second.clueUnchanged, 1);
    assert.equal(db.audits.length, 1);
  } finally { restore(); }
});

test('a version or snapshot change is counted as a planned recomputation', { concurrency: false }, async () => {
  const { previewAddressCandidateBackfill } = await import('../src/services/addressCandidateBackfillService');
  const { pool } = await import('../src/db/pool');
  const db = new BackfillFake();
  db.rows = [{ complaintId: 'C1', title: '核查', content: '联棚乡居民来电。' }];
  db.clues = [{ complaintId: 'C1', kind: 'township', value: '联棚乡', evidence: '联棚乡', sourceField: 'content',
    start: 0, end: 3, townshipCode: '420504202', districtCode: '420504', parentMatch: 'unique_township',
    extractorVersion: 'old-version', snapshotId: 'old-snapshot', inputHash: addressInputHash({ title: '核查', content: '联棚乡居民来电。' }) }];
  const restore = installFake(pool, db);
  try {
    const preview = await previewAddressCandidateBackfill();
    assert.equal(preview.recomputedForVersion, 1, JSON.stringify(preview));
    assert.equal(preview.clueUpdated, 1);
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
  rows: Array<{ complaintId: string; title: string | null; content: string | null }> = [
    { complaintId: 'C1', title: '燃气安装', content: '点军区联棚乡示例小区18号1301的居民反映进度。' },
    { complaintId: 'C2', title: '燃气报装', content: '请尽快处理。' },
  ];
  candidates = new Map<string, Record<string, unknown>>();
  clues: Array<Record<string, unknown>> = [];
  audits: unknown[][] = [];
  updateBeforeLock = false;
  updated = false;
  failAfterFirstScan = false;
  scanCalls = 0;
  failAudit = false;
  transactionCandidates: Map<string, Record<string, unknown>> | null = null;
  transactionSnapshot: { candidates: Map<string, Record<string, unknown>>; clues: Array<Record<string, unknown>>; audits: unknown[][] } | null = null;
  async beginTransaction() { this.transactionCandidates = new Map(this.candidates); this.transactionSnapshot = {
    candidates: new Map(this.candidates), clues: this.clues.map((clue) => ({ ...clue })), audits: this.audits.map((audit) => [...audit]),
  }; }
  async commit() { this.transactionCandidates = null; this.transactionSnapshot = null; }
  async rollback() {
    if (this.transactionSnapshot) {
      this.candidates = this.transactionSnapshot.candidates;
      this.clues = this.transactionSnapshot.clues;
      this.audits = this.transactionSnapshot.audits;
    }
    this.transactionCandidates = null; this.transactionSnapshot = null;
  }
  release() {}
  async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.includes('from complaint where complaint_id >') && sql.includes('order by')) {
      this.scanCalls++;
      if (this.failAfterFirstScan && this.scanCalls > 1) throw new Error('later page scan failed');
      if (values[0] !== '') return [[], []];
      return [this.rows.map((row) => ({ ...row, content: row.complaintId === 'C1' && this.updated
        ? '点军区联棚乡示例小区19号1301的居民反映进度。' : row.content })), []];
    }
    if (sql.includes('from complaint where complaint_id =') && sql.includes('for update')) {
      if (this.updateBeforeLock && !this.updated) this.updated = true;
      const id = String(values[0]);
      return [[{ complaintId: id, title: '燃气安装', content: id === 'C1'
        ? (this.updated ? '点军区联棚乡示例小区19号1301的居民反映进度。' : '点军区联棚乡示例小区18号1301的居民反映进度。')
        : '请尽快处理。' }], []];
    }
    if (sql.includes('from complaint_address_candidate')) {
      return [this.candidates.has(String(values[0])) ? [this.candidates.get(String(values[0]))] : [], []];
    }
    if (sql.includes('from complaint_location_clue')) {
      return [this.clues.filter((clue) => clue.complaintId === String(values[0])).map((clue) => ({
        kind: clue.kind, value: clue.value, evidence: clue.evidence, sourceField: clue.sourceField,
        start: clue.start, end: clue.end, townshipCode: clue.townshipCode, districtCode: clue.districtCode,
        parentMatch: clue.parentMatch, extractorVersion: clue.extractorVersion, snapshotId: clue.snapshotId, inputHash: clue.inputHash,
      })), []];
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
      extractorVersion: values[4], inputHash: values[5], districtCode: values[6], parentMatch: values[7], snapshotId: values[8],
    });
    if (sql.startsWith('delete from complaint_location_clue')) {
      const id = String(values[0]);
      this.clues = this.clues.filter((clue) => clue.complaintId !== id);
    }
    if (sql.includes('insert into complaint_location_clue')) {
      const [complaintId, kind, value, evidence, sourceField, start, end, townshipCode, districtCode,
        parentMatch, extractorVersion, snapshotId, inputHash] = values;
      this.clues.push({ complaintId, kind, value, evidence, sourceField, start, end, townshipCode, districtCode,
        parentMatch, extractorVersion, snapshotId, inputHash });
    }
    return [{ affectedRows: 1 }, []];
  }
}
