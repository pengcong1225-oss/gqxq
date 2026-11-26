import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithAccessContext } from '../src/auth/accessScope';
import { pool } from '../src/db/pool';
import type { Tx } from '../src/db/tx';
import { concludeFollowup, createFollowup, getFollowups, reviseFollowup } from '../src/services/followupService';

const complaintId = 'C-1';
const timestamp = '2026-11-11T08:00:00.000Z';
const facts = {
  contacted: true, occurredAt: timestamp, evaluationCode: 'satisfied' as const,
  dissatisfactionReason: null, notes: null,
};

function asActor<T>(userId: string, run: (actor: { userId: string }) => T): T {
  return runWithAccessContext({ userId, roles: ['admin'], scopeVersion: 1, rules: [{ kind: 'all' }], canReadSource: false }, () => run({ userId }));
}

test('写入按版本保存实名，缺失实名和旧快照保留为账号', async (t) => {
  const actors = new Map([
    ['owner-id', { username: 'callback-user', real_name: '  回访员甲  ' }],
    ['supervisor-id', { username: 'supervisor-user', real_name: '主管乙' }],
    ['unnamed-id', { username: 'no-name-user', real_name: '   ' }],
  ]);
  const headers: Record<string, unknown>[] = [{
    id: 1, complaint_id: complaintId, followup_id: 'FUP-legacy', owner_id: 'owner-id', current_version: 1, created_at: timestamp,
  }];
  const revisions: Record<string, unknown>[] = [{
    followup_id: 'FUP-legacy', version: 1, action: 'create', operator_id: 'owner-id', operator_name: 'previous-login',
    operator_real_name: null, contacted: 1, occurred_at: timestamp, revised_at: timestamp, evaluation_code: 'satisfied',
  }];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql: string, [id, version]: unknown[] = []) => {
      if (sql.includes('for update') && sql.includes('platform_authorization_state')) return [[{ version: 1 }], []];
      if (sql.includes('as authorization_version')) {
        const permissions = ['complaint.read', 'followup.create', 'followup.conclude'];
        return [permissions.map(permission_code => ({ authorization_version: 1, role_code: 'admin', permission_code })), []];
      }
      if (sql.startsWith('select scope_version')) return [[{ scope_version: 1, scope_rules: [{ kind: 'all' }] }], []];
      if (sql.includes('from app_user')) return [[{ ...actors.get(String(id)), user_id: id, status: 1, account_type: 'internal' }], []];
      if (sql.includes('from complaint c')) return [[{ complaint_id: complaintId, deleted: 0 }], []];
      if (sql.includes('from manual_followup_request')) return [[], []];
      if (sql.includes('join manual_followup_revision')) {
        const history = revisions.map(revision => ({ ...headers.find(row => row.followup_id === revision.followup_id), ...revision }));
        return [sql.includes('r.version=?') ? history.filter(row => row.followup_id === id && row.version === version) : history, []];
      }
      if (sql.includes('from manual_followup h')) return [headers.filter(row => row.followup_id === id), []];
      throw new Error('Unexpected SQL: ' + sql);
    },
    execute: async (sql: string, values: unknown[]) => {
      if (sql.startsWith('insert into manual_followup(')) {
        const [followup_id, complaint_id, owner_id, created_at] = values;
        headers.push({ id: headers.length + 1, followup_id, complaint_id, owner_id, created_at, current_version: 1 });
      } else if (sql.startsWith('insert into manual_followup_revision(')) {
        const columns = sql.match(/manual_followup_revision\(([^)]+)\)/)?.[1].split(',');
        assert.equal(columns?.length, values.length);
        revisions.push(Object.fromEntries(columns!.map((name, index) => [name, values[index]])));
      } else if (sql.startsWith('update manual_followup set current_version')) {
        const [version, id] = values;
        headers.find(row => row.followup_id === id)!.current_version = version;
      } else {
        assert.match(sql, /^insert into (manual_followup_request|operation_audit_log)/);
      }
      return [{ affectedRows: 1 }, []];
    },
  } as unknown as Tx;
  t.mock.method(pool, 'getConnection', async () => connection);

  const registered = await asActor('owner-id', actor => createFollowup({ ...facts, complaintId, requestId: 'create' }, actor));
  assert.equal(registered.operatorName, '回访员甲');
  assert.equal(revisions[1].operator_real_name, '回访员甲');
  assert.equal(revisions[1].operator_name, 'callback-user');

  const updatedOwner = actors.get('owner-id')!;
  updatedOwner.real_name = '回访员丙';
  updatedOwner.username = 'callback-user-renamed';
  const concluded = await asActor('supervisor-id', actor =>
    concludeFollowup(registered.followupId, { expectedVersion: 1, requestId: 'conclude', reason: '核对记录', conclusion: '已完成' }, actor));
  assert.equal(concluded.operatorName, '主管乙');
  const corrected = await asActor('owner-id', actor =>
    reviseFollowup(registered.followupId, { ...facts, expectedVersion: 2, requestId: 'revise', reason: '补充记录' }, actor));
  assert.equal(corrected.operatorName, '回访员丙');
  const unnamed = await asActor('unnamed-id', actor => createFollowup({ ...facts, complaintId, requestId: 'unnamed' }, actor));
  assert.equal(unnamed.operatorName, '');
  assert.equal(unnamed.operatorAccount, 'no-name-user');
  assert.equal(revisions.at(-1)?.operator_real_name, null);

  const { history } = await asActor('owner-id', actor => getFollowups(complaintId, actor));
  const original = history.find(row => row.followupId === registered.followupId && row.version === 1);
  assert.equal(original?.operatorName, '回访员甲');
  const legacy = history.find(row => row.followupId === 'FUP-legacy')!;
  assert.equal(legacy.operatorName, '');
  assert.equal(legacy.operatorAccount, 'previous-login');
});
