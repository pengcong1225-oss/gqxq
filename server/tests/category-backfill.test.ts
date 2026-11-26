import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tx } from '../src/db/tx';
import type { MasterDataContext } from '../src/types/masterData';
import { applyCategoryBackfillIn, previewCategoryBackfillIn } from '../src/services/categoryBackfillService';

const context: MasterDataContext = {
  userId: 'operator',
  userName: '验收人员',
  clientIp: null,
  permissionCodes: ['complaint.correct'],
  access: { userId: 'operator', roles: ['admin'], rules: [{ kind: 'all' }], scopeVersion: 1, canReadSource: false },
};
const dictionary = [
  { code: 'water_service', label: '供水服务', parentCode: null },
  { code: 'w11', label: '农村停水问题', parentCode: 'water_service' },
  { code: 'w01', label: '城镇停水问题', parentCode: 'water_service' },
].map(item => ({ ...item, status: 'enabled', published: 1 }));
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  complaint_id: id, complaint_no: id, business_type: 'water', deleted: 0, analysis_included: 0,
  major_category_code: null, minor_category_code: null, category_dictionary_version: null, edit_version: 3,
  source_log_id: 'log-' + id, source_major_label: '供水服务', source_minor_label: '农村停水问题',
  has_category_revision: 0, has_analysis_record: 0, effective_field_state: null, ...overrides,
});

function fixture() {
  let rows = [
    row('rural'),
    row('manual', { effective_field_state: { minor_category_code: { resolution: 'no_correction' } } }),
    row('history', { has_category_revision: 1 }),
    row('outside', { source_major_label: '供气服务' }),
    row('fuzzy', { source_minor_label: '农村供水停水问题' }),
    row('frozen', { has_analysis_record: 1 }),
  ];
  const mutations: { sql: string; args: unknown[] }[] = [];
  const db = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes('from dict_type')) return [[{ code: 'complaint_category', status: 'enabled', published: 1, version: 29 }]];
      if (sql.includes('from dict_item')) return [dictionary];
      if (sql.startsWith('select complaint_id,complaint_no')) return [rows.filter(r => r.complaint_id === args[0])];
      if (sql.includes('from complaint c')) return [rows.filter(r => r.major_category_code === null)];
      if (sql.includes('from analysis_record')) return [[]];
      throw new Error('Unexpected query ' + sql);
    },
    execute: async (sql: string, args: unknown[]) => {
      mutations.push({ sql, args });
      if (sql.startsWith('update complaint set major_category_code=')) {
        rows = rows.map(r => r.complaint_id === args[4] ? { ...r, major_category_code: args[0], minor_category_code: args[1] } : r);
      }
      return [{}];
    },
  } as unknown as Tx;
  return { db, mutations, updateSource: () => { rows[0].source_log_id = 'newer-log'; } };
}

test('repair uses exact published parent and minor labels, then preserves existing decisions and is repeatable', async () => {
  const { db, mutations } = fixture();
  const preview = await previewCategoryBackfillIn(db, context);
  assert.equal(preview.candidates, 1);
  assert.deepEqual(preview.byCategory, [{ majorCode: 'water_service', minorCode: 'w11', minorName: '农村停水问题', count: 1 }]);
  assert.equal(preview.remaining, 5);
  assert.equal(mutations.length, 0);

  const applied = await applyCategoryBackfillIn(db, context, preview.digest);
  assert.equal(applied.revised, 1);
  const revision = mutations.find(o => o.sql.includes('insert into complaint_category_revision'));
  assert.equal(revision?.args[1], 'rural');
  assert.deepEqual(revision?.args.slice(5, 10), ['water_service', 'w11', '29', 4, 'operator']);
  assert.match(String(revision?.args[10]), /log-rural/);
  assert.equal((await previewCategoryBackfillIn(db, context)).candidates, 0);
  await assert.rejects(() => applyCategoryBackfillIn(db, context, preview.digest), /预览已变化/);
});

test('new source evidence invalidates the preview without applying a change', async () => {
  const { db, mutations, updateSource } = fixture();
  const preview = await previewCategoryBackfillIn(db, context);
  updateSource();
  await assert.rejects(() => applyCategoryBackfillIn(db, context, preview.digest), /预览已变化/);
  assert.equal(mutations.length, 0);
});
