import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupportResearch, seasonWindow, validateWarningRules, localDay } from '../src/tenderSupport/researchModel';
import type { SupportComplaint, SupportWarningRule, TenderDataset } from '../src/tenderSupport/types';

const row=(id:string,day:string,overrides:Partial<SupportComplaint>={}):SupportComplaint=>({id,title:id,businessType:'gas',type:'气压问题',enterpriseId:'E',districtCode:'D',gridId:'G1',communityId:'C',occurredAt:`${day}T12:00:00+08:00`,completedAt:null,evaluation:'unevaluated',longitude:111,latitude:30,scenario:'winter',...overrides});
const dataset=(complaints:SupportComplaint[]):TenderDataset=>({schemaVersion:1,revision:1,mode:'simulation',sourceLabel:'测试模拟',updatedAt:'2026-11-10T00:00:00Z',complaints,grids:[],communities:[],enterprises:[],events:[]});
const rules:SupportWarningRule[]=['winter','summer','planned','installation'].map(s=>({scenario:s as SupportWarningRule['scenario'],name:s,days:3,threshold:2,enabled:true}));

test('winter crosses year using ending-year labels and Shanghai local days',()=>{
 assert.deepEqual(seasonWindow('winter',2026),{from:'2025-11-01',to:'2026-03-31'});
 assert.deepEqual(seasonWindow('summer',2026),{from:'2026-06-01',to:'2026-09-30'});
 assert.equal(localDay('2026-10-31T16:00:00Z'),'2026-11-01');
 assert.equal(localDay('invalid'),null);
});
test('prior-year same range clamps leap day and top three has stable ties and exact rows',()=>{
 const result=buildSupportResearch(dataset([row('a','2023-02-28',{type:'A'}),row('b','2023-02-28',{type:'B'}),row('c','2023-02-28',{type:'C'}),row('d','2023-02-28',{type:'D'}),row('future','2024-02-29')]),'2024-02-29','2024-02-29',rules);
 assert.deepEqual(result.priorRange,{from:'2023-02-28',to:'2023-02-28'});
 assert.deepEqual(result.priorTop3.map(r=>r.name),['A','B','C']);
 assert.deepEqual(result.priorTop3[0].rows.map(r=>r.id),['a']);
});
test('each scenario uses its own inclusive lookback, threshold and enabled state',()=>{
 const complaints=[row('a','2026-11-08'),row('b','2026-11-10'),row('before','2026-11-07'),row('future','2026-11-11'),row('p1','2026-11-10',{scenario:'planned'}),row('p2','2026-11-10',{scenario:'planned'}),row('i','2026-11-10',{scenario:'installation'})];
 const ownRules=rules.map(r=>({...r,enabled:r.scenario!=='planned',threshold:r.scenario==='installation'?1:2}));
 const result=buildSupportResearch(dataset(complaints),'2026-11-01','2026-11-10',ownRules);
 assert.deepEqual(result.warnings.map(w=>[w.rule.scenario,w.rows.length,w.triggered]),[['winter',2,true],['summer',0,false],['planned',2,false],['installation',1,true]]);
 assert.deepEqual(result.warnings[0].rows.map(r=>r.id),['a','b']);
 assert.equal(validateWarningRules(rules),null);
 assert.match(validateWarningRules([{...rules[0],days:0},...rules.slice(1)])||'',/正整数/);
 assert.ok(validateWarningRules([rules[0]]));
});
test('five seasons include recently started winter and clip to asof; top6 stable ties matches previous grid ids',()=>{
 const complaints=[...Array.from({length:7},(_,i)=>row(`w${i}`,'2026-11-02',{gridId:`G${i+1}`})),row('prev','2025-11-02'),row('tooLate','2026-11-11'),row('unrelated','2026-11-02',{type:'燃气其他'})];
 const result=buildSupportResearch(dataset(complaints),'2026-11-01','2026-11-10',rules);
 assert.deepEqual(result.winter.years.map(y=>y.year),[2023,2024,2025,2026,2027]);
 assert.equal(result.winter.current.to,'2026-11-10');
 assert.equal(result.winter.current.rows.length,7);
 assert.equal(result.winter.previous.year,2026);
 assert.deepEqual(result.winter.topGrids.map(g=>g.id),['G1','G2','G3','G4','G5','G6']);
 assert.equal(result.winter.topGrids[0].previousRows.length,1);
 assert.equal(result.winter.months[0].currentRows.length,7);
 assert.equal(result.winter.months[1].currentRows.length,0);
 assert.equal(result.winter.years.flatMap(y=>y.rows).some(r=>r.id==='tooLate'),false);
});
test('summer uses water pressure only and latest started season, empty data stays empty',()=>{
 const result=buildSupportResearch(dataset([row('s','2026-06-01',{businessType:'water',type:'水压问题',scenario:'summer'}),row('gas','2026-06-01',{scenario:'summer'})]),'2026-01-01','2026-11-10',rules);
 assert.equal(result.summer.current.year,2026);assert.deepEqual(result.summer.current.rows.map(r=>r.id),['s']);
 assert.equal(buildSupportResearch(dataset([]),'2026-01-01','2026-11-10',rules).winter.topGrids.length,0);
});

test('read-only permission renders disabled rule fields and simulation labeling',async()=>{
 const React=await import('react');
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {default:SupportResearch}=await import('../src/tenderSupport/SupportResearch');
 const html=renderToStaticMarkup(React.createElement(SupportResearch,{data:dataset([]),from:'2026-11-01',to:'2026-11-10',onComplaint:()=>{},config:{revision:1,rules},onSaveRules:async()=>{},canManage:false}));
 assert.match(html,/模拟数据/);assert.match(html,/无规则管理权限/);
 assert.match(html,/aria-label="冬季供气观察天数"[^>]*disabled/);
 assert.match(html,/保存预警规则/);assert.match(html,/prefers-reduced-motion/);
});

test('backend rule view excludes presentation charts, preview excludes configuration',async()=>{
 const React=await import('react');
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {default:SupportResearch}=await import('../src/tenderSupport/SupportResearch');
 const props={data:dataset([]),from:'2026-11-01',to:'2026-11-10',onComplaint:()=>{},config:{revision:1,rules},onSaveRules:async()=>{},canManage:true};
 const manage=renderToStaticMarkup(React.createElement(SupportResearch,{...props,view:'rules'}));
 assert.match(manage,/保存预警规则/);assert.doesNotMatch(manage,/最近五季诉求总量|往年同期高发诉求/);
 const preview=renderToStaticMarkup(React.createElement(SupportResearch,{...props,view:'preview'}));
 assert.match(preview,/最近五季诉求总量/);assert.doesNotMatch(preview,/保存预警规则|触发阈值/);
});
