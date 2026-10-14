import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

const input = () => ({ sourceId: 'utility', kind: 'shutdown', sourceObjectId: 'E-1', sourceVersion: 1,
  sourceUpdatedAt: '2026-10-14T09:00:00+08:00', enterpriseCode: 'ENT-1', districtCode: '420502',
  payload: { title: '停供来源测试', businessType: 'water', nature: 'planned', approvalState: 'approved',
    state: 'ended', startsAt: '2026-10-13T08:00:00+08:00', endsAt: '2026-10-13T18:00:00+08:00',
    restoredAt: '2026-10-13T18:00:00+08:00', adminGridCodes: ['G-1'], households: 10 } });
const domain = async () => {
  assert.ok(existsSync(new URL('../src/domain/businessEvents.ts', import.meta.url)), 'business event domain is missing');
  return import('../src/domain/businessEvents');
};

test('external business events parse source identity and preserve only source fields', async () => {
  const d = await domain(); const result = d.parseBusinessEvent(input());
  assert.equal(result.sourceId, 'utility'); assert.equal(result.kind, 'shutdown');
  assert.equal(result.payload.restoredAt, '2026-10-13T18:00:00+08:00');
  assert.throws(() => d.parseBusinessEvent({ ...input(), sourceVersion: 1.1 }));
  assert.throws(() => d.parseBusinessEvent({ ...input(), sourceVersion: -1 }));
  assert.throws(() => d.parseBusinessEvent({ ...input(), sourceVersion: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => d.parseBusinessEvent({ ...input(), sourceId: '../../escape' }));
  assert.throws(() => d.parseBusinessEvent({ ...input(), payload: { ...input().payload, localApproval: true } }));
});

test('source revision handles duplicate stale conflicting and distinct source identities', async () => {
  const d = await domain(); const event = d.parseBusinessEvent(input());
  const next = d.sourceRevision(event);
  assert.equal(d.classifySourceRevision(null, next), 'new');
  assert.equal(d.classifySourceRevision(next, next), 'duplicate');
  assert.equal(d.classifySourceRevision({ ...next, sourceVersion: 2 }, next), 'stale');
  assert.equal(d.classifySourceRevision(next, { ...next, sourceVersion: 2 }), 'new');
  assert.throws(() => d.classifySourceRevision(next, { ...next, payloadHash: 'f'.repeat(64) }));
  assert.throws(() => d.classifySourceRevision(next, { ...next, sourceId: 'other-source' }));
  assert.notEqual(d.businessEventKey(event), d.businessEventKey({ ...event, sourceId: 'another' }));
  assert.notEqual(d.businessEventKey(event), d.businessEventKey({ ...event, kind: 'pipeline' }));
});

test('timestamp contract requires a real calendar date and explicit timezone', async () => {
  const d = await domain();
  for (const date of ['2026-10-14T09:00:00', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-14T25:00:00Z'])
    assert.throws(() => d.parseBusinessEvent({ ...input(), sourceUpdatedAt: date }), date);
  assert.equal(d.parseBusinessEvent({ ...input(), sourceUpdatedAt: '2026-10-14T01:00:00Z' }).sourceUpdatedAt, '2026-10-14T01:00:00Z');
});

test('incomplete source facts become quality reasons rather than inferred facts', async () => {
  const d = await domain();
  const result = d.parseBusinessEvent({ ...input(), enterpriseCode: null, payload: {
    title: '缺少来源字段', businessType: 'water', nature: 'unknown', approvalState: 'unknown', state: 'unknown', adminGridCodes: [] } });
  assert.equal(result.payload.restoredAt, null);
  const reasons = d.businessEventQuality(result);
  assert.ok(reasons.includes('ENTERPRISE_UNMAPPED'));
  assert.ok(reasons.includes('IMPACT_UNAVAILABLE'));
  assert.ok(reasons.includes('APPROVAL_UNKNOWN'));
  assert.ok(reasons.includes('RESTORATION_UNKNOWN'));
  const reverse = d.parseBusinessEvent({ ...input(), payload: { ...input().payload, endsAt: '2026-10-12T00:00:00Z' } });
  assert.ok(d.businessEventQuality(reverse).includes('TIME_ORDER_INVALID'));
});

test('pipeline and followup schemas cannot carry local writable approval facts', async () => {
  const d = await domain();
  const pipeline = d.parseBusinessEvent({ ...input(), kind: 'pipeline', payload: {
    title: '来源施工', businessType: 'gas', approvalState: 'pending', state: 'planned', adminGridCodes: ['G-1'], workers: 2 } });
  assert.equal(pipeline.payload.workers, 2);
  assert.throws(() => d.parseBusinessEvent({ ...input(), kind: 'pipeline', payload: { ...pipeline.payload, workers: -1 } }));
  const followup = d.parseBusinessEvent({ ...input(), kind: 'followup', payload: {
    complaintId: 'CPL-1', occurredAt: '2026-10-14T01:00:00Z', contacted: false, evaluation: null, operatorName: '外部回访人员' } });
  assert.equal(followup.payload.complaintId, 'CPL-1');
  assert.throws(() => d.parseBusinessEvent({ ...input(), kind: 'followup', payload: { ...followup.payload, evaluation: 'satisfied' } }));
});

test('source signatures fail closed and authenticate exact bytes freshness and identity', async () => {
  const d = await domain();
  const { createHmac } = await import('node:crypto');
  const raw = Buffer.from(JSON.stringify(input())); const at = '2026-10-14T01:00:00Z';
  const config = { sourceId: 'utility', keyId: 'K1', secret: 'synthetic-test-secret-32-characters', maxSkewSeconds: 300 };
  const signature = createHmac('sha256', config.secret).update(at + '\n').update(raw).digest('hex');
  const headers = { sourceId: 'utility', keyId: 'K1', timestamp: at, signature };
  assert.equal(d.verifyBusinessSource(raw, headers, config, new Date(at)), true);
  assert.equal(d.verifyBusinessSource(raw, headers, null, new Date(at)), false);
  assert.equal(d.verifyBusinessSource(Buffer.from('{}'), headers, config, new Date(at)), false);
  assert.equal(d.verifyBusinessSource(raw, { ...headers, sourceId: 'other' }, config, new Date(at)), false);
  assert.equal(d.verifyBusinessSource(raw, headers, config, new Date('2026-10-14T01:05:01Z')), false);
});
