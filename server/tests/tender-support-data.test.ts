import test from 'node:test';import assert from 'node:assert/strict';
import {simulatedSupportData,defaultSupportWarnings} from '../src/domain/tenderSupportData';
import {scopeSupportDataset,validateSupportDataset,validateSupportWarnings} from '../src/domain/tenderSupportValidation';
import {matchRule} from '../src/auth/rolePolicy';
import {supportDataset,previewSupportImport} from '../src/services/tenderSupportService';
const sample=()=>simulatedSupportData('2026-11-10');
test('simulation is deterministic, coherent, five-year, and never silently accepted as real',()=>{
 const d=sample();assert.deepEqual(d,sample());validateSupportDataset(d);assert.equal(d.grids.length,18);assert.equal(d.communities.length,36);assert.equal(d.pipelines?.length,36);
 assert.equal(new Set(d.complaints.map(c=>c.occurredAt.slice(0,4))).size,5);assert.ok(d.complaints.every(c=>c.occurredAt.slice(0,10)<='2026-11-10'));
 assert.throws(()=>validateSupportDataset(d,true));assert.throws(()=>validateSupportDataset({...d,mode:'real'},true));
});
test('import rejects dangling identity references, duplicate ids, invalid dates, completion and polygons',()=>{
 for(const mutate of [(d:any)=>d.complaints[0].communityId='missing',(d:any)=>d.grids.push(d.grids[0]),(d:any)=>d.complaints[0].occurredAt='2026-02-30T01:00:00Z',(d:any)=>d.complaints[0].completedAt='2000-01-01T00:00:00Z',(d:any)=>d.grids[0].ring.pop()]){const d=sample();mutate(d);assert.throws(()=>validateSupportDataset(d));}
});
test('scoping removes outside complaints and multi-grid events; partial household denominator unavailable',()=>{
 const d=sample(),ctx={userId:'x',roles:['custom'],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:['SIM-water-0'],districtCodes:['420502']}],canReadSource:false} as any;
 const s=scopeSupportDataset(d,ctx);assert.ok(s.complaints.length>0);assert.ok(s.complaints.every(c=>c.enterpriseId==='SIM-water-0'&&c.districtCode==='420502'));assert.ok(s.enterprises.every(e=>e.households===0));
 assert.equal(scopeSupportDataset(d,{...ctx,rules:[]}).complaints.length,0);assert.equal(scopeSupportDataset(d,{...ctx,rules:[]}).events.length,0);
});
test('all four rule scenarios and valid finite positive thresholds required',()=>{validateSupportWarnings(defaultSupportWarnings);assert.throws(()=>validateSupportWarnings({...defaultSupportWarnings,rules:defaultSupportWarnings.rules.slice(1)}));assert.throws(()=>validateSupportWarnings({...defaultSupportWarnings,rules:defaultSupportWarnings.rules.map(r=>({...r,threshold:0}))}));});
test('new endpoints registered and unauthorized requests fail before database access',async()=>{
 assert.equal(matchRule('GET','/tender-support/dataset')?.permissionCode,'statistics.read');assert.equal(matchRule('PUT','/tender-support/dataset')?.permissionCode,'masterdata.import');assert.equal(matchRule('PUT','/tender-support/warning-rules')?.permissionCode,'heatmap.manage');
 const ctx={permissionCodes:[],access:{roles:[],rules:[]}} as any;await assert.rejects(()=>supportDataset('simulation',ctx),(e:any)=>e.status===403);await assert.rejects(()=>previewSupportImport({},ctx),(e:any)=>e.status===403);
});
