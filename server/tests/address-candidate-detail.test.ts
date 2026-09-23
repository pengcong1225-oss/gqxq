import assert from 'node:assert/strict';
import test from 'node:test';

test('complaint detail returns the four address candidate fields or null from a separate query', { concurrency: false }, async () => {
  const { pool } = await import('../src/db/pool');
  const { getComplaintDetail } = await import('../src/services/complaintService');
  const originalQuery = pool.query;
  const queries: string[] = [];
  pool.query = (async (sql: string) => {
    queries.push(sql);
    if (sql.includes('from complaint_address_candidate')) return [[{
      candidateText: '点军区联棚乡示例小区18号1301', evidenceText: '点军区联棚乡示例小区18号1301',
      sourceField: 'content', extractorVersion: 'address-extract.v1', inputHash: 'test-hash',
    }], []] as never;
    return [[{
      id: 42, complaint_id: 'CANDIDATE-42', complaint_no: 'CANDIDATE-42', title: '虚构地址测试',
      content: '虚构测试内容', address: '来源地址不变', corrected_address: null, rule_confidence: 0.72,
      rule_version: 'classify.v1+sensitive_word/3', status: 'pending',
    }], []] as never;
  }) as typeof pool.query;
  try {
    const detail = await getComplaintDetail('42');
    assert.deepEqual(detail.addressCandidate, {
      value: '点军区联棚乡示例小区18号1301', evidence: '点军区联棚乡示例小区18号1301',
      sourceField: 'content', extractorVersion: 'address-extract.v1',
    });
    assert.equal(detail.address, '来源地址不变');
    assert.equal(queries.filter((sql) => sql.includes('complaint_address_candidate')).length, 1);
    pool.query = (async (sql: string) => sql.includes('from complaint_address_candidate') ? [[], []] as never : [[{
      id: 42, complaint_id: 'CANDIDATE-42', complaint_no: 'CANDIDATE-42', title: '虚构地址测试', status: 'pending',
    }], []] as never) as typeof pool.query;
    assert.equal((await getComplaintDetail('42')).addressCandidate, null);
  } finally { pool.query = originalQuery; }
});
