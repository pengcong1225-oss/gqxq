const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const knex = require('knex');
const mysql = require('mysql2/promise');
const { refreshPendingSummary, refreshPendingSummaryFor } = require('../../src/repositories/correctionRepo');

test('pending summary publishes full and incremental refreshes atomically on isolated MySQL', {
  skip: process.env.GQXQ_ISOLATED_MIGRATION_TEST !== '1',
}, async (t) => {
  const connection = { host: '127.0.0.1', port: 13317, user: 'root', password: '' };
  const admin = await mysql.createConnection(connection);
  const database = 'gqxq_merge_pending_' + randomUUID().replaceAll('-', '');
  let created = false;
  let schema;
  let db;
  let otherInstance;

  try {
    const [[server]] = await admin.query('select @@port as port, @@datadir as datadir');
    assert.equal(Number(server.port), 13317);
    assert.match(server.datadir.replaceAll('\\', '/'), /\/gqxq-merge-mysql-20261111\/data\/$/);
    await admin.query('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci', [database]);
    created = true;
    schema = knex({ client: 'mysql2', connection: { ...connection, database } });
    db = mysql.createPool({ ...connection, database, dateStrings: true });
    otherInstance = mysql.createPool({ ...connection, database, dateStrings: true });

    await schema.raw('create table complaint (complaint_id varchar(64) primary key, deleted tinyint, location_lng decimal(9,6), location_lat decimal(9,6)) engine=InnoDB');
    await schema.raw('create table correction_item (id int auto_increment primary key, complaint_id varchar(64) not null, status varchar(24) not null, created_at datetime not null) engine=InnoDB');
    await require('../../migrations/20261110090000__location_initialization').up(schema);
    await require('../../migrations/20261119170000__correction_pending_summary').up(schema);

    const earlier = '2026-11-25 07:00:00';
    const later = '2026-11-25 08:00:00';
    const reason = '待核实'.repeat(100);
    await db.query('insert into complaint values ?', [[
      ['manual', null, 111.3, null],
      ['located', 0, 111.4, 30.6],
      ['soft-deleted', 1, null, null],
    ]]);
    await db.query('insert into correction_item (complaint_id, status, created_at) values ?', [[
      ['manual', 'pending', later],
      ['manual', 'pending', earlier],
      ['located', 'pending', later],
      ['located', 'confirmed', earlier],
      ['soft-deleted', 'pending', earlier],
      ['orphan', 'pending', earlier],
    ]]);
    await db.query('insert into complaint_location_initialization (complaint_id, input_hash, state, reason) values (?, ?, ?, ?)',
      ['manual', '0'.repeat(64), 'review', reason]);
    await db.query("insert into correction_pending_summary values ('stale', 1, 0, ?, null, now())", [earlier]);

    const read = async (reader = db) => {
      const [rows] = await reader.query(
        'select complaint_id, pending_count, first_pending_at, needs_manual_location, manual_location_reason ' +
        'from correction_pending_summary order by complaint_id',
      );
      return rows.map(Object.values);
    };
    const expected = [
      ['located', 1, later, 0, null],
      ['manual', 2, earlier, 1, reason.slice(0, 255)],
    ];

    await t.test('counts pending fields for live complaints and replaces stale rows', async () => {
      assert.equal(await refreshPendingSummary(db), 2);
      assert.deepEqual(await read(), expected);
    });

    await t.test('failed rebuild keeps the committed snapshot and releases resources for retry', async () => {
      await db.query("update correction_item set status = 'confirmed' where complaint_id = 'located'");
      await db.query('create trigger reject_pending_publish before insert on correction_pending_summary ' +
        "for each row signal sqlstate '45000' set message_text = 'fixture refresh failure'");
      try {
        await assert.rejects(refreshPendingSummary(db), /fixture refresh failure/);
        assert.deepEqual(await read(otherInstance), expected);
      } finally {
        await db.query('drop trigger if exists reject_pending_publish');
      }
      assert.equal(await refreshPendingSummary(db), 1);
      assert.deepEqual(await read(), [expected[1]]);
    });

    await t.test('multiple instances can rebuild while incremental refreshes remove stale and deleted complaints', async () => {
      await db.query("update correction_item set status = 'pending' where complaint_id = 'located' and created_at = ?", [later]);
      const [firstTotal, secondTotal] = await Promise.all([
        refreshPendingSummary(db),
        refreshPendingSummary(otherInstance),
        refreshPendingSummaryFor(otherInstance, 'located'),
      ]);
      assert.deepEqual([firstTotal, secondTotal], [2, 2]);
      assert.deepEqual(await read(), expected);

      await db.query("update complaint set deleted = 1 where complaint_id = 'located'");
      await refreshPendingSummaryFor(db, 'located');
      assert.deepEqual(await read(), [expected[1]]);
      await db.query("update correction_item set status = 'confirmed' where complaint_id = 'manual'");
      await refreshPendingSummaryFor(otherInstance, 'manual');
      assert.deepEqual(await read(), []);
      assert.equal(await refreshPendingSummary(db), 0);
    });
  } finally {
    await otherInstance?.end();
    await db?.end();
    await schema?.destroy();
    if (created) await admin.query('drop database ??', [database]);
    await admin.end();
  }
});
