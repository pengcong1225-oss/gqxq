import assert from 'node:assert/strict';
import { scopedTest as test } from './helpers/scopedTest';
import { pool } from '../src/db/pool';
import type { IntakeCommand } from '../src/services/intakeService';

class MemoryConnection {
  complaint: Record<string, unknown> | null = null;
  candidate: Record<string, unknown> | null = null;
  clues: Array<Record<string, unknown>> = [];
  sequence = 0;
  candidateWrites = 0;
  clueWrites = 0;
  failCandidateWrite = false;
  failClueWriteAfterMutation = false;
  snapshot: { complaint: Record<string, unknown> | null; candidate: Record<string, unknown> | null; clues: Array<Record<string, unknown>> } | null = null;

  async beginTransaction(): Promise<void> {
    this.snapshot = {
      complaint: this.complaint ? { ...this.complaint } : null,
      candidate: this.candidate ? { ...this.candidate } : null,
      clues: this.clues.map((clue) => ({ ...clue })),
    };
  }

  async commit(): Promise<void> { this.snapshot = null; }

  async rollback(): Promise<void> {
    if (this.snapshot) {
      this.complaint = this.snapshot.complaint;
      this.candidate = this.snapshot.candidate;
      this.clues = this.snapshot.clues;
      this.snapshot = null;
    }
  }

  release(): void {}

  async query(sql: string, values: unknown[] = []): Promise<[unknown[], unknown[]]> {
    if (sql.includes('insert into number_sequence')) return [{ insertId: ++this.sequence }, []];
    if (sql.includes('from complaint c where')) {
      const row = this.complaint;
      return [row && row.source_system === values[0] && row.source_id === values[1] ? [{ ...row }] : [], []];
    }
    if (sql.includes('from complaint_address_candidate')) return [this.candidate ? [{ ...this.candidate }] : [], []];
    if (sql.includes('from complaint_location_clue')) return [this.clues.map((clue) => ({ ...clue })), []];
    if (sql.includes('from dict_item')) return [[], []];
    throw new Error(`unexpected query: ${sql}`);
  }

  async execute(sql: string, values: unknown[] = []): Promise<unknown> {
    if (sql.startsWith('insert into complaint (')) {
      const columns = sql.match(/insert into complaint \(([^)]+)\)/)?.[1].split(', ') ?? [];
      this.complaint = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('update complaint set ')) {
      if (!this.complaint) throw new Error('complaint missing');
      const setClause = sql.slice('update complaint set '.length).split(' where ')[0];
      const columns = setClause.split(', ').map((assignment) => assignment.split(' = ')[0]);
      columns.forEach((column, index) => { this.complaint![column] = values[index]; });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('complaint_address_candidate')) {
      this.candidateWrites++;
      if (this.failCandidateWrite) throw new Error('candidate write failed');
      if (sql.startsWith('insert')) {
        this.candidate = {
          complaintId: values[0], candidateText: values[1], evidenceText: values[2], sourceField: values[3],
          extractorVersion: values[4], inputHash: values[5],
        };
      } else if (sql.startsWith('update')) {
        this.candidate = {
          complaintId: values[5], candidateText: values[0], evidenceText: values[1], sourceField: values[2],
          extractorVersion: values[3], inputHash: values[4],
        };
      } else if (sql.startsWith('delete')) this.candidate = null;
      return [{ affectedRows: 1 }, []];
    }
    if (sql.includes('complaint_location_clue')) {
      this.clueWrites++;
      if (sql.startsWith('delete')) this.clues = [];
      else if (sql.startsWith('insert')) {
        this.clues.push({
          complaintId: values[0], kind: values[1], value: values[2], evidence: values[3], sourceField: values[4],
          start: values[5], end: values[6], townshipCode: values[7], districtCode: values[8], parentMatch: values[9],
          extractorVersion: values[10], snapshotId: values[11], inputHash: values[12],
        });
        if (this.failClueWriteAfterMutation) {
          this.failClueWriteAfterMutation = false;
          throw new Error('clue write failed after insert');
        }
      }
      return [{ affectedRows: 1 }, []];
    }
    // Source logs, versions and audit rows are transaction writes unrelated to this assertion.
    return [{ affectedRows: 1 }, []];
  }
}

const connection = new MemoryConnection();
const originalGetConnection = pool.getConnection;
pool.getConnection = (async () => connection) as typeof pool.getConnection;

function command(overrides: Partial<IntakeCommand> = {}): IntakeCommand {
  const title = overrides.title ?? '燃气安装';
  const content = overrides.content ?? '我是点军区联棚乡示例小区18号1301的居民，反映燃气报装进度。';
  return {
    sourceSystem: '宜接就办', sourceId: 'candidate-intake-test', channel: 'test', title, content,
    address: '来源地址原值', districtCode: null, districtName: null, longitude: null, latitude: null,
    explicitBusinessType: null, explicitComplaintType: null, explicitUrgencyLevel: null,
    sourceReportedAt: null, payload: { sourceId: 'candidate-intake-test', title, content },
    payloadHash: overrides.payloadHash ?? `hash-${title}-${content}`, warnings: [], remoteIp: null, requestId: null,
    ...overrides,
  };
}

test('creates address candidate in the same transaction and leaves source address untouched', async () => {
  const { intakeAppeal } = await import('../src/services/intakeService');
  const result = await intakeAppeal(command(), { receivedAt: new Date('2026-09-23T04:00:00Z') });
  assert.equal(result.result, 'created');
  assert.equal(connection.candidate?.candidateText, '点军区联棚乡示例小区18号1301');
  assert.equal(connection.clues.some((clue) => clue.kind === 'township' && clue.townshipCode === '420504202'), true);
  assert.equal(connection.clues.some((clue) => clue.kind === 'settlement' && clue.value === '示例小区18号1301'), true);
  assert.equal(connection.complaint?.address, '来源地址原值');
});

test('same-payload duplicate does not write or change the candidate', async () => {
  const { intakeAppeal } = await import('../src/services/intakeService');
  const before = { ...connection.candidate! };
  const writes = connection.candidateWrites;
  const cluesBefore = connection.clues.map((clue) => ({ ...clue }));
  const clueWrites = connection.clueWrites;
  const result = await intakeAppeal(command(), { receivedAt: new Date('2026-09-23T04:01:00Z') });
  assert.equal(result.result, 'duplicate_same');
  assert.equal(connection.candidateWrites, writes);
  assert.equal(connection.clueWrites, clueWrites);
  assert.deepEqual(connection.clues, cluesBefore);
  assert.deepEqual(connection.candidate, before);
});

test('changed redelivery updates or clears candidate without touching source or human correction', async () => {
  const { intakeAppeal } = await import('../src/services/intakeService');
  connection.complaint!.corrected_address = '人工纠偏地址';
  const sourceAddress = connection.complaint!.address;
  await intakeAppeal(command({
    title: '燃气安装', content: '点军区联棚乡示例小区19号1301的居民反映燃气报装进度。',
    payloadHash: 'redelivery-with-new-address',
  }), { receivedAt: new Date('2026-09-23T04:02:00Z') });
  assert.equal(connection.candidate?.candidateText, '点军区联棚乡示例小区19号1301');
  assert.equal(connection.clues.some((clue) => clue.kind === 'settlement' && clue.value === '示例小区19号1301'), true);
  assert.equal(connection.clues.some((clue) => clue.kind === 'settlement' && clue.value === '示例小区18号1301'), false);
  assert.equal(connection.complaint?.address, sourceAddress);
  assert.equal(connection.complaint?.corrected_address, '人工纠偏地址');
  await intakeAppeal(command({ title: '燃气安装', content: '什么时候可以安装？', payloadHash: 'redelivery-without-address' }),
    { receivedAt: new Date('2026-09-23T04:03:00Z') });
  assert.equal(connection.candidate, null);
  assert.deepEqual(connection.clues, []);
  assert.equal(connection.complaint?.address, sourceAddress);
  assert.equal(connection.complaint?.corrected_address, '人工纠偏地址');
});

test('clue write failure rolls back complaint, candidate, and clue changes', async () => {
  const { intakeAppeal } = await import('../src/services/intakeService');
  connection.clues = [{
    complaintId: String(connection.complaint!.complaint_id), kind: 'township', value: '联棚乡', evidence: '联棚乡',
    sourceField: 'content', start: 0, end: 3, townshipCode: '420504202', districtCode: '420504',
    parentMatch: 'unique_township', extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923',
    inputHash: 'prior-clue-hash',
  }];
  const originalComplaint = { ...connection.complaint! };
  const originalCandidate = connection.candidate ? { ...connection.candidate } : null;
  const originalClues = connection.clues.map((clue) => ({ ...clue }));
  assert.notDeepEqual(originalClues, []);
  connection.failClueWriteAfterMutation = true;
  await assert.rejects(
    intakeAppeal(command({ title: '新增投诉', content: '点军区联棚乡示例小区20号1301的居民反映。', payloadHash: 'rollback-test' }),
      { receivedAt: new Date('2026-09-23T04:04:00Z') }),
    /clue write failed after insert/
  );
  assert.deepEqual(connection.complaint, originalComplaint);
  assert.deepEqual(connection.candidate, originalCandidate);
  assert.deepEqual(connection.clues, originalClues);
});

test('restores the pool connection factory after this test file', { concurrency: false }, () => {
  pool.getConnection = originalGetConnection;
});
