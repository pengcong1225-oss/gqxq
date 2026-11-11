import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRule } from '../src/auth/rolePolicy';

test('tender heat save is registered with heatmap management permission', () => {
  assert.equal(matchRule('POST', '/heat-rules/tender')?.permissionCode, 'heatmap.manage');
  assert.equal(matchRule('POST', '/heat-rules/tender/')?.permissionCode, 'heatmap.manage');
  assert.equal(matchRule('POST', '/heat-rules/unknown'), null);
});
