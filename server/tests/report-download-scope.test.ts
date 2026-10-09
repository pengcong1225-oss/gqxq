import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
test('whole original domain cannot pass vacuously on empty rows or intersected grants',async()=>{
 assert.ok(existsSync(new URL('../src/auth/reportScope.ts',import.meta.url)),'D3 whole report authorization is missing');
 const {domainCovered}=await import('../src/auth/reportScope');
 assert.equal(domainCovered([{kind:'all'}],[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}]),false);
 assert.equal(domainCovered([{kind:'restricted',enterpriseCodes:['E1','E2'],districtCodes:['D1','D2']}],[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:['D1','D2']},{kind:'restricted',enterpriseCodes:['E2'],districtCodes:['D1','D2']}]),true);
 assert.equal(domainCovered([{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:['D1']}]),false);
 assert.equal(domainCovered([{kind:'restricted',enterpriseCodes:[],districtCodes:['D1']}],[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:['D1']}]),false);
 assert.equal(domainCovered([{kind:'all'}],[]),false);
});
