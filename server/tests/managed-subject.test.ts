import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionHasCurrentAccess } from '../src/auth/managedIdentity';

const binding = { issuer: 'zhuxin-platform', subject: 'fixture-subject', userId: 'fixture-business' };
const assignment = { active: true, assigned: true, legacy_account_id: binding.userId, authorization_version: 2 };
const platform = { active: true, subject: binding.subject, authVersion: 4 };
const current = { subject: binding.subject, assignmentVersion: 2, authVersion: 4 };

test('managed business sessions reject missing or revoked authorization', () => {
  assert.equal(sessionHasCurrentAccess(binding, assignment, platform, current), true);
  assert.equal(sessionHasCurrentAccess(binding, assignment, platform, undefined), false);
  assert.equal(sessionHasCurrentAccess(binding, { ...assignment, active: false }, platform, current), false);
  assert.equal(sessionHasCurrentAccess(binding, assignment, { ...platform, active: false }, current), false);
  assert.equal(sessionHasCurrentAccess(binding, { ...assignment, authorization_version: 3 }, platform, current), false);
  assert.equal(sessionHasCurrentAccess(binding, assignment, { ...platform, authVersion: 5 }, current), false);
  assert.equal(sessionHasCurrentAccess(binding, { ...assignment, legacy_account_id: 'other' }, platform, current), false);
  assert.equal(sessionHasCurrentAccess(binding, assignment, { ...platform, subject: 'other' }, current), false);
});