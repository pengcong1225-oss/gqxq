import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
test('D2 exact candidate evaluation and immutable confirmation contract',async()=>{
 assert.ok(existsSync(new URL('../src/domain/heatRule.ts',import.meta.url)),'exact heat evaluator is missing');
 const h=await import('../src/domain/heatRule');
 const policy={anchor:'upper',endpointOwner:'lower',zero:'green',belowFirst:'green',top:'red',day:'shanghai_inclusive',classFallback:'minor_then_major',noRule:'null',ruleSelection:'query_end'} as const;
 const rule={version:'synthetic-1',coefficients:['1','5','10','20','30']};
 const evaluate=(count:number,p:any=policy)=>h.evaluateHeat({count,days:30,rule,policy:p});
 assert.equal(evaluate(450).level,'orange');
 assert.equal(evaluate(300).level,'yellow');assert.equal(evaluate(600).level,'orange');
 assert.equal(evaluate(300,{...policy,endpointOwner:'upper'}).level,'orange');assert.equal(evaluate(600,{...policy,endpointOwner:'upper'}).level,'red');
 assert.equal(evaluate(1,{...policy,belowFirst:'null'}).reason,'POLICY_INCOHERENT');assert.equal(evaluate(1,{...policy,anchor:'lower',top:'null'}).reason,'POLICY_INCOHERENT');assert.equal(evaluate(0).level,'green');assert.equal(evaluate(100000).level,'red');
 assert.equal(h.evaluateHeat({count:1,days:1,rule,policy:{}}).reason,'POLICY_INCOMPLETE');
 assert.equal(h.evaluateHeat({count:1,days:1,rule:null,policy}).reason,'UNCONFIGURED');
 for(const invalid of ['10.123','1e2','-1','+1',' 1','01','NaN','1.',''])assert.throws(()=>h.coefficientUnits(invalid));
 assert.equal(h.coefficientUnits('10.10'),1010n);assert.equal(h.coefficientUnits('0.01'),1n);
 assert.throws(()=>h.validateCoefficients(['1','1','2','3','4']));assert.throws(()=>h.validateCoefficients(['2','1','3','4','5']));
 assert.equal(h.evaluateHeat({count:3,days:30,rule:{...rule,coefficients:['0.01','0.05','0.10','0.20','0.30']},policy}).level,'yellow');
 assert.equal(h.evaluateHeat({count:Number.MAX_SAFE_INTEGER,days:3660,rule,policy}).level,'red');
 const fingerprint=h.policyFingerprint(policy);
 assert.equal(h.validateConfirmation({policyVersion:1,fingerprint,truthTable:[{count:450,days:30,coefficients:rule.coefficients,level:'orange'}],evidenceRef:'synthetic-only'},1,policy),true);
 assert.equal(h.validateConfirmation(null,1,policy),false);
 assert.equal(h.validateConfirmation({policyVersion:2,fingerprint,truthTable:[],evidenceRef:'synthetic-only'},1,policy),false);
 assert.throws(()=>h.parseHeatDraft({confirmed:true}));
});
test('D2 grid aggregation uses capture membership, selected-day mask and detail gate',async()=>{
 assert.ok(existsSync(new URL('../src/services/heatRuleService.ts',import.meta.url)),'real heat capture consumer is missing');
 const {buildHeatData}=await import('../src/services/heatRuleService');
 const q={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-09-01',to:'2026-09-30',comparisonPolicyId:'candidate-calendar-v1'};
 const row={complaintId:'C1',complaintNo:'N1',longitude:1,latitude:1,coordinateSystem:'WGS84',coordinateSource:'Synthetic evidence',businessDay:'2026-09-10',grids:['G1','G2']};
 const cover=(code:string,days:string[])=>({coverage:{code,version:'1',coordinateSystem:'WGS84',geometry:{type:'FeatureCollection',features:[]},coverageState:'maintained'},selectedBusinessDays:days});
 const capture={summary:{query:q,total:2,unlocatedCount:1,dataCutoffAt:'2026-10-10'},rows:[row,{...row,complaintId:'C2',longitude:null,latitude:null,grids:[]}],coverageEvidence:[cover('G1',['2026-09-10']),cover('G2',['2026-09-10']),cover('OLD',['2025-09-10'])]};
 const r=buildHeatData(capture as any,[],false);assert.equal(r.total,2);assert.equal(r.grids.length,2);assert.deepEqual(r.grids.map(g=>g.count),[1,1]);assert.equal(r.grids[0].reason,'CATEGORY_SELECTION_REQUIRED');assert.equal(r.points.length,0);assert.equal(JSON.stringify(r).includes('C1'),false);
 assert.equal(buildHeatData(capture as any,[],true).points.length,1);assert.equal(buildHeatData({...capture,rows:[{...row,longitude:181}]} as any,[],true).points.length,0,'invalid WGS84 coordinate must not become a point');
 const selected=buildHeatData({...capture,summary:{...capture.summary,query:{...q,majorCode:'fee'}}} as any,[],false);assert.equal(selected.grids[0].reason,'UNCONFIGURED');
 assert.equal(buildHeatData({...capture,rows:[{...row,grids:['OLD']}]} as any,[],true).grids.some(g=>g.code==='OLD'),false);
});

test('D2 point provenance keeps sourced positions outside coverage and rejects missing sources',async()=>{
 const {buildHeatData}=await import('../src/services/heatRuleService');
 const row={complaintId:'SOURCE-OK',longitude:1,latitude:1,coordinateSystem:'WGS84',coordinateSource:'Synthetic evidence',businessDay:'2026-10-10',grids:[],locationReason:'该业务日无可证明的授权覆盖边界匹配'};
 const capture={summary:{query:{dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-10-10',to:'2026-10-10',comparisonPolicyId:'candidate-calendar-v1'},total:2,unlocatedCount:2},rows:[row,{...row,complaintId:'SOURCE-MISSING',coordinateSource:null,locationReason:'坐标系或来源未核实'}],coverageEvidence:[]};
 const result=buildHeatData(capture as any,[],true);
 assert.deepEqual(result.points.map(p=>p.complaintId),['SOURCE-OK'],'D1 provenance rejection must not become a usable point');
 assert.deepEqual(result.points[0].grids,[],'lack of coverage alone does not reject a sourced point');
 assert.equal(result.total,2);assert.equal(result.unlocatedCount,2);
 assert.equal(buildHeatData(capture as any,[],false).points.length,0);
});
