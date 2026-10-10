import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {ROLE_POLICY} from '../src/auth/rolePolicy';
import {isPermissionCode} from '../src/auth/permissionCatalog';

test('complaint import has its own capability and authenticated endpoint rules',()=>{
  assert.equal(isPermissionCode('complaint.import'),true);
  for(const [method,path] of [['POST','/complaint-imports/preview'],['POST','/complaint-imports/batch/commit'],['GET','/complaint-imports'],['GET','/complaint-imports/batch']]) {
    const rule=ROLE_POLICY.find(r=>r.method===method&&r.path.test(path));
    assert.equal(rule?.permissionCode,'complaint.import');
  }
});
test('complaint import service is available for batch transaction validation',()=>{
  assert.equal(existsSync(new URL('../src/services/complaintImportService.ts',import.meta.url)),true);
});
