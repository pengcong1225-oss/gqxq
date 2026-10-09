import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import knexFactory from 'knex';
import { prepareReportFixture } from './helpers/reportDbFixture';
const require = createRequire(import.meta.url);
test('final migration real isolated contracts', { skip: process.env.GQXQ_D3_COMPONENT_DB !== 'gqxq_d3_contract_test' }, async (t) => {
    assert.equal(process.env.GQXQ_DB_NAME, 'gqxq_d3_contract_test');
    assert.equal(process.env.GQXQ_DB_HOST, '127.0.0.1');
    assert.equal(process.env.GQXQ_DB_PORT, '3306');
    const db = knexFactory({ client: 'mysql2', connection: { host: '127.0.0.1', port: 3306, user: process.env.GQXQ_DB_USER, password: process.env.GQXQ_DB_PASSWORD, database: 'gqxq_d3_contract_test' } });
    const migration = (file: string) => require('../migrations/' + file + '.js');
    const d3 = migration('20261009170000__report_artifacts');
    try {
        await t.test('A2 missing A5 fails before DDL and restored dependency retries without resurrecting revocation', async () => {
            await db.schema.dropTableIfExists('app_user');
            await db.schema.dropTableIfExists('platform_authorization_state');
            await db.raw('create table app_user(id bigint primary key auto_increment,user_id varchar(64) not null unique,status tinyint not null,session_version bigint not null default 1) engine=InnoDB');
            await db('app_user').insert({ user_id: 'legacy', status: 1 });
            const a2 = migration('20261009040000__user_object_scopes');
            await assert.rejects(() => a2.up(db));
            assert.equal(await db.schema.hasColumn('app_user', 'scope_rules'), false, 'dependency failure must perform zero scope DDL');
            await db.raw('create table platform_authorization_state(id int primary key,version bigint not null) engine=InnoDB');
            await db('platform_authorization_state').insert({ id: 1, version: 1 });
            await a2.up(db);
            let user = await db('app_user').first();
            assert.match(user.scope_provenance, /legacy-all-bootstrap/);
            await db('app_user').update({ scope_rules: JSON.stringify([]), scope_version: 2, scope_provenance: 'administrator-configured' });
            await a2.up(db);
            user = await db('app_user').first();
            assert.deepEqual(typeof user.scope_rules === 'string' ? JSON.parse(user.scope_rules) : user.scope_rules, []);
            assert.equal(user.scope_version, 2);
        });
        await t.test('A2 interrupted bootstrap resumes only original unchanged identities; ambiguous old columns refuse', async () => {
            const a2 = migration('20261009040000__user_object_scopes');
            await db.schema.dropTable('app_user');
            await db.schema.dropTable('platform_authorization_state');
            await db.raw('create table app_user(id bigint primary key auto_increment,user_id varchar(64) not null unique,status tinyint not null,session_version bigint not null default 1) engine=InnoDB');
            await db('app_user').insert({ user_id: 'original', status: 1 });
            await db.raw('create table platform_authorization_state(id int primary key,version bigint not null) engine=InnoDB');
            await db('platform_authorization_state').insert({ id: 1, version: 1 });
            const raw = db.raw.bind(db);
            let stop = true;
            const guarded: any = (table: string) => db(table);
            guarded.schema = db.schema;
            guarded.transaction = db.transaction.bind(db);
            guarded.raw = (sql: string, ...args: any[]) => { if (stop && sql.startsWith('alter table app_user')) {
                stop = false;
                throw Error('synthetic interrupted scope DDL');
            } return raw(sql, ...args); };
            await assert.rejects(() => a2.up(guarded), /interrupted/);
            assert.equal(await db.schema.hasColumn('app_user', 'scope_rules'), false);
            await db('app_user').insert({ user_id: 'new-after-checkpoint', status: 1 });
            await a2.up(db);
            assert.match((await db('app_user').where('user_id', 'original').first()).scope_provenance, /legacy-all-bootstrap/);
            assert.equal((await db('app_user').where('user_id', 'new-after-checkpoint').first()).scope_rules, null);
            // Simulate an interruption after scope DDL, followed by an administrator's
            // deliberate deny using the same text/null but an advanced scope version.
            await db('platform_authorization_state').update({ scope_bootstrap_state: 'pending' });
            await db('app_user').where('user_id', 'original').update({ scope_rules: null, scope_provenance: 'new-account-deny', scope_version: 2 });
            await a2.up(db);
            assert.equal((await db('app_user').where('user_id', 'original').first()).scope_rules, null);
            const checkpoint = await db('platform_authorization_state').first();
            const inventory = typeof checkpoint.scope_bootstrap_users === 'string' ? JSON.parse(checkpoint.scope_bootstrap_users) : checkpoint.scope_bootstrap_users;
            assert.equal(inventory.skipped[0].userId, 'original');
            await db.raw('alter table platform_authorization_state drop column scope_bootstrap_state,drop column scope_bootstrap_users');
            await assert.rejects(() => a2.up(db), /ambiguous.*recovery/i);
        });
        await t.test('B1 and B2 reject misleading stable index names before DDL and accept alternate complete keys', async () => {
            for (const [file, table, key, wrong, missing] of [
                ['20261009070000__dictionary_governance_categories', 'dict_type', 'uk_b1_dictionary_type', 'dict_name', 'version'],
                ['20261009080000__enterprise_management', 'enterprise', 'uk_b2_enterprise_code', 'enterprise_name', 'address'],
            ]) {
                await prepareReportFixture(db);
                const [originalKeys] = await db.raw('show index from ??', [table]);
                const field = table === 'enterprise' ? 'enterprise_code' : 'dict_type';
                for (const name of new Set(originalKeys.filter((r: any) => Number(r.Non_unique) === 0 && r.Column_name === field).map((r: any) => r.Key_name)))
                    await db.raw('alter table ?? drop index ??', [table, name]);
                await db.raw('alter table ?? add index ?? (??),drop column ??', [table, key, wrong, missing]);
                await assert.rejects(() => migration(file).up(db), /stable.*key|identity/i);
                assert.equal(await db.schema.hasColumn(table, missing), false);
                await prepareReportFixture(db);
                const [proper] = await db.raw('show index from ??', [table]);
                const identity = proper.find((r: any) => Number(r.Non_unique) === 0 && r.Column_name === field);
                await db.raw('alter table ?? rename index ?? to verified_alternative', [table, identity.Key_name]);
                await migration(file).up(db);
                const [indexes] = await db.raw('show index from ??', [table]);
                assert.equal(indexes.some((r: any) => r.Key_name === key), false, 'do not require canonical name when exact full identity exists');
            }
        });
        await t.test('A2 marker-only interruption resumes; invalid pending evidence refuses before scope DDL', async () => {
            const a2 = migration('20261009040000__user_object_scopes');
            await db.schema.dropTable('app_user');
            await db.schema.dropTable('platform_authorization_state');
            await db.raw('create table app_user(id bigint primary key auto_increment,user_id varchar(64) not null unique,status tinyint not null,session_version bigint not null default 1) engine=InnoDB');
            await db('app_user').insert({ user_id: 'marker-original', status: 1 });
            await db.raw('create table platform_authorization_state(id int primary key,version bigint not null) engine=InnoDB');
            await db('platform_authorization_state').insert({ id: 1, version: 1 });
            const guarded: any = (table: string) => db(table);
            guarded.raw = db.raw.bind(db);
            guarded.schema = db.schema;
            guarded.transaction = async () => { throw Error('synthetic before inventory transaction'); };
            await assert.rejects(() => a2.up(guarded), /before inventory/);
            assert.equal((await db('platform_authorization_state').first()).scope_bootstrap_state, null);
            assert.equal(await db.schema.hasColumn('app_user', 'scope_rules'), false);
            await db('platform_authorization_state').update({ scope_bootstrap_state: 'pending', scope_bootstrap_users: '{"users":[{}]}' });
            await assert.rejects(() => a2.up(db), /ambiguous inventory/);
            assert.equal(await db.schema.hasColumn('app_user', 'scope_rules'), false);
            await db('platform_authorization_state').update({ scope_bootstrap_state: null, scope_bootstrap_users: null });
            await a2.up(db);
            assert.equal((await db('platform_authorization_state').first()).scope_bootstrap_state, 'complete');
            assert.match((await db('app_user').first()).scope_provenance, /legacy-all-bootstrap/);
        });
        await t.test('B3 prefix unique identity refuses before any missing owned DDL', async () => {
            await prepareReportFixture(db);
            await db.schema.dropTable('community');
            await db.raw('alter table service_grid drop index grid_code,add unique index prefix_grid(grid_code(8))');
            await assert.rejects(() => migration('20261009090000__service_grid_coverage').up(db), /unique.*service_grid/);
            assert.equal(await db.schema.hasTable('community'), false);
        });
        await t.test('B4 composite batch primary key and duplicate IDs across owners refuse without modifying data', async () => {
            await prepareReportFixture(db);
            await db.schema.dropTableIfExists('master_data_import_batch');
            const b4 = migration('20261009100000__master_data_import');
            await b4.up(db);
            await db.raw('alter table master_data_import_batch drop primary key,add primary key(batch_id,owner_id)');
            for (const owner of ['owner1', 'owner2'])
                await db('master_data_import_batch').insert({ batch_id: 'same', owner_id: owner, kind: 'enterprise', file_hash: '0'.repeat(64), preview: '{}', details: '{}', scope_proofs: '[]', access_version: 1, expires_at: new Date(), created_at: new Date() });
            const before = await db('master_data_import_batch').orderBy('owner_id');
            await assert.rejects(() => b4.up(db), /batch key/);
            assert.deepEqual(await db('master_data_import_batch').orderBy('owner_id'), before);
        });
        await t.test('D3 helper is real and idempotent without capability seeds; full up rejects matching MyISAM dependencies', async () => {
            await prepareReportFixture(db);
            const grants = await db('platform_role_permission').orderBy(['role_code', 'permission_code']);
            const state = await db('platform_authorization_state').first();
            const legacy = await db('report_record').first();
            assert.equal(typeof d3.ensureReportTables, 'function');
            await d3.ensureReportTables(db);
            await d3.ensureReportTables(db);
            assert.deepEqual(await db('platform_role_permission').orderBy(['role_code', 'permission_code']), grants);
            assert.deepEqual(await db('platform_authorization_state').first(), state);
            const after = await db('report_record').first();
            assert.equal(after.id, legacy.id);
            assert.equal(after.preview_content, legacy.preview_content);
            for (const target of ['report_job', 'report_artifact', 'report_record', 'report_todo', 'operation_audit_log', 'app_user', 'platform_authorization_state', 'enterprise']) {
                await prepareReportFixture(db);
                await d3.up(db);
                await db.schema.dropTable('statistics_snapshot');
                await db.raw('alter table ?? engine=MyISAM', [target]);
                await assert.rejects(() => d3.up(db), /InnoDB/);
                assert.equal(await db.schema.hasTable('statistics_snapshot'), false);
                if (['report_job', 'report_artifact', 'report_record'].includes(target))
                    await assert.rejects(() => d3.ensureReportTables(db), /InnoDB/);
                assert.equal(await db.schema.hasTable('statistics_snapshot'), false, 'helper engine refusal must also precede owned DDL');
            }
        });
        await t.test('D3 helper and full up reject late prefix identity before earlier owned DDL', async () => {
            for (const method of ['ensureReportTables', 'up']) {
                await prepareReportFixture(db);
                await d3.up(db);
                await db.schema.dropTable('statistics_snapshot');
                await db.raw('alter table report_job drop index uk_report_request,add unique index uk_report_request(creator_id(8),request_id)');
                const legacy = await db('report_record');
                const grants = await db('platform_role_permission');
                await assert.rejects(() => d3[method](db), /full unique/);
                assert.equal(await db.schema.hasTable('statistics_snapshot'), false);
                assert.deepEqual(await db('report_record'), legacy);
                assert.deepEqual(await db('platform_role_permission'), grants);
            }
        });
        await t.test('D3 late success-audit failure rolls back artifact, job and todo; same frozen claim recovers', async () => {
            await prepareReportFixture(db);
            await d3.up(db);
            const { pool } = await import('../src/db/pool');
            const service = await import('../src/services/reportService');
            const repo = await import('../src/repositories/reportRepo');
            const access = { userId: 'synthetic', roles: ['admin'], scopeVersion: 1, rules: [{ kind: 'all' as const }], canReadSource: false };
            const ctx = { userId: 'synthetic', userName: 'Synthetic', clientIp: null, access, permissionCodes: [] };
            try {
                await db('app_user').insert({ user_id: 'synthetic', username: 'synthetic', password_hash: 'synthetic', roles: JSON.stringify(['admin']), status: 1, scope_rules: JSON.stringify([{ kind: 'all' }]), scope_version: 1, must_change_password: 0, account_type: 'internal' });
                await db('enterprise').insert({ enterprise_code: 'E1', enterprise_name: '合成企业', business_type: 'water', status: 'enabled', version: 1, district_code: 'D1' });
                await db('complaint').insert({ complaint_id: 'C1', complaint_no: 'NO-C1', business_type: 'water', enterprise_code: 'E1', district_code: 'D1', source_reported_at: '2026-09-10 08:00:00', received_at: '2026-09-10 08:00:00', edit_version: 1 });
                await db('analysis_record').insert({ analysis_id: 'A-C1', complaint_id: 'C1', confirmed_at: '2026-09-10 08:00:00' });
                await db('report_todo').insert({ todo_id: 'T-C1', analysis_id: 'A-C1', complaint_id: 'C1', status: 'pending' });
                const report = await service.createReport({ requestId: 'final-late-audit', templateCode: 'statistics-draft', templateVersion: 'v1', format: 'docx', todoIds: ['T-C1'], query: { dataset: 'analysis', projection: 'current', periodKind: 'month', from: '2026-09-01', to: '2026-09-30', comparisonPolicyId: 'candidate-calendar-v1', enterpriseCode: 'E1' } }, ctx);
                const connection = await pool.getConnection();
                let claim;
                try {
                    await connection.beginTransaction();
                    claim = await repo.claimReport(connection, report.reportId, 60000);
                    await connection.commit();
                }
                finally {
                    connection.release();
                }
                assert.ok(claim);
                const frozen = (await db('statistics_snapshot').where('snapshot_id', report.snapshotId).first()).snapshot_bytes;
                const job = await db('report_job').where('report_id', report.reportId).first();
                const todo = await db('report_todo').where('todo_id', 'T-C1').first();
                const legacy = await db('report_record').orderBy('id');
                await db.raw("create trigger final_fail_report_audit before insert on operation_audit_log for each row begin if NEW.action='REPORT_GENERATE' and NEW.result='success' then signal sqlstate '45000' set message_text='synthetic late report audit failure'; end if; end");
                // Finalization accepts renderer-owned bytes; this test isolates publication
                // rollback, uses synthetic bytes and never renders/replaces Office evidence.
                const bytes = Buffer.from('synthetic publication transaction bytes');
                try {
                    await assert.rejects(() => service.finalizeReport(claim!, bytes), /synthetic late report audit failure/);
                }
                finally {
                    await db.raw('drop trigger if exists final_fail_report_audit');
                }
                assert.equal((await db('report_artifact').where('report_id', report.reportId)).length, 0);
                assert.deepEqual(await db('report_job').where('report_id', report.reportId).first(), job);
                assert.deepEqual(await db('report_todo').where('todo_id', 'T-C1').first(), todo);
                assert.deepEqual(await db('report_record').orderBy('id'), legacy);
                assert.deepEqual((await db('statistics_snapshot').where('snapshot_id', report.snapshotId).first()).snapshot_bytes, frozen);
                assert.equal(await service.finalizeReport(claim, bytes), true);
                assert.equal((await db('report_todo').where('todo_id', 'T-C1').first()).report_id, report.reportId);
                assert.equal((await db('report_artifact').where('report_id', report.reportId)).length, 1);
            }
            finally {
                await db.raw('drop trigger if exists final_fail_report_audit');
                await pool.end();
            }
        });
        await t.test('D3 helper and full up reject generated legacy insert targets before owned DDL', async () => {
            for (const method of ['ensureReportTables', 'up'])
                for (const field of ['report_title', 'd3_report_id']) {
                    await prepareReportFixture(db);
                    if (field === 'report_title')
                        await db.raw("alter table report_record modify report_title varchar(255) generated always as ('synthetic generated') stored");
                    else
                        await db.raw('alter table report_record add d3_report_id varchar(64) generated always as (null) stored,add unique key uk_generated(d3_report_id)');
                    const before = await db('report_record');
                    await assert.rejects(() => d3[method](db), /generated insert/);
                    for (const name of ['statistics_snapshot', 'report_scope_proof', 'report_job', 'report_artifact'])
                        assert.equal(await db.schema.hasTable(name), false);
                    if (field === 'report_title')
                        assert.equal(await db.schema.hasColumn('report_record', 'd3_report_id'), false);
                    assert.deepEqual(await db('report_record'), before);
                }
        });
    }
    finally {
        await db.destroy();
    }
});
