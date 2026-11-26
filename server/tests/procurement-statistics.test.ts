import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {calculateSourceSatisfaction,procurementExclusion,PROCUREMENT_POLICY_ID,type FollowupFact} from '../src/domain/procurementFacts';
import {snapshotFactsFromComplaint,readStatisticsSnapshot} from '../src/domain/statisticsFacts';
import {captureStatisticsIn} from '../src/services/statisticsService';
import {captureTenderStatisticsIn} from '../src/services/tenderStatisticsService';
import {aggregateTenderStatistics,tenderCaptureRange} from '../src/domain/tenderStatistics';
import {freezeReportSnapshot,parseReportInput,canonical,digest,parseStoredSnapshot,PROCUREMENT_RENDER_PLAN} from '../src/domain/reportSnapshot';
import {renderReport,reportChartValues,reportSections} from '../src/services/reportRenderer';
import type {StatisticsQuery} from '../src/types/statistics';
import type {SqlExecutor} from '../src/repositories/userRepo';
import type {AccessContext} from '../src/auth/accessScope';

const query:StatisticsQuery={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-11-01',to:'2026-11-10',comparisonPolicyId:PROCUREMENT_POLICY_ID};
const access:AccessContext={userId:'test',roles:['readonly'],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false};
const permissions=['statistics.read','dashboard.read','analysis.read'];
const clock=()=>new Date('2026-11-11T00:00:00Z');
function complaint(id:string,patch:Record<string,unknown>={}){return {id:Number(id),complaint_id:id,complaint_no:'C'+id,title:'测试',business_type:'water',complaint_type:'complaint',enterprise_code:'E1',source_system:'宜接就办',source_id:'SRC-'+id,source_event_status:'completed',source_synced_at:'2026-11-10T04:00:00Z',source_reported_at:'2026-11-09T04:00:00Z',received_at:'2026-11-09T04:00:00Z',edit_version:1,...patch};}
function followup(complaintId='1',patch:Partial<FollowupFact>={}):FollowupFact{return {eventId:'F-'+complaintId,sourceId:'trusted',sourceObjectId:'FU-'+complaintId,sourceVersion:1,sourceUpdatedAt:'2026-11-10T05:00:00Z',bindingTrusted:true,payload:{complaintId,occurredAt:'2026-11-10T04:00:00Z',contacted:true,evaluation:'satisfied'},...patch};}
function database(rows:Record<string,unknown>[],heads:Record<string,unknown>[]=[]){
 const calls:{sql:string;values:unknown[]}[]=[];
 const byId=new Map(rows.map(row=>[row.complaint_id,row]));
 const db:SqlExecutor={query:async(sql,values=[])=>{
  calls.push({sql,values});
  const from=sql.indexOf(' from complaint c');
  if(from!==-1){
   assert.match(sql,/c.source_synced_at/);
   // Run the repository's actual scope, join and date predicates on synthetic rows.
   const memory=new DatabaseSync(':memory:');
   try{
    memory.exec(`create table complaint (id integer, complaint_id text, enterprise_code text, deleted integer,
      source_system text, source_id text, source_reported_at text, received_at text, business_type text,
      major_category_code text, minor_category_code text);
      create table analysis_record (analysis_id text, complaint_id text);`);
    const insert=memory.prepare('insert into complaint values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertAnalysis=memory.prepare('insert into analysis_record values (?, ?)');
    const bind=(value:unknown)=>(value instanceof Date?value.toISOString():value??null) as SQLInputValue;
    for(const row of rows){
     insert.run(...['id','complaint_id','enterprise_code','deleted','source_system','source_id','source_reported_at',
       'received_at','business_type','major_category_code','minor_category_code'].map(key=>bind(row[key])));
     if(row.analysis_id)insertAnalysis.run(bind(row.analysis_id),bind(row.complaint_id));
    }
    const selected=memory.prepare('select c.complaint_id'+sql.slice(from)).all(...values.map(bind));
    return [selected.map(row=>byId.get(row.complaint_id)),[]];
   }finally{memory.close();}
  }
  if(sql.includes('from source_business_head')){
   assert.ok(values.every(id=>byId.has(id)));
   return [heads.filter(h=>values.includes((h.content as FollowupFact).payload.complaintId)),[]];
  }
  return [[],[]];
 }};
 return {db,calls};
}
function head(f=followup(),binding:unknown={sourceId:'trusted',complaintId:'1',sourceSystem:'宜接就办',sourceObjectId:'SRC-1'}){return {event_id:f.eventId,content:f,followup_binding:binding};}

test('procurement excludes closed/platform closure, missing provenance/date and non-water/gas; default still counts ledger',async()=>{
 const rows=[complaint('1'),complaint('2',{source_event_status:'closed',closed_in_system:1}),complaint('3',{source_event_status:'processing',closed_in_system:1}),complaint('4',{source_synced_at:null}),complaint('5',{source_system:'other'}),complaint('6',{business_type:'lpg'}),complaint('7',{source_reported_at:null}),complaint('8',{source_reported_at:null,received_at:'2024-01-01T00:00:00Z'})];
 const {db,calls}=database(rows);
 const procurement=await captureStatisticsIn(db,query,access,permissions,clock);
 assert.deepEqual(procurement.rows.map(r=>r.complaintId),['1']);
 assert.equal(procurement.summary.sourceTimeFallbackCount,0);
 assert.equal(Object.values(procurement.summary.excludedByReason).reduce((a,b)=>a+b,0),7);
 assert.equal(procurement.summary.excludedByReason['来源未明确办结（关闭不等于办结）'],2);
 assert.equal(procurement.summary.dateFilterUnavailableCount,2);
 assert.deepEqual(calls.filter(c=>c.sql.includes('source_business_head')).map(c=>c.values),[['1']]);
 calls.length=0;
 const legacy=await captureStatisticsIn(db,{...query,comparisonPolicyId:'candidate-calendar-v1'},access,permissions,clock);
 assert.equal(legacy.summary.total,7);assert.equal(legacy.summary.sourceTimeFallbackCount,1);
 assert.equal(calls.some(c=>c.sql.includes('source_business_head')),false);
});

test('procurement counts current and comparison cases using Shanghai calendar boundaries and enterprise scope',async()=>{
 const rows=[
  complaint('1',{source_reported_at:'2026-10-31T16:00:00Z'}),
  complaint('2',{source_reported_at:'2026-11-10T15:59:59Z'}),
  complaint('3',{source_reported_at:'2026-11-10T16:00:00Z'}),
  complaint('4',{source_reported_at:'2025-10-31T16:00:00Z'}),
  complaint('5',{source_reported_at:'2025-10-31T15:59:59Z'}),
  complaint('6',{source_reported_at:'2026-10-25T04:00:00Z'}),
  complaint('7',{enterprise_code:'E2'}),
 ];
 const result=await captureStatisticsIn(database(rows).db,query,access,permissions,clock);
 assert.deepEqual(result.rows.map(row=>row.complaintId).sort(),['1','2']);
 assert.deepEqual(result.periodFacts.find(period=>period.kind==='yoy')!.rows.map(row=>row.complaintId),['4']);
 assert.deepEqual(result.periodFacts.find(period=>period.kind==='mom')!.rows.map(row=>row.complaintId),['6']);
});

test('tender statistics retains permissions, frozen facts, exclusions and incomplete comparisons',async()=>{
 const ledgerRows=[
  complaint('1'),
  complaint('2',{source_reported_at:'2025-11-09T04:00:00Z'}),
  complaint('3',{enterprise_code:'E2'}),
  complaint('4',{source_reported_at:null,received_at:null}),
  complaint('5',{source_reported_at:null}),
  complaint('6',{source_reported_at:'2025-11-09T04:00:00Z',source_event_status:'closed'}),
  complaint('7',{source_reported_at:'2026-12-01T04:00:00Z',source_event_status:'closed'}),
 ];
 const analysisRows=ledgerRows.map(row=>({...row,source_reported_at:'2023-01-01T00:00:00Z',
  analysis_id:'A'+row.complaint_id,statistics_snapshot_version:2,statistics_snapshot:snapshotFactsFromComplaint(row)}));
 for(const comparisonPolicyId of ['candidate-calendar-v1',PROCUREMENT_POLICY_ID] as const){
  const procurement=comparisonPolicyId===PROCUREMENT_POLICY_ID;
  for(const dataset of ['ledger','analysis'] as const){
   const q:StatisticsQuery={...query,dataset,projection:dataset==='analysis'?'entry_snapshot':'current',comparisonPolicyId};
   const {db}=database(dataset==='analysis'?analysisRows:ledgerRows);
   const result=await captureTenderStatisticsIn(db,q,access,permissions,clock);
   const selected=await captureStatisticsIn(db,q,access,permissions,clock);
   const extended=await captureStatisticsIn(db,{...q,...tenderCaptureRange(q),periodKind:'custom'},access,permissions,clock);
   assert.deepEqual(result,aggregateTenderStatistics(selected,extended));
   assert.equal(result.total,procurement?1:2);
   assert.equal(result.partial,true);
   assert.equal(result.dateFilterUnavailableCount,procurement?2:1);
   assert.equal(result.sourceTimeFallbackCount,procurement?0:1);
   assert.deepEqual(result.excludedByReason,procurement?{'来源录入时间缺失或无效':2}:{'业务日期不可用':1});
   const yoy=result.periods[0].comparisons.find(c=>c.kind==='yoy')!;
   assert.equal(yoy.baselineCount,procurement?1:2);
   assert.equal(yoy.changePercent,null);
   assert.equal(yoy.reason,'存在业务日期未知的记录，比较不完整');
  }
 }
});

test('procurement annual summary and frozen report chart use the tender year-to-date baseline',async()=>{
 const annual:StatisticsQuery={...query,periodKind:'year',from:'2026-01-01'};
 const {db}=database([complaint('1'),complaint('2'),complaint('3',{source_reported_at:'2025-11-09T04:00:00Z'})]);
 const capture=await captureStatisticsIn(db,annual,access,permissions,clock);
 const annualMom=capture.summary.comparisons.find(comparison=>comparison.kind==='mom')!;
 assert.deepEqual([annualMom.from,annualMom.to,annualMom.baselineCount,annualMom.changePercent],['2025-01-01','2025-11-10',1,100]);
 assert.equal(annualMom.label,'年度环比（上年同期累计）');
 const annualMomFacts=capture.periodFacts.find(period=>period.kind==='mom')!;
 assert.deepEqual(annualMomFacts.rows.map(row=>row.complaintId),['3']);

 const extended=await captureStatisticsIn(db,{...annual,from:'2025-01-01',periodKind:'custom'},access,permissions,clock);
 const input=parseReportInput({requestId:'annual',templateCode:'procurement-statistics',templateVersion:'v1',format:'docx',query:annual});
 const frozen=freezeReportSnapshot(input,capture,access.rules,null,[],extended);
 assert.deepEqual(reportChartValues(frozen),[{label:'本期',value:2},{label:'同比',value:1},{label:'年度环比（上年同期累计）',value:1}]);
 const annualCard=frozen.tenderStatistics!.periods.find(period=>period.key==='year')!;
 assert.deepEqual(annualCard.comparisons.find(comparison=>comparison.kind==='mom'),annualMom);

 const candidate=await captureStatisticsIn(db,{...annual,comparisonPolicyId:'candidate-calendar-v1'},access,permissions,clock);
 const candidateMom=candidate.summary.comparisons.find(comparison=>comparison.kind==='mom')!;
 assert.equal(candidateMom.baselineCount,null);
 assert.equal(candidateMom.reason,'年度环比未定义');
});

test('snapshot v2 freezes source completion; v1 never borrows current completion evidence',async()=>{
 const live=complaint('1',{major_category_code:'pressure'}),v2=snapshotFactsFromComplaint(live);
 assert.equal(readStatisticsSnapshot(2,JSON.stringify(v2))?.sourceEventStatus,'completed');
 const {sourceId,sourceSystem,sourceEventStatus,sourceSyncedAt,...v1}=v2;
 assert.ok(readStatisticsSnapshot(1,v1));assert.equal(readStatisticsSnapshot(1,v1)?.sourceEventStatus,undefined);
 const rows=[
  {...live,analysis_id:'A1',statistics_snapshot_version:1,statistics_snapshot:v1},
  {...complaint('2',{source_event_status:'closed',source_reported_at:'2023-01-01T00:00:00Z',business_type:'gas',major_category_code:'leak'}),analysis_id:'A2',statistics_snapshot_version:2,statistics_snapshot:{...v2,complaintId:'2',sourceId:'SRC-2'}},
  {...complaint('3',{enterprise_code:'E2'}),analysis_id:'A3',statistics_snapshot_version:2,statistics_snapshot:{...v2,complaintId:'3',sourceId:'SRC-3'}},
 ];
 const result=await captureStatisticsIn(database(rows).db,{...query,dataset:'analysis',projection:'entry_snapshot',businessType:'water',majorCode:'pressure'},access,permissions,clock);
 assert.deepEqual(result.rows.map(r=>r.complaintId),['2']);
 assert.equal(result.rows[0].sourceEventStatus,'completed');
 assert.equal(result.summary.excludedByReason['非宜接就办来源或缺来源证据'],1);
 assert.equal(procurementExclusion({...v2,sourceEventStatus:'closed'}),'来源未明确办结（关闭不等于办结）');
});

test('satisfaction uses only trusted unique latest valid heads; corrections do not fall back to older valid responses',()=>{
 const valid=followup('1'),bad=followup('2',{bindingTrusted:false}),a=followup('3'),b=followup('3',{eventId:'tie'});
 const old=followup('4'),latest=followup('4',{eventId:'latest',payload:{complaintId:'4',occurredAt:'2026-11-11T00:00:00Z',contacted:false,evaluation:null}});
 const missing=followup('5',{payload:{complaintId:'5',occurredAt:null,contacted:true,evaluation:'satisfied'}});
 const dissatisfied=followup('6',{payload:{complaintId:'6',occurredAt:'2026-11-10T04:00:00Z',contacted:true,evaluation:'dissatisfied'}});
 const result=calculateSourceSatisfaction(['1','2','3','4','5','6','7'],[valid,bad,a,b,old,latest,missing,dissatisfied,followup('outside')]);
 assert.equal(result.value,50);assert.equal(result.validCount,2);assert.equal(result.satisfiedCount,1);
 assert.deepEqual(result.evidence.map(e=>e.complaintId),['1','6']);assert.equal(result.excluded.length,5);
 assert.equal(result.considered.some(f=>f.payload.complaintId==='outside'),false);
 assert.equal(calculateSourceSatisfaction(['1'],[]).value,null);
});

test('capture validates persisted binding against the selected complaint source identity',async()=>{
 const trusted=head(),wrong=head(followup('2'),{sourceId:'trusted',complaintId:'2',sourceSystem:'宜接就办',sourceObjectId:'some-other-source-case'});
 const result=await captureStatisticsIn(database([complaint('1'),complaint('2')],[trusted,wrong]).db,query,access,permissions,clock);
 assert.equal(result.summary.satisfactionRate.value,100);assert.equal(result.summary.satisfactionRate.validCount,1);
 assert.match(result.satisfactionEvidence!.excluded[0].reason,/可信/);
 const tender=aggregateTenderStatistics(result,result);assert.equal(tender.satisfactionRate?.value,100);
 assert.equal(tender.dynamics.unavailable.some(e=>e.key==='satisfaction'),false);
});

test('procurement template requires explicit policy and preserves frozen report evidence and calendar sections in both exports',async()=>{
 const input={requestId:'test',templateCode:'procurement-statistics',templateVersion:'v1',format:'docx',query,includeHeat:false,todoIds:[]};
 assert.throws(()=>parseReportInput({...input,query:{...query,comparisonPolicyId:'candidate-calendar-v1'}}));
 const f=followup(),cap=await captureStatisticsIn(database([complaint('1')],[head(f)]).db,query,access,permissions,clock);
 const s=freezeReportSnapshot(parseReportInput(input),cap,access.rules,null,[],cap);
 assert.equal(s.renderPlan,PROCUREMENT_RENDER_PLAN);assert.equal(s.statistics.satisfactionEvidence?.evidence[0].sourceVersion,1);
 f.payload.evaluation='dissatisfied';cap.summary.satisfactionRate.value=0;
 assert.equal(s.statistics.summary.satisfactionRate.value,100);
 const frozen=canonical(s);assert.deepEqual(parseStoredSnapshot(frozen,digest(frozen)),s);
 assert.ok(reportSections(s).some(section=>section.title==='外部回访满意度'&&section.rows[0].includes(100)));
 assert.ok(reportSections(s).some(section=>section.title==='供水服务年季月分类型同比环比'));
 const word=await renderReport(s);assert.deepEqual(await renderReport(s),word);
 const zip=await JSZip.loadAsync(word),xml=await zip.file('word/document.xml')!.async('string');assert.match(xml,/外部回访满意度/);assert.match(xml,/关闭和平台闭环不能代替来源办结/);
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await renderReport({...s,input:{...s.input,format:'xlsx'}}) as any);
 const values:string[]=[];workbook.eachSheet(sheet=>sheet.eachRow(row=>row.eachCell(cell=>values.push(String(cell.value)))));
 assert.ok(values.includes('外部回访满意度'));assert.ok(values.includes('100'));
});
