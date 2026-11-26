const assert = require('node:assert/strict');
const test = require('node:test');
const knex = require('knex');
const original = require('../migrations/20261120090000__complaint_stats_covering_index');
const filters = require('../migrations/20261120095000__complaint_stats_cover_fix_deleted');
const source = require('../migrations/20261120100000__complaint_stats_cover_add_source_id');

test('complaint index migrations preserve the previous index version on failure and rollback', {
  skip: process.env.GQXQ_ISOLATED_MIGRATION_TEST !== '1',
}, async () => {
  const connection = { host: '127.0.0.1', port: 13317, user: 'root', password: '' };
  const admin = knex({ client: 'mysql2', connection, pool: { min: 0, max: 1 } });
  let db;

  try {
    const [[server]] = await admin.raw('select @@port as port, @@datadir as datadir');
    assert.equal(Number(server.port), 13317);
    assert.match(String(server.datadir).replaceAll('\\', '/'), /gqxq-merge-mysql-20261111\/data\/$/);
    const database = `gqxq_complaint_index_${process.pid}_test`;
    await admin.raw('create database ??', [database]);
    db = knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 0, max: 1 } });
    await db.raw(`create table complaint (
      id int primary key, source_reported_at datetime, business_type varchar(32),
      minor_category_code varchar(64), major_category_code varchar(64),
      admin_grid_code varchar(64), district_code varchar(64), deleted tinyint,
      source_system varchar(64)
    ) engine=InnoDB default charset=utf8mb4`);
    await db('complaint').insert({ id: 1 });

    const columns = async () => {
      const [rows] = await db.raw(`select index_name as name, column_name as columnName
        from information_schema.statistics where table_schema = database() and table_name = 'complaint'
        and index_name in ('idx_complaint_stats_cover', 'idx_complaint_stats_district')
        order by index_name, seq_in_index`);
      const grouped = Object.groupBy(rows, row => row.name);
      return Object.fromEntries(Object.entries(grouped)
        .map(([name, indexes]) => [name, indexes.map(index => index.columnName)]));
    };
    const originalCover = ['source_reported_at', 'business_type', 'minor_category_code', 'major_category_code', 'admin_grid_code'];
    const originalDistrict = ['source_reported_at', 'business_type', 'district_code'];
    const withFilters = ['deleted', 'source_system'];

    await original.up(db);
    const beforeFilters = await columns();
    assert.deepEqual(beforeFilters, {
      idx_complaint_stats_cover: originalCover,
      idx_complaint_stats_district: originalDistrict,
    });
    await filters.up(db);
    const beforeSource = await columns();
    assert.deepEqual(beforeSource, {
      idx_complaint_stats_cover: [...originalCover, ...withFilters],
      idx_complaint_stats_district: [...originalDistrict, ...withFilters],
    });
    await assert.rejects(source.up(db), { code: 'ER_KEY_COLUMN_DOES_NOT_EXITS' });
    assert.deepEqual(await columns(), beforeSource);

    await db.raw('alter table complaint add column source_id varchar(128)');
    await source.up(db);
    await source.up(db);
    assert.deepEqual(await columns(), {
      ...beforeSource,
      idx_complaint_stats_cover: [...originalCover, ...withFilters, 'source_id'],
    });
    await source.down(db);
    assert.deepEqual(await columns(), beforeSource);
    await filters.down(db);
    assert.deepEqual(await columns(), beforeFilters);

    await db.raw('alter table complaint drop index idx_complaint_stats_district, add unique index idx_complaint_stats_district (district_code)');
    await assert.rejects(filters.up(db), /incompatible.*idx_complaint_stats_district/i);
    assert.deepEqual((await columns()).idx_complaint_stats_cover, originalCover);

    // A database interrupted by the original two-statement migration can lack an index.
    await db.raw('alter table complaint drop index idx_complaint_stats_district');
    await filters.up(db);
    await filters.up(db);
    assert.deepEqual(await columns(), beforeSource);

    assert.deepEqual(await db('complaint').select('id'), [{ id: 1 }]);
  } finally {
    if (db) await db.destroy();
    await admin.destroy();
  }
});
