import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinPermissionCodes, isAllowed, ROLE_POLICY } from '../src/auth/rolePolicy';
import {PERMISSION_CATALOG} from '../src/auth/permissionCatalog';
process.env.GQXQ_DB_HOST = '127.0.0.1';
process.env.GQXQ_DB_PORT = '1';
process.env.GQXQ_DB_USER = 'synthetic_account_test';
process.env.GQXQ_DB_PASSWORD = 'synthetic_only';
process.env.GQXQ_DB_NAME = 'synthetic_account_test';
process.env.GQXQ_JWT_SECRET = 'synthetic_account_test_secret_32_chars';
test('custom role uses registered endpoint permission, unknown endpoints deny', () => {
 const user = {id:'u',username:'u',roles:['analyst'],permissionCodes:['complaint.read'],authorizationVersion:1};
 assert.equal(isAllowed(user,'GET','/complaints').allowed,true);
 assert.equal(isAllowed(user,'POST','/complaints/c/close').allowed,false);
 assert.equal(isAllowed(user,'GET','/unregistered').allowed,false);
});
test('readonly and pending identities can change own password but cannot write business', () => {
 for(const roles of [['readonly'],[]]) {
 const user={id:'u',username:'u',roles,permissionCodes:[],authorizationVersion:1};
 assert.equal(isAllowed(user,'POST','/auth/change-password').allowed,true);
 assert.equal(isAllowed(user,'POST','/dispatch/orders').allowed,false);
 }
});
test('password validation measures UTF-8 bytes and service exists',async()=>{
 let service:Record<string,unknown>={};try{service=await import('../src/services/passwordService');}catch{}
 assert.equal(typeof service.validatePassword,'function');
 const validate=service.validatePassword as(value:string)=>void;
 assert.throws(()=>validate('密'.repeat(25)),{status:400});
 assert.doesNotThrow(()=>validate('密'.repeat(24)));
});
test('complete registered endpoint matrix preserves builtins and verifies each capability on a custom role',()=>{
 const groupedPaths=['/heat-rules','/heat-rules/categories','/heat-rules/sample/preview','/heat-rules/sample/publish','/statistics/summary','/statistics/complaints','/master-data/imports','/master-data/imports/sample','/master-data/imports/sample/errors',
  '/enterprises/sample/households','/enterprises/sample/department-mappings',
  '/grids/sample','/grids/sample/history','/grids/sample/boundary','/grids','/admin-grids','/communities'];
 for(const rule of ROLE_POLICY) {
  const paths=rule.path.source.includes('(')?groupedPaths.filter(path=>rule.path.test(path)):[rule.path.source.replace(/^\^|\$$/g,'').replace(/\[\^\/\]\+/g,'sample').replace(/\\\//g,'/')];
  assert.ok(paths.length>0,'Add concrete URL fixtures for '+rule.desc);
  for(const path of paths){
  assert.ok(rule.path.test(path),'Fixture is a concrete registered URL: '+path);
  assert.ok(rule.selfService||rule.permissionCode,'Every endpoint declares a capability or identity exception');
  for(const role of ['admin','handler','readonly']) {
   const user={id:'u',username:'u',roles:[role],permissionCodes:role==='admin'?PERMISSION_CATALOG.map(([code])=>code):builtinPermissionCodes(role)};
   const expected=Boolean(rule.selfService||((role==='admin'||rule.roles.includes(role as any))&&(role!=='readonly'||rule.method==='GET')));
   assert.equal(isAllowed(user,rule.method,path).allowed,expected,rule.desc+' '+role);
  }
  const user={id:'u',username:'u',roles:['custom'],permissionCodes:rule.permissionCode?[rule.permissionCode]:[]};
  const protectedCode=rule.permissionCode==='system.users.manage'||rule.permissionCode==='system.roles.manage';
  assert.equal(isAllowed(user,rule.method,path).allowed,!protectedCode,rule.desc+' custom');
  assert.equal(isAllowed({...user,permissionCodes:[]},rule.method,path).allowed,Boolean(rule.selfService),rule.desc+' denied');
  }
 }
});
test('forced-change restricts even administrator to identity service and unknown endpoints always deny effective grants',()=>{
 const user={id:'u',username:'u',roles:['admin'],permissionCodes:PERMISSION_CATALOG.map(([code])=>code),mustChangePassword:true};
 assert.equal(isAllowed(user,'GET','/users').allowed,false);
 assert.equal(isAllowed(user,'GET','/auth/user-info').allowed,true);
 assert.equal(isAllowed(user,'POST','/auth/change-password').allowed,true);
 assert.equal(isAllowed({...user,mustChangePassword:false},'GET','/unregistered').allowed,false);
});
test('credential failure projection discards SQL, params and cause',async()=>{
 const {safeCredentialError}=await import('../src/services/passwordService');
 const marker='PRIVATE_SYNTHETIC';const error=safeCredentialError(Object.assign(new Error(marker),{sql:marker,sqlMessage:marker,parameters:[marker]}));
 assert.equal(error.status,500);assert.equal(JSON.stringify(error).includes(marker),false);assert.equal(String(error).includes(marker),false);assert.equal('cause' in error,false);
});
