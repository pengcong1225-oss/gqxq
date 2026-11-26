import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildScreen, type ScreenQuery} from '../src/domain/screen';
import {TENDER_HEAT_POLICY, TENDER_HEAT_POLICY_ID, tenderHeatConfirmation} from '../src/domain/heatRule';
import {screenHeat} from '../src/services/screenHeat';
import {screenBootstrap, screenDemands} from '../src/services/screenService';
import {pool} from '../src/db/pool';
import type {AccessContext} from '../src/auth/accessScope';
import type {SqlExecutor} from '../src/repositories/userRepo';
import type {ScreenEvidenceItem} from '../src/services/screenEvidence';

const access: AccessContext = {userId:'u',roles:['readonly'],scopeVersion:1,canReadSource:false,rules:[{kind:'all'}]};
const grants=['grid.read','heatmap.read'];
const query: ScreenQuery = {mode:'real',from:'2026-11-01',to:'2026-11-30',businessType:'water',categoryCode:'w02'};
const geometry={type:'Polygon',coordinates:[[[111,30],[112,30],[112,31],[111,31],[111,30]]]};
const grid=(code:string,overrides:Record<string,unknown>={})=>({code,name:'测试网格 '+code,district_code:'A',version:1,geometry,coordinate_system:'WGS84',geometry_source:'主管部门授权边界',...overrides});
const fact=(gridCode:string, index:number, overrides:Record<string,unknown>={})=>({
 source_system:'宜接就办',source_id:gridCode+index,complaint_id:gridCode+'-'+index,enterprise_code:'E',
 district_code:'A',business_type:'water',source_reported_at:new Date('2026-11-02T00:00:00Z'),
 admin_grid_code:gridCode,community_code:'C-'+gridCode,major_category_code:'water_service',minor_category_code:'w02',...overrides
});
const publication=(key:string,effectiveFrom:string,coefficients=['1','5','10','20','30'])=>{
 const [majorCode,minorCode]=key.split('|');
 const version=key+effectiveFrom;
 return {version_id:version,content:{formatVersion:1,rule:{version,effectiveFrom,category:{majorCode,minorCode:minorCode||null,dictionaryVersion:'1'},coefficients,policyId:TENDER_HEAT_POLICY_ID,policyVersion:1},policy:TENDER_HEAT_POLICY,confirmation:tenderHeatConfirmation()}};
};
function database(options:{rules?:ReturnType<typeof publication>[];grids?:ReturnType<typeof grid>[];validPolicy?:boolean}={}){
 return {query:async(sql:string,params:unknown[])=>{
  if(sql.includes('from dict_item'))return [[{code:'water_service',label:'供水服务',parentCode:null,status:'enabled',published:1},{code:'w02',label:'用水费用问题',parentCode:'water_service',status:'enabled',published:1}],[]];
  if(sql.includes('from heat_rule_published')){
   assert.match(sql,/effective_from<=\?/);
   return [(options.rules??[]).filter(({content:{rule:r}})=>r.category.majorCode+'|'+(r.category.minorCode??'')===String(params[0])&&r.effectiveFrom<=String(params[1])).sort((a,b)=>b.content.rule.effectiveFrom.localeCompare(a.content.rule.effectiveFrom)).slice(0,1),[]];
  }
  if(sql.includes('from heat_policy_version'))return [options.validPolicy===false?[]:[{fingerprint:tenderHeatConfirmation().fingerprint}],[]];
  if(sql.includes('from admin_grid'))return [options.grids??[],[]];
  if(sql.includes('from community'))return [[{code:'C-G300',name:'正式社区',admin_grid_code:'G300'},{code:'C-G301',name:'不相符的社区',admin_grid_code:'OTHER'}],[]];
  throw new Error('Unexpected SQL: '+sql);
 }} as unknown as SqlExecutor;
}
const result=(facts: Record<string,unknown>[]=[], overrides:Partial<ScreenQuery>={}, scope=access)=>buildScreen({...query,...overrides},scope,facts,[],null);

test('正式热力按日期和小类生效版本计算 300/301/600/601，保持已授权成功映射的件数与明细一致',async()=>{
 const cases=[300,301,600,601];
 const rows=cases.flatMap(n=>Array.from({length:n},(_,i)=>fact('G'+n,i)));
 rows.push(fact('G300',1000,{business_type:'gas'}),fact('G300',1001,{minor_category_code:'w03'}),fact('G300',1002,{district_code:'B'}),fact('G300',1003,{source_reported_at:new Date('2026-12-01T00:00:00Z')}),fact('OSM',1004),fact('A',1005),fact('UNKNOWN',1006),fact('PENDING',1007),fact('OTHER_CRS',1008));
 const db=database({rules:[publication('water_service|','2026-11-01',['2','6','11','21','31']),publication('water_service|w02','2026-11-02'),publication('water_service|w02','2026-12-01',['2','6','11','21','31'])],
   grids:[...cases.map(n=>grid('G'+n)),grid('OSM',{geometry_source:'OSM 近似'}),grid('A'),grid('UNKNOWN',{geometry_source:'unknown'}),grid('PENDING',{geometry_source:'来源待核实'}),grid('OTHER_CRS',{coordinate_system:'GCJ-02'})]});
 const details=new Map<string, ScreenEvidenceItem[]>();
 const section=await screenHeat(result(rows),null,grants,{query,access,db,details});
 assert.equal(section.state,'partial');
 assert.equal(section.data.days,30);
 assert.deepEqual(section.data.thresholds,[30,150,300,600,900]);
 assert.deepEqual(section.data.grids.map(g=>[g.count,g.level]),[[300,'yellow'],[301,'orange'],[600,'orange'],[601,'red']]);
 assert.deepEqual(section.data.grids[0].communities,['正式社区']);
 assert.deepEqual(section.data.grids[1].communities,[]);
 assert.deepEqual(section.data.grids[0].geometry,geometry);
 assert.equal(section.data.unmappedCount,6);
 assert.equal(details.get('G300')?.length,300);
});

test('大类汇总子类，小类无生效版本按已发布政策回退，零值按规则显示绿色',async()=>{
 const db=database({rules:[publication('water_service|','2026-11-01')],grids:[grid('G')]});
 const rows=[fact('G',1),fact('G',2,{minor_category_code:'w03'})];
 const major={...query,categoryCode:'water_service'};
 const section=await screenHeat(result(rows,major),null,grants,{query:major,access,db});
 assert.deepEqual(section.data.grids.map(g=>g.count),[2]);
 const minor=await screenHeat(result(),null,grants,{query,access,db});
 assert.equal(minor.state,'available');
 assert.equal(minor.data.ruleVersion,'water_service|2026-11-01');
 assert.deepEqual(minor.data.grids.map(g=>[g.count,g.level]),[[0,'green']]);
});

test('全行业下供水分类仅取供水主账，供气标签下不会用供水系数着色',async()=>{
 const db=database({rules:[publication('water_service|w02','2026-11-02')],grids:[grid('G')]});
 const rows=[fact('G',1),fact('G',2,{business_type:'gas'}),fact('G',3,{business_type:null})];
 const all={...query,businessType:undefined};
 const section=await screenHeat(result(rows,all),null,grants,{query:all,access,db});
 assert.deepEqual(section.data.grids.map(g=>g.count),[1]);
 const gas={...query,businessType:'gas'};
 const unavailable=await screenHeat(result(rows,gas),null,grants,{query:gas,access,db});
 assert.match(unavailable.reason??'',/当前行业不匹配/);
 assert.deepEqual(unavailable.data.grids.map(g=>g.level),[null]);
});

test('无生效规则、无正式面、政策未核验、无权限时明确标识且无正式颜色',async()=>{
 const rows=[fact('G',1)];
 const noRule=await screenHeat(result(rows),null,grants,{query,access,db:database({grids:[grid('G')]})});
 assert.match(noRule.reason??'',/无已发布热力规则/);
 assert.deepEqual(noRule.data.grids.map(g=>g.level),[null]);
 const rules=[publication('water_service|w02','2026-11-02')];
 const noGrid=await screenHeat(result(rows),null,grants,{query,access,db:database({rules})});
 assert.match(noGrid.reason??'',/正式行政网格/);
 assert.deepEqual(noGrid.data.grids,[]);
 const noPolicy=await screenHeat(result(rows),null,grants,{query,access,db:database({rules,grids:[grid('G')],validPolicy:false})});
 assert.match(noPolicy.reason??'',/确认政策/);
 assert.deepEqual(noPolicy.data.grids.map(g=>g.level),[null]);
 const noPerm=await screenHeat(result(rows),null,['grid.read'],{query,access,db:{query:()=>assert.fail('禁止读取数据库')} as unknown as SqlExecutor});
 assert.match(noPerm.reason??'',/缺少网格或热力权限/);
 assert.deepEqual(noPerm.data.grids,[]);
 const restricted:AccessContext={...access,rules:[{kind:'restricted',enterpriseCodes:['E'],districtCodes:['A']}]};
 const scoped=await screenHeat(result(rows,{},restricted),null,grants,{query,access:restricted,db:database({rules,grids:[grid('G'),grid('OTHER',{district_code:'B'}),grid('EMPTY')]})});
 assert.deepEqual(scoped.data.grids.map(g=>g.code),['G']);
});

test('大屏接口由同一只读快照提供热力及网格明细，校验身份与空间权限',async()=>{
 const mock=database({rules:[publication('water_service|w02','2026-11-02')],grids:[grid('G300')]});
 const getConnection=pool.getConnection;
 const queryPool=pool.query;
 let readOnly=false;
 Object.assign(pool,{
  getConnection:async()=>({
   query:async(sql:string,params:unknown[])=>{
    if(sql.startsWith('set transaction'))return [[],[]];
    if(sql.includes('consistent snapshot, read only')){readOnly=true;return [[],[]];}
    assert.equal(readOnly,true);
    if(sql.includes('from complaint c'))return [[fact('G300',1),fact('G300',2,{district_code:'B'}),fact('G300',3,{business_type:'gas'})],[]];
    if(sql.includes('from community c left join'))return [[],[]];
    if(sql.includes('from enterprise where'))return [[],[]];
    return mock.query(sql,params as any);
   },
   rollback:async()=>{readOnly=false;},
   release:()=>{},
  }),
  query:async()=>[[],[]],
 });
 try{
  const {mode,from,businessType,categoryCode}=query;
  const to='2026-11-10';
  const permissions=['statistics.read','dashboard.read','complaint.read',...grants];
  const snapshot=await screenBootstrap({mode,from,to,businessType,categoryCode},access,permissions);
  assert.equal(snapshot.layers.heat.state,'partial');
  assert.deepEqual(snapshot.heat.data.grids.map(g=>[g.code,g.count,g.level]),[['G300',1,'green']]);
  const page=screenDemands(snapshot.contextId,1,20,access,permissions,{heatGridCode:'G300'});
  assert.equal(page.total,1);
  assert.equal(page.items[0].id,'G300-1');
  assert.throws(()=>screenDemands(snapshot.contextId,1,20,access,permissions.filter(p=>p!=='grid.read'),{heatGridCode:'G300'}),/权限/);
  assert.throws(()=>screenDemands(snapshot.contextId,1,20,{...access,scopeVersion:2},permissions,{heatGridCode:'G300'}),/权限范围/);
  assert.throws(()=>screenDemands(snapshot.contextId,1,20,access,permissions,{heatGridCode:'UNKNOWN'}),/没有该正式网格/);
 }finally{
  Object.assign(pool,{getConnection,query:queryPool});
 }
});
