import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Knex } from 'knex';
const require = createRequire(import.meta.url);
/** Declared audit-only synthetic contract. The real D3 helper owns added DDL. */
export async function prepareReportAuditFixture(db: Knex) {
    const [rows] = await db.raw('select database() as db');
    const name = String(rows[0].db);
    assert.ok(['gqxq_b1_contract_test', 'gqxq_b2_contract_test', 'gqxq_a6_contract_test', 'gqxq_c3_contract_test'].includes(name));
    assert.equal(process.env.GQXQ_DB_NAME, name);
    assert.equal(process.env.GQXQ_DB_HOST, '127.0.0.1');
    assert.equal(process.env.GQXQ_DB_PORT, '3306');
    for (const table of ['report_artifact', 'report_scope_proof', 'report_job', 'statistics_snapshot', 'report_record'])
        await db.schema.dropTableIfExists(table);
    await db.raw('create table report_record(id bigint auto_increment primary key,report_title varchar(255) not null,preview_content longtext null,date_from date null,date_to date null,template_version varchar(64) null) engine=InnoDB default charset=utf8mb4');
    await require('../../migrations/20261009170000__report_artifacts.js').ensureReportTables(db);
}
