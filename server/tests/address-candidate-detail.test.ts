import assert from 'node:assert/strict';
import test from 'node:test';

test('complaint detail projects stored clue evidence, derives conflict, and keeps old M12 metadata null', { concurrency: false }, async () => {
  const { pool } = await import('../src/db/pool');
  const { getComplaintDetail } = await import('../src/services/complaintService');
  const originalQuery = pool.query;
  const queries: string[] = [];
  const clues = [
    {
      kind: 'township', value: '联棚乡', evidence: '联棚乡', sourceField: 'content', start: 2, end: 5,
      townshipCode: '420504202', districtCode: '420504', parentMatch: 'unique_township',
      extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923', inputHash: 'stored-hash',
    },
    {
      kind: 'township', value: '艾家镇', evidence: '艾家镇', sourceField: 'title', start: 0, end: 3,
      townshipCode: '420504101', districtCode: '420504', parentMatch: 'unique_township',
      extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923', inputHash: 'stored-hash',
    },
  ];
  let includeClues = true;
  let includeCandidate = true;
  pool.query = (async (sql: string) => {
    queries.push(sql);
    if (sql.includes('from complaint_address_candidate')) return [includeCandidate ? [{
      candidateText: '点军区联棚乡示例小区18号1301', evidenceText: '点军区联棚乡示例小区18号1301',
      sourceField: 'content', extractorVersion: 'address-extract.v1', inputHash: 'test-hash',
    }] : [], []] as never;
    if (sql.includes('from complaint_location_clue')) return [includeClues ? clues : [], []] as never;
    return [[{
      id: 42, complaint_id: 'CANDIDATE-42', complaint_no: 'CANDIDATE-42', title: '虚构地址测试',
      content: '虚构测试内容', address: '来源地址不变', corrected_address: null, rule_confidence: 0.72,
      rule_version: 'classify.v1+sensitive_word/3', status: 'pending', correction_status: 'pending',
    }], []] as never;
  }) as typeof pool.query;
  try {
    const detail = await getComplaintDetail('42');
    assert.deepEqual(detail.addressCandidate, {
      value: '点军区联棚乡示例小区18号1301', evidence: '点军区联棚乡示例小区18号1301',
      sourceField: 'content', extractorVersion: 'address-extract.v1',
      districtCode: null, parentMatch: null, snapshotId: null,
    });
    assert.equal(detail.address, '来源地址不变');
    assert.equal(detail.locationConflict, true);
    assert.deepEqual(detail.locationClues.map(({ kind, value, evidence, sourceField, districtCode, districtName }) => ({
      kind, value, evidence, sourceField, districtCode, districtName,
    })), [
      { kind: 'township', value: '联棚乡', evidence: '联棚乡', sourceField: 'content', districtCode: '420504', districtName: '点军区' },
      { kind: 'township', value: '艾家镇', evidence: '艾家镇', sourceField: 'title', districtCode: '420504', districtName: '点军区' },
    ]);
    assert.equal(queries.filter((sql) => sql.includes('complaint_location_clue')).length, 1);
    assert.equal(queries.filter((sql) => sql.includes('complaint_address_candidate')).length, 1);
    includeClues = false;
    includeCandidate = false;
    assert.equal((await getComplaintDetail('42')).addressCandidate, null);
  } finally { pool.query = originalQuery; }
});
