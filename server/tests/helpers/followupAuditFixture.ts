import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Knex} from 'knex';
const require=createRequire(import.meta.url);
/** Older audit-only contracts need the REAL C3 indirect-link tables, not fake
 * account columns. Full account fixtures independently apply identity migration. */
export async function prepareFollowupAuditFixture(db:Knex) {
 const [rows]=await db.raw('select database() as db');const name=String(rows[0].db);
 assert.ok(['gqxq_b1_contract_test','gqxq_b2_contract_test','gqxq_b3_contract_test','gqxq_b4_contract_test','gqxq_a6_contract_test','gqxq_c2_contract_test','gqxq_c3_contract_test'].includes(name));
 assert.equal(process.env.GQXQ_DB_NAME,name);assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');
 for(const table of ['manual_followup_request','manual_followup_revision','manual_followup'])await db.schema.dropTableIfExists(table);
 await require('../../migrations/20261009130001__manual_complaint_followups.js').ensureFollowupTables(db);
}
