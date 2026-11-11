import {simulatedSupportData} from '../src/domain/tenderSupportData';
import {test} from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';
import {createApp} from '../src/app';import {matchRule} from '../src/auth/rolePolicy';import {screenDemands,screenBootstrap,screenEvent,screenCompare,screenEvidence} from '../src/services/screenService';
const access:any={userId:'u',roles:['readonly'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false};
test('大屏路由需要身份且权限策略明确登记',async()=>{const app=createApp();for(const path of ['/api/v1/screen/bootstrap','/api/v1/screen/demands']){const res=await request(app).get(path);assert.equal(res.status,401);}assert.equal(matchRule('GET','/screen/bootstrap')?.permissionCode,'statistics.read');assert.equal(matchRule('GET','/screen/demands')?.permissionCode,'statistics.read');assert.equal(matchRule('POST','/screen/bootstrap'),null);});
test('明细权限回收或过期上下文不能读取',()=>{assert.throws(()=>screenDemands('unknown',1,20,access,['statistics.read','dashboard.read']),/权限/);assert.throws(()=>screenDemands('unknown',1,20,access,['statistics.read','dashboard.read','complaint.read']),/过期/);});

test('不允许覆盖固定账本及传入未执行的筛选',async()=>{const grants=['statistics.read','dashboard.read','complaint.read'];await assert.rejects(()=>screenBootstrap({dataset:'analysis'},access,grants),/不支持/);await assert.rejects(()=>screenBootstrap({serviceGridCode:'G'},access,grants),/不支持/);});
import {pool} from '../src/db/pool';import {shanghaiToday} from '../src/domain/statisticsQuery';
test('模拟数据权限及年度下钻在当前上下文中生效',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;
 poolAny.getConnection=async()=>({query:async()=>[[],[]],rollback:async()=>{},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const to=shanghaiToday(),from=to.slice(0,7)+'-01',grants=['statistics.read','dashboard.read','complaint.read'];const result=await screenBootstrap({mode:'simulation',from,to},access,grants);assert.deepEqual(result.charts.adminGrid,[]);assert.deepEqual(result.spatial.data.grids,[]);assert.deepEqual(result.spatial.data.pipelines,[]);assert.deepEqual(result.supply.data.enterpriseRates,[]);assert.ok(result.research.data.seasons.every((x:any)=>x.topGrids.length===0));
 const page=screenDemands(result.contextId,1,100,access,grants,{metricKey:'year'});assert.equal(page.total,result.periods.year.count);assert.ok(page.items.every(x=>x.adminGridCode===null));assert.throws(()=>screenDemands(result.contextId,1,20,{...access,userId:'other'},grants),/不存在/);assert.throws(()=>screenDemands(result.contextId,1,20,access,['statistics.read','dashboard.read']),/权限/);
 }finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('模拟 bootstrap 不触碰数据库并可比较授权零诉求网格',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;poolAny.getConnection=async()=>{throw Error('不得访问数据库');};poolAny.query=async()=>{throw Error('不得访问数据库');};
 try{const to=shanghaiToday(),from=to.slice(0,7)+'-01',grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read','enterprise.read'];const r=await screenBootstrap({mode:'simulation',from,to},access,grants);assert.equal(r.spatial.state,'available');assert.ok(r.spatial.data.grids.length>0);assert.ok(r.spatial.data.communities.length>0);assert.ok(r.spatial.data.events.length>0);assert.ok(r.spatial.data.pipelines.length>0);}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('模拟事件详情保留历史且不需要数据库',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;poolAny.getConnection=async()=>{throw Error('不得访问数据库');};poolAny.query=async()=>{throw Error('不得访问数据库');};
 try{const to=shanghaiToday(),grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read'];const r=await screenBootstrap({mode:'simulation',from:to.slice(0,7)+'-01',to},access,grants);const event=r.spatial.data.events[0] as any;const detail=await screenEvent(r.contextId,event.id,access,grants);assert.ok(detail.history?.length);assert.equal(typeof detail.relatedDemands.total,'number');}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('真实只读快照复用有效户数且仅接纳正式来源',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;let rollback=0;const to=shanghaiToday();
 poolAny.getConnection=async()=>({query:async(sql:string)=>{if(sql.includes('from complaint c'))return [[{source_system:'宜接就办',source_id:'REAL-1',complaint_id:'C1',enterprise_code:'E',district_code:'A',business_type:'water',source_reported_at:new Date(to+'T03:00:00Z'),received_at:null,admin_grid_code:null,community_code:null,major_category_code:null},{source_system:'DEMO-20261110',source_id:'D1',complaint_id:'D1',enterprise_code:'E',district_code:'A',business_type:'water',source_reported_at:new Date(to+'T03:00:00Z')}],[]];if(sql.includes('from enterprise where'))return [[{enterprise_code:'E',district_code:'A'}],[]];if(sql.includes('from enterprise_household_version'))return [[{households:20000,valid_from:to,valid_to:null,version:1}],[]];return [[],[]];},rollback:async()=>{rollback++},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const grants=['statistics.read','dashboard.read','complaint.read','enterprise.read'];const r=await screenBootstrap({from:to,to},access,grants);assert.equal(r.summary.total,1);assert.equal((r.supply.data.enterpriseRates[0] as any).per10k,0.5);assert.equal(rollback,1);}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('模拟网格比较允许零诉求网格并计算非零网格分类',async()=>{
 const to=shanghaiToday(),sample=simulatedSupportData(to).complaints[0].occurredAt.slice(0,10),grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read'];const r=await screenBootstrap({mode:'simulation',from:sample,to:sample},access,grants);
 const grids=r.spatial.data.grids as any[],page=screenDemands(r.contextId,1,100,access,grants);const active=page.items.find(x=>grids.some(g=>g.id===x.adminGridCode))?.adminGridCode;
 assert.ok(active);const empty=grids.find(g=>!page.items.some(x=>x.adminGridCode===g.id));assert.ok(empty);const c=screenCompare(r.contextId,active+','+empty.id,access,grants);assert.ok(c.rows.length>0);assert.ok(c.rows.every(row=>row.values[1].count===0));
});
test('真实事件版本变化拒绝详情，版本一致则返回历史与关联',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query;const to=shanghaiToday();
 const event:any={id:'EV1',mode:'real',kind:'shutdown',businessType:'water',enterpriseId:'E',districtCode:'A',title:'停供',startsAt:to+'T00:00:00+08:00',endsAt:to+'T23:59:59+08:00',gridIds:['G'],relatedTypes:[],approvalStatus:'approved',revision:2,updatedAt:to+'T00:00:00Z'};
 poolAny.getConnection=async()=>({query:async()=>[[],[]],rollback:async()=>{},release:()=>{}});poolAny.query=async(_sql:string,args:any[])=>args?.[0]==='utility-real'?[[{revision:1,content:{events:[event],deliveries:{}}}],[]]:[[],[]];
 try{const grants=['statistics.read','dashboard.read','complaint.read','shutdown.read'];const r=await screenBootstrap({from:to,to},access,grants);const detail:any={event,history:[{revision:2,updatedAt:event.updatedAt,event}],complaints:[]};await assert.rejects(()=>screenEvent(r.contextId,'EV1',access,grants,async()=>({...detail,event:{...event,revision:3}}) as any),/版本/);const ok=await screenEvent(r.contextId,'EV1',access,grants,async()=>detail);assert.equal(ok.history?.length,1);assert.equal(ok.relatedDemands.total,null);}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('未知维度的汇总编码与全局筛选、明细下钻一致',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query,to=shanghaiToday();const all:any={...access,rules:[{kind:'all'}]};
 poolAny.getConnection=async()=>({query:async(sql:string)=>sql.includes('from complaint c')?[[{source_system:'宜接就办',source_id:'R1',complaint_id:'C1',enterprise_code:null,district_code:null,business_type:'water',source_reported_at:new Date(to+'T03:00:00Z'),major_category_code:null,admin_grid_code:null,community_code:null}],[]]:[[],[]],rollback:async()=>{},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read'];const r=await screenBootstrap({from:to,to,districtCode:'__missing__',enterpriseCode:'__missing__',adminGridCode:'__missing__',communityCode:'__missing__',categoryCode:'__missing__'},all,grants);assert.equal(r.summary.total,1);const page=screenDemands(r.contextId,1,20,all,grants,{districtCode:'__missing__',enterpriseCode:'__missing__',adminGridCode:'__missing__',communityCode:'__missing__',categoryCode:'__missing__'});assert.equal(page.total,1);assert.equal(r.charts.category[0].code,'__missing__');}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('上下文创建后撤销网格权限立即遮盖事件与诉求网格',async()=>{
 const to=shanghaiToday(),allGrants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','pipeline.read','shutdown.read'];const r=await screenBootstrap({mode:'simulation',from:to.slice(0,7)+'-01',to},access,allGrants);const event=r.spatial.data.events[0] as any;
 const reduced=allGrants.filter(x=>x!=='heatmap.read');const detail=await screenEvent(r.contextId,event.id,access,reduced);assert.deepEqual(detail.event.gridIds,[]);const page=screenDemands(r.contextId,1,20,access,reduced);assert.ok(page.items.every(x=>x.adminGridCode===null));
});
test('预警与历史五季、月度、网格和往年Top3证据与摘要件数一致',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','enterprise.read','shutdown.read','pipeline.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);
 const checks:any[]=[];for(const w of r.warnings.data.items)checks.push([w.evidenceKey,w.count]);for(const t of r.top3.data.items)checks.push([t.evidenceKey,t.count]);for(const s of r.research.data.seasons){for(const y of s.years)checks.push([y.evidenceKey,y.count]);for(const m of s.months){checks.push([m.currentEvidenceKey,m.currentCount],[m.previousEvidenceKey,m.previousCount]);}for(const g of s.topGrids)checks.push([g.currentEvidenceKey,g.count],[g.previousEvidenceKey,g.previousCount]);}
 assert.ok(checks.length>10);for(const [key,count] of checks){assert.equal(typeof key,'string');const e=screenEvidence(r.contextId,key,1,100,access,grants);assert.equal(e.total,count);}
 const first=checks[0][0];assert.throws(()=>screenEvidence(r.contextId,first,1,10,{...access,userId:'other'},grants),/不存在/);assert.throws(()=>screenEvidence(r.contextId,first,1,10,access,['statistics.read','dashboard.read']),/权限/);
});
test('模拟热力按含首尾天数和模拟系数计算并保留零值网格',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);assert.equal(r.heat.state,'available');assert.equal(r.heat.data.days,10);assert.deepEqual(r.heat.data.thresholds,[0.3,1,3,10,30]);assert.equal(r.heat.data.ruleVersion,'simulation-only');assert.equal(r.heat.data.grids.length,r.spatial.data.grids.length);assert.equal(r.heat.data.grids.reduce((n,g)=>n+g.count,0),r.summary.total);assert.ok(r.heat.data.grids.every(g=>g.level!==null));
 const denied=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants.filter(x=>x!=='heatmap.read'));assert.equal(denied.heat.state,'unavailable');assert.equal(denied.heat.data.days,null);assert.deepEqual(denied.heat.data.grids,[]);
});
test('模拟事件按明确标注的行业、网格、时间和问题类型给出可复核的关联',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','shutdown.read','pipeline.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);
 let found=false;for(const e of r.spatial.data.events){const detail=await screenEvent(r.contextId,e.id,access,grants);assert.match(detail.relatedDemands.reason,/模拟/);if(detail.relatedDemands.total&&detail.relatedDemands.total>0){found=true;assert.equal(detail.relatedDemands.items.length,detail.relatedDemands.total);const row=detail.relatedDemands.items[0] as any;assert.ok(row.type&&row.occurredAt&&row.gridId);assert.match(detail.relatedDemands.reason,/筛选交集/);break;}}assert.equal(found,true);
});
import {screenContexts} from '../src/services/screenContext';
test('专题证据分页、范围变化、空间权限回收及过期均受控',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read','grid.read','heatmap.read','shutdown.read','pipeline.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);
 const warning=r.warnings.data.items.find(x=>(x.count??0)>1)!;assert.ok(warning?.evidenceKey);const first=screenEvidence(r.contextId,warning.evidenceKey,1,1,access,grants);assert.equal(first.items.length,1);assert.equal(first.total,warning.count);
 assert.throws(()=>screenEvidence(r.contextId,warning.evidenceKey,0,20,access,grants),/页码/);assert.throws(()=>screenEvidence(r.contextId,warning.evidenceKey,1,20,{...access,scopeVersion:2},grants),/不存在/);
 const grid=r.research.data.seasons.flatMap(s=>s.topGrids)[0];assert.ok(grid?.currentEvidenceKey);assert.throws(()=>screenEvidence(r.contextId,grid.currentEvidenceKey,1,20,access,grants.filter(x=>x!=='heatmap.read')),/权限/);
 const item=screenContexts.get(r.contextId)!;item.expires=Date.now()-1;assert.throws(()=>screenEvidence(r.contextId,warning.evidenceKey,1,20,access,grants),/过期/);
});
test('正式预警无发布证据时返回空证据原因，不伪造零值',async()=>{
 const poolAny=pool as any,oldGet=poolAny.getConnection,oldQuery=poolAny.query,to=shanghaiToday();poolAny.getConnection=async()=>({query:async()=>[[],[]],rollback:async()=>{},release:()=>{}});poolAny.query=async()=>[[],[]];
 try{const grants=['statistics.read','dashboard.read','complaint.read'];const r=await screenBootstrap({from:to,to},access,grants);const e=screenEvidence(r.contextId,r.warnings.data.items[0].evidenceKey,1,20,access,grants);assert.equal(e.state,'unavailable');assert.equal(e.total,null);assert.ok(e.reason);assert.deepEqual(e.items,[]);}finally{poolAny.getConnection=oldGet;poolAny.query=oldQuery;}
});
test('预警携带模拟规则元数据，证据规则版本与摘要一致',async()=>{
 const grants=['statistics.read','dashboard.read','complaint.read'];const r=await screenBootstrap({mode:'simulation',from:'2026-11-01',to:'2026-11-10'},access,grants);for(const w of r.warnings.data.items){assert.ok(w.threshold&&w.days);assert.equal(typeof w.enabled,'boolean');assert.equal(w.ruleVersion,'simulation-warning-v1');const e=screenEvidence(r.contextId,w.evidenceKey,1,1,access,grants);assert.equal(e.ruleVersion,w.ruleVersion);}
});
