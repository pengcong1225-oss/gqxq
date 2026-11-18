import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildScreen} from '../src/domain/screen';
import {screenHeat} from '../src/services/screenHeat';
import type {ScreenHeatRuleRef} from '../src/types/screen';
const access:any={userId:'u',roles:['readonly'],scopeVersion:1,canReadSource:false,rules:[{kind:'all'}]};
const fact={source_system:'宜接就办',source_id:'1',complaint_id:'C1',enterprise_code:'E',district_code:'A',business_type:'water',source_reported_at:new Date('2026-11-02T00:00:00Z'),received_at:null,admin_grid_code:null,major_category_code:null};
const grants=['grid.read','heatmap.read'];
const result=buildScreen({mode:'real',from:'2026-11-01',to:'2026-11-10'},access,[fact],[],null);
const rule=(overrides:Partial<ScreenHeatRuleRef>={}):ScreenHeatRuleRef=>({categoryKey:'gas_service|',ruleVersion:'HEAT-20261118-1',policyId:'TENDER_1_1_9_V1',policyVersion:1,policyPublished:true,effectiveFrom:'2026-11-01',...overrides});
test('正式热力无已发布规则时返回 unavailable，且不补网格或系数',async()=>{
 const section=await screenHeat(result,null,grants,async()=>[]);
 assert.equal(section.state,'unavailable');
 assert.equal(section.reason,'无已发布热力规则');
 assert.deepEqual(section.data.rules,[]);
 assert.deepEqual(section.data.grids,[]);
 assert.equal(section.data.ruleVersion,null);
 assert.equal(section.data.thresholds,null);
});
test('正式热力取到规则版本但缺几何时返回 partial，只报告版本不伪造热力网格',async()=>{
 const section=await screenHeat(result,null,grants,async()=>[rule()]);
 assert.equal(section.state,'partial');
 assert.match(String(section.reason),/规则版本已取到，但缺行政网格边界\/服务网格几何/);
 assert.deepEqual(section.data.rules,[rule()]);
 assert.equal(section.data.ruleVersion,'HEAT-20261118-1');
 assert.equal(section.data.policyId,'TENDER_1_1_9_V1');
 assert.equal(section.data.days,10);
 assert.equal(section.data.thresholds,null);
 assert.equal(section.data.coefficients,null);
 assert.deepEqual(section.data.grids,[]);
});
test('正式热力读取器异常时降级为 unavailable 而不是抛出',async()=>{
 const section=await screenHeat(result,null,grants,async()=>{throw new Error('db down');});
 assert.equal(section.state,'unavailable');
 assert.match(String(section.reason),/读取已发布热力规则失败/);
 assert.deepEqual(section.data.grids,[]);
});
