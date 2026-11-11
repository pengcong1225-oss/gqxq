import test from 'node:test';
import assert from 'node:assert/strict';
import * as heat from '../src/domain/heatRule';

const category={majorCode:'water',minorCode:null,dictionaryVersion:'1'};
const coefficients=['1','5','10','20','30'];
const tender=heat as typeof heat & {
 TENDER_HEAT_POLICY:heat.HeatBoundaryPolicy;
 tenderHeatConfirmation:()=>heat.HeatConfirmation;
 parseTenderHeatRule:(raw:unknown)=>{ruleId?:string;category:typeof category;coefficients:string[];expectedVersion:number};
 nextHeatEffectiveDay:(today:string,last:string|null)=>string;
};
test('tender input needs only category, five coefficients and optimistic edit version',()=>{
 assert.equal(typeof tender.parseTenderHeatRule,'function','reduced tender rule input is supported');
 const input=tender.parseTenderHeatRule({category,coefficients,expectedVersion:0});
 assert.deepEqual(input,{category,coefficients,expectedVersion:0});
 for(const bad of [['1','5','10.001','20','30'],['1','5','5','20','30'],['1','5','10','20'],['-1','5','10','20','30']]){
  assert.throws(()=>tender.parseTenderHeatRule({category,coefficients:bad,expectedVersion:0}));
 }
 assert.throws(()=>tender.parseTenderHeatRule({category,coefficients,expectedVersion:0,policy:{anchor:'lower'}}));
 assert.throws(()=>tender.parseTenderHeatRule({category,coefficients,expectedVersion:1}));
});
test('tender algorithm matches the 30-day example and explicitly owns equal thresholds',()=>{
 assert.ok(tender.TENDER_HEAT_POLICY,'fixed tender algorithm exists');
 const rule={version:'test',coefficients};
 for(const [count,level] of [[0,'green'],[30,'green'],[31,'blue'],[150,'blue'],[151,'yellow'],[300,'yellow'],[301,'orange'],[450,'orange'],[600,'orange'],[601,'red'],[900,'red'],[901,'red']] as const){
  assert.equal(heat.evaluateHeat({count,days:30,rule,policy:tender.TENDER_HEAT_POLICY}).level,level,'count='+count);
 }
 assert.equal(tender.TENDER_HEAT_POLICY.classFallback,'minor_then_major');
 assert.equal(heat.evaluateHeat({count:2,days:30,rule:null,policy:tender.TENDER_HEAT_POLICY}).reason,'UNCONFIGURED');
});
test('tender confirmation validates the real fixed policy and cannot confirm a changed policy',()=>{
 assert.equal(typeof tender.tenderHeatConfirmation,'function');
 const confirmation=tender.tenderHeatConfirmation();
 assert.equal(heat.validateConfirmation(confirmation,1,tender.TENDER_HEAT_POLICY),true);
 assert.equal(heat.validateConfirmation(confirmation,1,{...tender.TENDER_HEAT_POLICY,endpointOwner:'upper'}),false);
 assert.ok(confirmation.truthTable.some(r=>r.count===450&&r.days===30&&r.level==='orange'));
});
test('saving preserves existing published days and handles year/month leap boundaries',()=>{
 assert.equal(typeof tender.nextHeatEffectiveDay,'function');
 assert.equal(tender.nextHeatEffectiveDay('2026-11-10',null),'2026-11-10');
 assert.equal(tender.nextHeatEffectiveDay('2026-11-10','2026-11-09'),'2026-11-10');
 assert.equal(tender.nextHeatEffectiveDay('2026-11-10','2026-11-10'),'2026-11-11');
 assert.equal(tender.nextHeatEffectiveDay('2026-11-10','2026-12-31'),'2027-01-01');
 assert.equal(tender.nextHeatEffectiveDay('2028-02-28','2028-02-28'),'2028-02-29');
});
