import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {calculateSourceSatisfaction,procurementExclusion,PROCUREMENT_POLICY_ID,type FollowupFact} from '../src/domain/procurementFacts';
import {snapshotFactsFromComplaint,readStatisticsSnapshot} from '../src/domain/statisticsFacts';
import {captureStatisticsIn} from '../src/services/statisticsService';
import {aggregateTenderStatistics} from '../src/domain/tenderStatistics';
import {freezeReportSnapshot,parseReportInput,canonical,digest,parseStoredSnapshot,PROCUREMENT_RENDER_PLAN} from '../src/domain/reportSnapshot';
import {renderReport,reportSections} from '../src/services/reportRenderer';
import type {StatisticsQuery} from '../src/types/statistics';
import type {SqlExecutor} from '../src/repositories/userRepo';
import type {AccessContext} from '../src/auth/accessScope';

const query:StatisticsQuery={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-11-01',to:'2026-11-10',comparisonPolicyId:PROCUREMENT_POLICY_ID};
const access:AccessContext={userId:'test',roles:['readonly'],scopeVersion:1,rules:[{kind:'restricted',enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false};
const permissions=['statistics.read','dashboard.read','analysis.read'];
const clock=()=>new Date('2026-11-11T00:00:00Z');
function complaint(id:string,patch:Record<string,unknown>={}){return {id:Number(id),complaint_id:id,complaint_no:'C'+id,title:'测试',business_type:'water',complaint_type:'complaint',enterprise_code:'E1',source_system:'宜接就办',source_id:'SRC-'+id,source_event_status:'completed',source_synced_at:'2026-11-10T04:00:00Z',source_reported_at:'2026-11-09T04:00:00Z',received_at:'2026-11-09T04:00:00Z',edit_version:1,...patch};}
function followup(complaintId='1',patch:Partial<FollowupFact>={}):FollowupFact{return {eventId:'F-'+complaintId,sourceId:'trusted',sourceObjectId:'FU-'+complaintId,sourceVersion:1,sourceUpdatedAt:'2026-11-10T05:00:00Z',bindingTrusted:true,payload:{complaintId,occurredAt:'2026-11-10T04:00:00Z',contacted:true,evaluation:'satisfied'},...patch};}
function database(rows:Record<string,unknown>[],heads:Record<string,unknown>[]=[]){const calls:{sql:string;values:unknown[]}[]=[];const db:SqlExecutor={query:async(sql,values=[])=>{calls.push({sql,values});if(sql.includes(' from complaint c')){assert.match(sql,/c.enterprise_code in \(\?\)/);assert.deepEqual(values,['E1']);assert.match(sql,/c.source_synced_at/);return [rows,[]];}if(sql.includes('from source_business_head')){assert.ok(values.every(id=>rows.some(r=>r.complaint_id===id)));return [heads.filter(h=>values.includes((h.content as any).payload.complaintId)),[]];}return [[],[]];}};return {db,calls};}
function head(f=followup(),binding:unknown={sourceId:'trusted',complaintId:'1',sourceSystem:'宜接就办',sourceObjectId:'SRC-1'}){return {event_id:f.eventId,content:f,followup_binding:binding};}

test('procurement excludes closed/platform closure, missing provenance/date and non-water/gas; default still counts ledger',async()=>{
 const rows=[complaint('1'),complaint('2',{source_event_status:'closed',closed_in_system:1}),complaint('3',{source_event_status:'processing',closed_in_system:1}),complaint('4',{source_synced_at:null}),complaint('5',{source_system:'other'}),complaint('6',{business_type:'lpg'}),complaint('7',{source_reported_at:null})];
 const {db,calls}=database(rows);
 const procurement=await captureStatisticsIn(db,query,access,permissions,clock);
 assert.deepEqual(procurement.rows.map(r=>r.complaintId),['1']);
 assert.equal(procurement.summary.sourceTimeFallbackCount,0);
 assert.equal(Object.values(procurement.summary.excludedByReason).reduce((a,b)=>a+b,0),6);
 assert.equal(procurement.summary.excludedByReason['来源未明确办结（关闭不等于办结）'],2);
 assert.ok(calls.filter(c=>c.sql.includes('source_business_head')).every(c=>JSON.stringify(c.values)==='["1"]'));
 calls.length=0;
 const legacy=await captureStatisticsIn(db,{...query,comparisonPolicyId:'candidate-calendar-v1'},access,permissions,clock);
 assert.equal(legacy.summary.total,7);assert.equal(legacy.summary.sourceTimeFallbackCount,1);
 assert.equal(calls.some(c=>c.sql.includes('source_business_head')),false);
});

test('snapshot v2 freezes source completion; v1 never borrows current completion evidence',async()=>{
 const live=complaint('1'),v2=snapshotFactsFromComplaint(live);
 assert.equal(readStatisticsSnapshot(2,JSON.stringify(v2))?.sourceEventStatus,'completed');
 const {sourceId,sourceSystem,sourceEventStatus,sourceSyncedAt,...v1}=v2;
 assert.ok(readStatisticsSnapshot(1,v1));assert.equal(readStatisticsSnapshot(1,v1)?.sourceEventStatus,undefined);
 const rows=[{...live,analysis_id:'A1',statistics_snapshot_version:1,statistics_snapshot:v1}, {...complaint('2',{source_event_status:'closed'}),analysis_id:'A2',statistics_snapshot_version:2,statistics_snapshot:{...v2,complaintId:'2',sourceId:'SRC-2'}}];
 const result=await captureStatisticsIn(database(rows).db,{...query,dataset:'analysis',projection:'entry_snapshot'},access,permissions,clock);
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
