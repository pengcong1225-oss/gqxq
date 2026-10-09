import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
process.env.DOTENV_CONFIG_PATH='missing-synthetic-b2.env';process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_PASSWORD='synthetic';process.env.GQXQ_DB_HOST='127.0.0.1';process.env.GQXQ_DB_PORT='1';process.env.GQXQ_DB_NAME='gqxq_synthetic_unreachable';process.env.GQXQ_JWT_SECRET='synthetic-b2-test-secret';
test('B2 scoped transactional enterprise management and household input',async()=>{
 assert.equal(existsSync(new URL('../src/services/enterpriseService.ts',import.meta.url)),true,'enterprise management service is missing');
 const {parseEnterpriseInput,enterpriseWriteSchema,householdWriteSchema,canAccessEnterprise,calculatePerTenThousand}=await import('../src/services/enterpriseService');
 const access={userId:'u',roles:[],scopeVersion:1,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:['420502']}],canReadSource:false};
 assert.equal(canAccessEnterprise(access,{enterpriseCode:'E1',districtCode:'420502'}),true);
 assert.equal(canAccessEnterprise(access,{enterpriseCode:'E1',districtCode:null}),false);
 assert.equal(canAccessEnterprise({...access,rules:[{kind:'restricted',enterpriseCodes:['NEW'],districtCodes:[]}]},{enterpriseCode:'NEW',districtCode:null}),true);
 assert.throws(()=>parseEnterpriseInput(enterpriseWriteSchema,{enterpriseCode:'E1',enterpriseName:'样本',businessType:'water',status:'enabled',unexpected:'secret'}));
 for(const households of [-1,0.5])assert.throws(()=>parseEnterpriseInput(householdWriteSchema,{enterpriseCode:'E1',households,validFrom:'2026-01-01',validTo:null,expectedVersion:1}));
 assert.throws(()=>parseEnterpriseInput(householdWriteSchema,{enterpriseCode:'E1',households:1,validFrom:'2026-02-30',validTo:null,expectedVersion:1}));
 assert.deepEqual(calculatePerTenThousand(10,20000),{value:5,reason:null});
 assert.equal(calculatePerTenThousand(10,0).reason,'ZERO_HOUSEHOLDS');assert.equal(calculatePerTenThousand(10,null).reason,'UNKNOWN_HOUSEHOLDS');
 const {isAllowed}=await import('../src/auth/rolePolicy');
 assert.equal(isAllowed({id:'u',username:'u',roles:['custom'],permissionCodes:['enterprise.read']},'POST','/enterprises').allowed,false);
 assert.equal(isAllowed({id:'u',username:'u',roles:['custom'],permissionCodes:['enterprise.manage']},'POST','/enterprises').allowed,true);
});

test('registered target validation locks only the minimal identity and rejects disabled targets',async()=>{
 const {assertTargetEnterprise}=await import('../src/services/assignmentService');const queries:string[]=[];
 const tx={query:async(sql:string)=>{queries.push(sql);return [[{enterprise_code:'OTHER',enterprise_name:'另一合法企业',status:'enabled'}],[]];}};
 const value=await assertTargetEnterprise(tx as any,'OTHER',null);assert.equal(value.code,'OTHER');assert.ok(queries[0].includes('for update'),'selection must hold target lock through write');assert.equal(queries[0].includes('contact_phone'),false,'target validator needs no contacts');
});
