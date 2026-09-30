import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLocationClues, syncLocationClues, type LocationClueRow } from '../src/repositories/locationClueRepo';
import type { Queryable } from '../src/repositories/complaintSourceLogRepo';

class LocationClueFake {
  rows: LocationClueRow[] = [];
  sqlWrites: string[] = [];

  async query(sql: string, values: unknown[] = []): Promise<[unknown[], unknown[]]> {
    if (!sql.toLowerCase().includes('select') || !sql.includes('complaint_location_clue')) {
      throw new Error(`unexpected query: ${sql}`);
    }
    const complaintId = String(values[0]);
    return [this.rows.filter((row) => (row as LocationClueRow & { complaintId?: string }).complaintId === complaintId)
      .map((row) => ({ ...row })), []];
  }

  async execute(sql: string, values: unknown[] = []): Promise<unknown> {
    this.sqlWrites.push(sql);
    if (sql.toLowerCase().startsWith('delete from complaint_location_clue')) {
      const complaintId = String(values[0]);
      this.rows = this.rows.filter((row) => (row as LocationClueRow & { complaintId?: string }).complaintId !== complaintId);
    } else if (sql.toLowerCase().startsWith('insert into complaint_location_clue')) {
      const [complaintId, kind, value, evidence, sourceField, start, end, townshipCode, districtCode, parentMatch,
        extractorVersion, snapshotId, inputHash] = values;
      this.rows.push({
        kind: String(kind) as LocationClueRow['kind'], value: String(value), evidence: String(evidence),
        sourceField: String(sourceField) as LocationClueRow['sourceField'], start: Number(start), end: Number(end),
        townshipCode: townshipCode === null ? null : String(townshipCode),
        districtCode: districtCode === null ? null : String(districtCode),
        parentMatch: String(parentMatch) as LocationClueRow['parentMatch'],
        extractorVersion: String(extractorVersion), snapshotId: String(snapshotId), inputHash: String(inputHash),
        complaintId: String(complaintId),
      } as LocationClueRow);
    } else {
      throw new Error(`unexpected write: ${sql}`);
    }
    return [{ affectedRows: 1 }, []];
  }
}

function fakeDb(): LocationClueFake & Queryable {
  return new LocationClueFake() as unknown as LocationClueFake & Queryable;
}

test('creates all machine clues once and leaves the same input unchanged on retry', async () => {
  const db = fakeDb();
  const input = { title: '核查', content: '联棚乡示例村' };

  assert.equal(await syncLocationClues(db, 'C1', input), 'created');
  assert.equal((await findLocationClues(db, 'C1')).length, 2);
  const writesAfterCreate = db.sqlWrites.length;
  assert.equal(await syncLocationClues(db, 'C1', input), 'unchanged');
  assert.equal(db.sqlWrites.length, writesAfterCreate);
});

test('replaces only this complaint machine clue set when the source text changes', async () => {
  const db = fakeDb();
  const otherComplaintClue = { kind: 'township', value: '艾家镇', complaintId: 'C2' } as LocationClueRow;
  db.rows.push(otherComplaintClue);

  assert.equal(await syncLocationClues(db, 'C1', { title: '核查', content: '联棚乡示例村' }), 'created');
  assert.equal(await syncLocationClues(db, 'C1', { title: '核查', content: '联棚乡新示例村' }), 'updated');
  assert.deepEqual(db.rows.filter((row) => (row as LocationClueRow & { complaintId?: string }).complaintId === 'C2'), [otherComplaintClue]);
  assert.ok((await findLocationClues(db, 'C1')).some((row) => row.value === '新示例村'));
  assert.equal(db.sqlWrites.some((sql) => /update\s+(complaint|correction_item|address_correction)|longitude|latitude/i.test(sql)), false);
});

test('removes the machine clue set when a changed complaint has no location clue', async () => {
  const db = fakeDb();
  assert.equal(await syncLocationClues(db, 'C1', { title: '核查', content: '联棚乡' }), 'created');
  assert.equal(await syncLocationClues(db, 'C1', { title: '催办', content: '请尽快处理，谢谢' }), 'removed');
  assert.deepEqual(await findLocationClues(db, 'C1'), []);
});

test('preserves both conflicting township clues for human review', async () => {
  const db = fakeDb();
  assert.equal(await syncLocationClues(db, 'C1', { title: '核查', content: '联棚乡与艾家镇两处' }), 'created');
  assert.deepEqual((await findLocationClues(db, 'C1')).filter((row) => row.kind === 'township').map((row) => row.value), [
    '联棚乡', '艾家镇',
  ]);
});
