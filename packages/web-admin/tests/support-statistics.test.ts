import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSupportStatistics,shanghaiDay,durationBand} from '../src/tenderSupport/statisticsModel';
import type {SupportComplaint,TenderDataset} from '../src/tenderSupport/types';

function row(id:string,overrides:Partial<SupportComplaint>={}):SupportComplaint{return {id,title:id,businessType:'water',type:'水压',enterpriseId:'E1',districtCode:'D1',gridId:'G1',communityId:'C1',occurredAt:'2026-11-01T00:00:00Z',completedAt:'2026-11-02T00:00:00Z',evaluation:'satisfied',longitude:111,latitude:30,scenario:'other',...overrides};}
function data(complaints:SupportComplaint[]):TenderDataset{return {schemaVersion:1,mode:'simulation',revision:1,sourceLabel:'测试模拟',updatedAt:'2026-11-10T00:00:00Z',grids:[],communities:[{id:'C1',name:'一号小区',gridId:'G1',longitude:111,latitude:30,households:100},{id:'C10',name:'十号小区',gridId:'G1',longitude:111,latitude:30,households:200}],enterprises:[{id:'E1',name:'供水一',businessType:'water',households:20000},{id:'E2',name:'供气一',businessType:'gas',households:0}],complaints,events:[]};}

test('evaluation denominators exclude unevaluated and retain water/gas unsatisfied shares',()=>{
 const stats=buildSupportStatistics(data([row('1'),row('2',{evaluation:'unsatisfied'}),row('3',{businessType:'gas',enterpriseId:'E2',evaluation:'unsatisfied'}),row('4',{evaluation:'unevaluated'})]),'2026-11-01','2026-11-01','all');
 assert.equal(stats.evaluation.evaluatedCount,3);assert.equal(stats.evaluation.missingCount,1);
 assert.ok(Math.abs(stats.evaluation.satisfiedPercent!-100/3)<1e-10);assert.ok(Math.abs(stats.evaluation.unsatisfiedPercent!-200/3)<1e-10);
 assert.deepEqual(stats.unsatisfiedBusiness.map(b=>[b.businessType,b.count,b.percent]),[['water',1,50],['gas',1,50]]);
 assert.equal(stats.duration[0].evaluation.evaluatedCount,3);assert.equal(stats.duration[0].evaluation.missingCount,1);
 assert.ok(Math.abs(stats.duration[0].evaluation.unsatisfiedPercent!-200/3)<1e-10);
});
test('duration bands are mutually exclusive at 24/48/72 hours and omit open or invalid completions',()=>{
 for(const [hours,expected] of [[0,'le24'],[24,'le24'],[24.001,'24to48'],[48,'24to48'],[48.001,'48to72'],[72,'48to72'],[72.001,'gt72']] as const){
  const r=row(String(hours),{completedAt:new Date(Date.parse('2026-11-01T00:00:00Z')+hours*3600000).toISOString()});assert.equal(durationBand(r),expected);
 }
 const stats=buildSupportStatistics(data([row('1'),row('2',{completedAt:'2026-11-03T00:00:00Z'}),row('3',{completedAt:'2026-11-04T00:00:00Z'}),row('4',{completedAt:'2026-11-05T00:00:00Z'}),row('5',{completedAt:null}),row('6',{completedAt:'bad'}),row('7',{completedAt:'2026-10-31T00:00:00Z'})]),'2026-11-01','2026-11-01');
 assert.deepEqual(stats.duration.map(b=>b.count),[1,1,1,1]);assert.equal(stats.openRows.length,1);assert.equal(stats.invalidDurationRows.length,2);
 assert.equal(stats.duration.reduce((n,b)=>n+b.count,0)+stats.openRows.length+stats.invalidDurationRows.length,7);
});
test('dates are inclusive Shanghai days, invalid timestamps are counted separately and filters persist',()=>{
 assert.equal(shanghaiDay('2026-10-31T16:00:00Z'),'2026-11-01');assert.equal(shanghaiDay('bad'),null);assert.equal(shanghaiDay('2026-11-01'),null);
 const dataset=data([row('start',{occurredAt:'2026-10-31T16:00:00Z'}),row('end',{occurredAt:'2026-11-01T15:59:59Z'}),row('next',{occurredAt:'2026-11-01T16:00:00Z'}),row('gas',{businessType:'gas'}),row('invalid',{occurredAt:'bad'}),row('invalid-gas',{businessType:'gas',occurredAt:'bad'})]);
 const result=buildSupportStatistics(dataset,'2026-11-01','2026-11-01','water');
 assert.deepEqual(result.rows.map(r=>r.id),['start','end']);assert.deepEqual(result.invalidTimeRows.map(r=>r.id),['invalid']);
 assert.equal(buildSupportStatistics(dataset,'2026-11-02','2026-11-01').rangeValid,false);
 assert.equal(buildSupportStatistics(dataset,'2026-02-30','2026-11-01').rows.length,0);
});
test('community ranks use exact ids and master names; enterprise rates use master households without invented denominator',()=>{
 const stats=buildSupportStatistics(data([row('1'),row('2'),row('3',{communityId:'C10'}),row('4',{communityId:'missing',enterpriseId:'unknown'}),row('5',{businessType:'gas',enterpriseId:'E2'})]),'2026-11-01','2026-11-01');
 assert.deepEqual(stats.communities.map(c=>[c.id,c.count]),[['C1',3],['C10',1]]);assert.deepEqual(stats.communities[0].rows.map(r=>r.id),['1','2','5']);assert.equal(stats.unknownCommunityRows.length,1);
 assert.ok(Math.abs(stats.enterpriseRates.find(e=>e.id==='E1')!.per10k!-1.5)<1e-10);assert.equal(stats.enterpriseRates.find(e=>e.id==='E2')?.per10k,null);assert.equal(stats.unknownEnterpriseRows.length,1);
});
test('empty and wholly unevaluated samples show unavailable percentages instead of zero satisfaction',()=>{
 const empty=buildSupportStatistics(data([]),'2026-11-01','2026-11-01');assert.equal(empty.evaluation.satisfiedPercent,null);assert.equal(empty.unsatisfiedBusiness[0].percent,null);
 const unevaluated=buildSupportStatistics(data([row('1',{evaluation:'unevaluated'})]),'2026-11-01','2026-11-01');assert.equal(unevaluated.evaluation.satisfiedPercent,null);assert.equal(unevaluated.evaluation.missingCount,1);
});
test('business-filtered enterprise counts never absorb mismatched business ids, and invalid master denominators remain unavailable',()=>{
 const dataset=data([row('correct'),row('wrong',{enterpriseId:'E2'}),row('gas',{businessType:'gas',enterpriseId:'E2'})]);
 dataset.enterprises[0].households=Number.NaN;
 const stats=buildSupportStatistics(dataset,'2026-11-01','2026-11-01','water');
 assert.deepEqual(stats.rows.map(r=>r.id),['correct','wrong']);assert.equal(stats.enterpriseRates.length,1);assert.equal(stats.enterpriseRates[0].count,1);assert.equal(stats.enterpriseRates[0].per10k,null);
 assert.deepEqual(stats.unknownEnterpriseRows.map(r=>r.id),['wrong']);assert.deepEqual(stats.unsatisfiedBusiness.map(b=>b.businessType),['water']);
});
