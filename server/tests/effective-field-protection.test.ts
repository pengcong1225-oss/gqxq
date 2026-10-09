import assert from 'node:assert/strict';
import { after } from 'node:test';
import { scopedTest as test } from './helpers/scopedTest';
import { pool } from '../src/db/pool';
import { intakeAppeal, type IntakeCommand } from '../src/services/intakeService';
import { confirmCorrection, rejectCorrection } from '../src/services/correctionService';

const ctx = { userId: 'synthetic-operator', userName: 'Synthetic', clientIp: null };
class MemoryTx {
  complaint: Record<string, any> = {};
  corrections: Record<string, any>[] = [];
  versions: any[][] = [];
  logs: any[][] = [];
  writes: string[] = [];
  failAudit = false;
  snapshot: any;
  async beginTransaction() { this.snapshot = structuredClone([this.complaint, this.corrections, this.versions, this.logs, this.writes]); }
  async commit() {}
  async rollback() { [this.complaint, this.corrections, this.versions, this.logs, this.writes] = this.snapshot; }
  release() {}
  async query(sql: string, values: any[] = []): Promise<any> {
    if (!sql.includes('from correction_item') && (sql.includes('from complaint c where') || sql.includes('from complaint where'))) return [[{ ...this.complaint }], []];
    if (sql.includes('from correction_item')) {
      if (sql.includes('count(*)')) return [[{ total: this.corrections.filter(x =>
        !sql.includes("status = 'pending'") || x.status === 'pending' || (sql.includes('status not in') && !['confirmed', 'rejected'].includes(x.status))
      ).length }], []];
      if (sql.includes('as complaintId from')) return [[{ complaintId: this.complaint.complaint_id }], []];
      const rows = sql.includes('correction_id = ?') ? this.corrections.filter(x => x.correctionId === values[0]) : this.corrections;
      return [rows.map(x => ({ ...x, editVersion: this.complaint.edit_version,
        effectiveValue: sql.includes('as effectiveValue') ? String(this.complaint[x.fieldName === 'summary' ? 'title' : x.fieldName] ?? '') : undefined,
      })), []];
    }
    if (sql.includes('from complaint_field_version')) return [this.versions.map(v => ({ fieldName: v[2], newValue: v[4], changeSource: v[5] })), []];
    if (sql.includes('from dispatch_order') || sql.includes('from dict_item') || sql.includes('from complaint_address_candidate') || sql.includes('from complaint_location_clue')) return [[], []];
    if (sql.includes('from enterprise e')) return [[{ id: 1, enterprise_code: 'SYN-E', enterprise_name: 'Synthetic Enterprise', business_type: 'water', status: 'enabled' }], []];
    throw new Error('unexpected query: ' + sql);
  }
  async execute(sql: string, values: any[] = []): Promise<any> {
    this.writes.push(sql);
    if (sql.includes('edit_version = edit_version + case')) {
      const changed = this.complaint.is_sensitive !== values[0] || this.complaint.sensitive_keywords !== values[1];
      if (changed) this.complaint.edit_version++;
      Object.assign(this.complaint, { is_sensitive: values[2], sensitive_keywords: values[3], rule_confidence: values[4], rule_version: values[5] });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('update complaint set ')) {
      sql.split(' set ')[1].split(' where ')[0].split(', ').forEach((assignment, i) => {
        const column = assignment.split(' = ')[0];
        this.complaint[column] = assignment.includes('+ 1') ? Number(this.complaint[column]) + 1 : values[i];
      });
    }
    if (sql.startsWith('update correction_item')) {
      const item = this.corrections.find(x => x.correctionId === values.at(-1));
      Object.assign(item!, { status: values[0], newValue: values[1], basis: values[2] });
    }
    if (sql.startsWith('insert into complaint_field_version')) this.versions.push(values);
    if (sql.startsWith('insert into complaint_source_log')) this.logs.push(values);
    if (sql.includes('insert into operation_audit_log') && this.failAudit) throw new Error('synthetic audit failure');
    return [{ affectedRows: 1 }, []];
  }
  reset(state: any = null) {
    this.complaint = { complaint_id: 'synthetic-CPL', complaint_no: 'synthetic-CS', source_system: 'synthetic', source_id: 'source-1',
      title: '人工标题 B', address: 'B', district_name: '人工区 B', district_code: 'B-code', location_lng: 111, location_lat: 30,
      complaint_type: 'water_quality', business_type: 'water', reporting_status: 'not_started', supervision_status: 'none',
      enterprise_code: null, enterprise_name: null,
      source_payload_hash: 'A-hash', source_payload: { address: 'A' }, edit_version: 1, effective_field_state: state };
    this.corrections = ['address', 'summary', 'district_name', 'location_lng', 'location_lat', 'complaint_type'].map((fieldName, i) => ({
      id: i + 1, correctionId: 'COR-' + fieldName, complaintId: 'synthetic-CPL', assignmentId: null, fieldName,
      oldValue: fieldName === 'address' ? 'A' : null, newValue: null, status: 'pending', basis: null,
    }));
    this.logs = []; this.versions = []; this.writes = []; this.failAudit = false;
  }
}
const db = new MemoryTx();
const originalConnection = pool.getConnection;
const originalQuery = pool.query;
pool.getConnection = (async () => db) as any;
pool.query = db.query.bind(db) as any;
after(() => { pool.getConnection = originalConnection; pool.query = originalQuery; });
function command(address = 'C', hash = 'C-hash'): IntakeCommand {
  return { sourceSystem: 'synthetic', sourceId: 'source-1', channel: 'test', title: '来源标题 C', content: '来源正文',
    address, districtCode: 'C-code', districtName: '来源区 C', longitude: 112, latitude: 31,
    explicitBusinessType: 'gas', explicitComplaintType: 'other', explicitUrgencyLevel: null,
    sourceReportedAt: null, payload: { address, title: '来源标题 C' }, payloadHash: hash, warnings: [], remoteIp: null, requestId: null };
}

test('requires expectedVersion before any writes', async () => {
  db.reset();
  await assert.rejects(confirmCorrection('COR-address', { newValue: 'D' }, ctx), (e: any) => e.status === 400);
  assert.deepEqual(db.writes, []);
});
test('standalone responsibility confirmation bumps the shared version and protects the enterprise pair', async () => {
  db.reset();
  const { assignEnterprise } = await import('../src/services/assignmentService');
  await assignEnterprise('synthetic-CPL', { enterpriseCode: 'SYN-E', enterpriseName: 'Synthetic Enterprise', reason: 'Synthetic assignment' }, ctx);
  assert.equal(db.complaint.edit_version, 2);
  const states = JSON.parse(db.complaint.effective_field_state);
  assert.equal(states.enterprise_code.value, 'SYN-E');
  assert.equal(states.enterprise_name.value, 'Synthetic Enterprise');
  await assert.rejects(confirmCorrection('COR-address', { newValue: 'stale', expectedVersion: 1 }, ctx), (e: any) => e.status === 409);
});
test('responsibility correction increments once and captures master values', async () => {
  db.reset();
  db.corrections.push({ id: 7, correctionId: 'COR-enterprise', complaintId: 'synthetic-CPL', fieldName: 'enterprise_name', status: 'pending' });
  await confirmCorrection('COR-enterprise', { expectedVersion: 1, newValue: 'SYN-E' }, ctx);
  assert.equal(db.complaint.edit_version, 2);
  assert.equal(JSON.parse(db.complaint.effective_field_state).enterprise_name.value, 'Synthetic Enterprise');
});
test('no-correction enterprise verification preserves the actual pair when its master name differs', async () => {
  db.reset();
  Object.assign(db.complaint, { enterprise_code: 'SYN-E', enterprise_name: 'Previously verified enterprise name' });
  db.corrections.push({ id: 7, correctionId: 'COR-enterprise', complaintId: 'synthetic-CPL', fieldName: 'enterprise_name', status: 'pending' });
  const result = await rejectCorrection('COR-enterprise', { expectedVersion: 1, basis: '核验现有企业取值无需纠偏' }, ctx);
  assert.equal(result.item.status, 'rejected');
  assert.equal(result.writtenBack, false);
  assert.equal(db.complaint.enterprise_code, 'SYN-E');
  assert.equal(db.complaint.enterprise_name, 'Previously verified enterprise name');
  assert.ok(!db.writes.some(sql => sql.includes('insert into complaint_assignment') || sql.includes('set enterprise_code =')));
  const states = JSON.parse(db.complaint.effective_field_state);
  assert.equal(states.enterprise_code.resolution, 'no_correction');
  assert.equal(states.enterprise_code.value, 'SYN-E');
  assert.equal(states.enterprise_name.resolution, 'no_correction');
  assert.equal(states.enterprise_name.value, 'Previously verified enterprise name');
  assert.equal(db.complaint.edit_version, 2);
});
test('rule rescan bumps shared version for sensitivity value changes, but confidence alone does not', async () => {
  db.reset(); Object.assign(db.complaint, { is_sensitive: 0, sensitive_keywords: null });
  const { updateComplaintSensitiveResult } = await import('../src/repositories/sensitiveWordRepo');
  const input = { complaintId: 'synthetic-CPL', isSensitive: false, keywords: null, confidence: 0.2, ruleVersion: 'synthetic-v1', updatedAt: new Date() };
  await updateComplaintSensitiveResult(db as any, input);
  assert.equal(db.complaint.edit_version, 1);
  await updateComplaintSensitiveResult(db as any, { ...input, isSensitive: true, keywords: 'synthetic-hit' });
  assert.equal(db.complaint.edit_version, 2);
});
test('shared version rejects stale second window atomically', async () => {
  db.reset();
  const first = await confirmCorrection('COR-address', { newValue: 'B', expectedVersion: 1 }, ctx);
  assert.equal(first.item.editVersion, 2);
  assert.equal(db.complaint.edit_version, 2);
  const before = structuredClone([db.complaint, db.corrections, db.versions]);
  await assert.rejects(confirmCorrection('COR-summary', { newValue: 'stale', expectedVersion: 1 }, ctx), (e: any) => e.status === 409);
  assert.deepEqual([db.complaint, db.corrections, db.versions], before);
});
test('no-correction decision captures current effective value rather than initial oldValue', async () => {
  db.reset();
  await rejectCorrection('COR-address', { expectedVersion: 1, basis: '核验当前 B 无误' }, ctx);
  assert.ok(db.complaint.effective_field_state, 'decision must persist effective protection');
  const state = JSON.parse(db.complaint.effective_field_state);
  assert.equal(state.address.resolution, 'no_correction');
  assert.equal(state.address.value, 'B');
  await intakeAppeal(command());
  assert.equal(db.complaint.address, 'B');
  assert.equal(JSON.parse(db.complaint.source_fields).address, 'C');
  assert.equal(JSON.parse(db.complaint.source_fields)._order, 'unknown');
  assert.equal(JSON.parse(db.complaint.source_fields)._valueOrigins.rule_confidence, 'rule_engine');
});
test('same, changed and old payload retain confirmed title/address/category/district/coordinate pair', async () => {
  const state = Object.fromEntries(['title', 'address', 'complaint_type', 'district_code', 'district_name', 'location_lng', 'location_lat'].map(field => [field, { resolution: 'confirmed', value: 'decision B', version: 1 }]));
  db.reset(JSON.stringify(state));
  const protectedValues = Object.fromEntries(Object.keys(state).map(field => [field, db.complaint[field]]));
  await intakeAppeal(command('A', 'A-hash'));
  assert.deepEqual(db.writes.filter(sql => sql.startsWith('update complaint ')), []);
  await intakeAppeal(command());
  await intakeAppeal(command('A', 'old-A-hash'));
  assert.deepEqual(Object.fromEntries(Object.keys(state).map(field => [field, db.complaint[field]])), protectedValues);
  assert.equal(JSON.parse(db.complaint.source_fields).address, 'A');
  assert.ok(db.versions.some(v => v[2] === 'source.address' && v[4] === 'A'));
});
test('legacy unknown keeps current value and explicitly marks needs verification', async () => {
  db.reset();
  await intakeAppeal(command());
  assert.equal(db.complaint.address, 'B');
  assert.equal(JSON.parse(db.complaint.effective_field_state).address.resolution, 'needs_verification');
});
test('manual field-version evidence protects legacy effective classification', async () => {
  db.reset();
  db.versions.push(['CFV-synthetic', 'synthetic-CPL', 'complaint_type', 'other', 'water_quality', 'manual_edit']);
  await intakeAppeal(command());
  assert.equal(db.complaint.complaint_type, 'water_quality');
  assert.equal(JSON.parse(db.complaint.effective_field_state).complaint_type.resolution, 'confirmed');
});
test('older matching manual version cannot prove a later diverged legacy decision', async () => {
  db.reset();
  db.versions.push(['CFV-1', 'synthetic-CPL', 'address', 'A', 'B', 'manual_edit']);
  db.versions.push(['CFV-2', 'synthetic-CPL', 'address', 'B', 'D', 'manual_edit']);
  await intakeAppeal(command());
  assert.equal(db.complaint.address, 'B');
  assert.equal(JSON.parse(db.complaint.effective_field_state).address.resolution, 'needs_verification');
});
test('decision rollback leaves values/version/resolution/correction untouched', async () => {
  db.reset(); db.failAudit = true;
  const before = structuredClone([db.complaint, db.corrections]);
  await assert.rejects(confirmCorrection('COR-address', { expectedVersion: 1, newValue: 'D' }, ctx), /synthetic audit failure/);
  assert.deepEqual([db.complaint, db.corrections], before);
});
test('policy retains resolved values and holds uncertain or older source order', async () => {
  const module = await import('../src/domain/effectiveFieldPolicy').catch(() => ({} as any));
  assert.equal(typeof module.EffectiveFieldPolicy?.decide, 'function');
  const decide = module.EffectiveFieldPolicy.decide;
  const input = { field: 'address', sourceValue: 'C', effectiveValue: 'B', resolution: 'confirmed', incomingOrder: 'newer' };
  assert.equal(decide(input).action, 'retain_effective');
  assert.equal(decide({ ...input, resolution: 'no_correction' }).action, 'retain_effective');
  assert.equal(decide({ ...input, resolution: 'unresolved', incomingOrder: 'unknown' }).action, 'hold_for_review');
  assert.equal(decide({ ...input, resolution: 'unresolved', incomingOrder: 'older' }).action, 'hold_for_review');
  assert.equal(decide({ ...input, resolution: 'unresolved', incomingOrder: 'newer' }).action, 'apply_source');
});
test('summary maps to title and coordinate confirmation captures the pair', async () => {
  db.reset();
  await confirmCorrection('COR-summary', { expectedVersion: 1, newValue: '人工标题 D' }, ctx);
  await confirmCorrection('COR-location_lng', { expectedVersion: 2, newValue: '110.5' }, ctx);
  const states = JSON.parse(db.complaint.effective_field_state);
  assert.equal(states.title.value, '人工标题 D');
  assert.equal(states.location_lng.value, 110.5);
  assert.equal(states.location_lat.value, 30);
  assert.equal(states.location_lat.resolution, 'confirmed');
  await intakeAppeal(command());
  assert.equal(db.complaint.title, '人工标题 D');
  assert.equal(db.complaint.location_lng, 110.5);
  assert.equal(db.complaint.location_lat, 30);
  assert.equal(db.complaint.edit_version, 3, 'source snapshots do not change effective version');
});
test('district confirmation writes catalog name/code together and records the actual name', async () => {
  db.reset();
  await confirmCorrection('COR-district_name', { expectedVersion: 1, newValue: '420504' }, ctx);
  assert.equal(db.complaint.district_name, '点军区');
  assert.equal(db.complaint.district_code, '420504');
  assert.ok(db.versions.some(v => v[2] === 'district_name' && v[4] === '点军区'));
  const states = JSON.parse(db.complaint.effective_field_state);
  assert.equal(states.district_code.value, '420504');
  assert.equal(states.district_name.value, '点军区');
});
test('legacy rejected and unknown statuses preserve effective values without fabricating decision snapshots', async () => {
  db.reset(); db.corrections[0].status = 'rejected';
  db.corrections[1].status = 'unrecognized-legacy';
  await intakeAppeal(command());
  const states = JSON.parse(db.complaint.effective_field_state);
  assert.equal(states.address.resolution, 'needs_verification');
  assert.equal(states.title.resolution, 'needs_verification');
  assert.equal(db.complaint.address, 'B');
  assert.equal(db.versions.find(v => v[2] === 'source.address')?.[3], null);
});
test('changed source snapshot rollback does not leave half-written source fields or diffs', async () => {
  db.reset(); db.failAudit = true;
  const before = structuredClone([db.complaint, db.corrections, db.versions, db.logs]);
  await assert.rejects(intakeAppeal(command()), /synthetic audit failure/);
  assert.deepEqual([db.complaint, db.corrections, db.versions, db.logs], before);
});
test('correction DTO exposes current effective value separately from historical initial oldValue', async () => {
  db.reset();
  db.corrections[1].status = 'unrecognized-legacy';
  const { listByComplaint } = await import('../src/repositories/correctionRepo');
  const items = await listByComplaint(db as any, 'synthetic-CPL');
  assert.equal(items[0].oldValue, 'A');
  assert.equal(items[0].effectiveValue, 'B');
  assert.equal(items[1].status, 'unrecognized-legacy', 'unknown legacy status must not reopen as pending');
});
test('unknown legacy correction status blocks analysis readiness without relabeling the record', async () => {
  db.reset(); db.corrections.forEach(item => { item.status = 'confirmed'; });
  db.corrections[0].status = 'unrecognized-legacy';
  const { countPendingByComplaint } = await import('../src/repositories/correctionRepo');
  assert.equal(await countPendingByComplaint(db as any, 'synthetic-CPL'), 1);
  assert.equal(db.corrections[0].status, 'unrecognized-legacy');
});
