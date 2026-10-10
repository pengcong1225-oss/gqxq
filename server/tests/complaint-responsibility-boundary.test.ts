import assert from 'node:assert/strict';
import test from 'node:test';
import {isAllowed} from '../src/auth/rolePolicy';

test('legacy grants cannot enable local followup handling or source process endpoints',()=>{
 const user={id:'u',username:'u',roles:['admin'],permissionCodes:['complaint.read','followup.create','followup.conclude','dispatch.read']};
 for(const [method,path] of [
  ['GET','/complaints/C1/followups'],['POST','/complaints/C1/followups'],
  ['PATCH','/followups/FUP-1'],['PATCH','/followups/FUP-1/conclusion'],
  ['GET','/complaints/C1/source-processes'],
 ])assert.equal(isAllowed(user,method,path).allowed,false,method+' '+path);
 assert.equal(isAllowed(user,'GET','/dispatch/orders/ASGN1/reporting-result').allowed,true);
 assert.equal(isAllowed(user,'POST','/dispatch/orders').allowed,false);
});
