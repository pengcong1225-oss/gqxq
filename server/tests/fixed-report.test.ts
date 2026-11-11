import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {freezeReportSnapshot,canonical,digest,parseStoredSnapshot,type ReportSnapshot} from '../src/domain/reportSnapshot';
import {reportProofs} from '../src/auth/reportScope';
import {renderReport,reportSections} from '../src/services/reportRenderer';
import type {StatisticsCapture} from '../src/services/statisticsService';
import type {ReportCreateInput} from '../src/types/report';
import type {StatisticsComplaint} from '../src/types/statistics';

const input:ReportCreateInput={requestId:'fixed-test',templateCode:'statistics-draft',templateVersion:'v1',format:'docx',includeHeat:false,todoIds:[],query:{dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-11-01',to:'2026-11-10',comparisonPolicyId:'candidate-calendar-v1'}};
function row(id:number,businessType:string,businessDay:string):StatisticsComplaint {
 return {id,complaintId:String(id),complaintNo:String(id),title:null,businessType,complaintType:'complaint',majorCode:'pressure',minorCode:null,dictionaryVersion:'1',districtCode:'D1',districtName:'西陵区',enterpriseCode:'E1',enterpriseName:'供水企业',longitude:null,latitude:null,coordinateSystem:null,coordinateSource:null,adminGridCode:null,communityCode:null,sourceReportedAt:businessDay+'T04:00:00Z',receivedAt:businessDay+'T04:00:00Z',editVersion:1,enteredAt:null,analysisId:null,businessAt:businessDay+'T04:00:00Z',businessDay,timeSource:'source_reported_at',timeReason:null,grids:[],locationReason:null,snapshotReason:null};
}
function capture(rows:StatisticsComplaint[],extended=false):StatisticsCapture {
 const q=extended?{...input.query,from:'2025-01-01'}:input.query;
 return {version:1,rows,summary:{query:q,policy:{id:'candidate-calendar-v1',version:1,status:'candidate',label:'候选统计政策'},timezone:'Asia/Shanghai',timeBasis:'来源填报时间优先，缺失时回退接收时间',total:rows.length,partial:false,dateFilterUnavailableCount:0,sourceTimeFallbackCount:0,unlocatedCount:rows.length,multiGridCount:0,excludedByReason:{},dimensions:[{dimension:'category',code:'pressure',level:'major',dictionaryVersion:'1',name:'压力问题',count:rows.length}],comparisons:[],dataCutoffAt:'2026-11-10T05:00:00.000Z',projectionCapabilities:{businessDate:null,category:null,location:null},trend:[{date:'2026-11-10',count:rows.length}],rates:[],overallRate:{value:null,reason:'无完整户数'},satisfactionRate:{value:null,reason:'无有效回访'}},periodFacts:[{kind:'current',from:q.from,to:q.to,rows,excludedRows:[]}],categoryEvidence:[],coverageEvidence:[],householdEvidence:[],masterScopeFacts:[],scopeFacts:rows.map(r=>({complaintId:r.complaintId,current:{enterpriseCode:r.enterpriseCode,districtCode:r.districtCode},original:{enterpriseCode:r.enterpriseCode,districtCode:r.districtCode}})),legacyListItems:[],legacyMetrics:{sensitive:0,closedInSystem:0,sourceClosed:0,sourceKnown:0}};
}
function snapshot():ReportSnapshot {
 const selected=capture([row(1,'water','2026-11-10'),row(2,'gas','2026-11-09')]);
 const extended=capture([...selected.rows,row(3,'water','2026-01-01'),row(4,'water','2025-11-10'),row(5,'gas','2026-10-01')],true);
 return freezeReportSnapshot(input,selected,[{kind:'all'}],null,[],extended);
}
test('fixed report freezes calendar comparison facts without changing the selected-period total',()=>{
 const s=snapshot();
 assert.equal(s.statistics.summary.total,2);
 assert.equal(s.tenderStatistics?.services[0].periods.find(p=>p.key==='year')?.total,2);
 assert.equal(s.tenderStatistics?.services[0].periods.find(p=>p.key==='year')?.comparisons.find(c=>c.kind==='yoy')?.baselineCount,1);
 assert.ok(reportProofs(s).some(p=>p.kind==='complaint'&&p.key==='4'));
 assert.ok(s.domain.ranges.some(r=>r.from==='2025-01-01'));
 const text=canonical(s);assert.deepEqual(parseStoredSnapshot(text,digest(text)),s);
});
test('fixed template separates water and gas, year/quarter/month types and unavailable indicators',()=>{
 const sections=reportSections(snapshot());
 const types=sections.find(s=>s.title==='供水服务年季月分类型同比环比')!;
 assert.ok(types);
 assert.ok(types.rows.some(r=>r.includes('压力问题')&&r.includes(2)));
 assert.ok(sections.some(s=>s.title==='供气服务年季月分类型同比环比'));
 assert.ok(sections.some(s=>s.title==='指标数据说明'&&s.rows.some(r=>r.join('').includes('办理'))));
});
test('overall calendar report includes every authorized business and gives the annual baseline explicitly',()=>{
 const selected=capture([row(1,'water','2026-11-10')]);
 const extended=capture([...selected.rows,row(2,'lpg','2026-11-09'),row(3,'water','2025-11-10')],true);
 const sections=reportSections(freezeReportSnapshot(input,selected,[{kind:'all'}],null,[],extended));
 const overall=sections.find(s=>s.title==='全部业务年季月诉求量')!;
 assert.ok(overall);
 assert.ok(overall.rows.some(r=>r.includes('年度诉求量')&&r.includes(2)));
 assert.ok(overall.rows.some(r=>r.some(v=>String(v).includes('上年同期'))));
});
test('Word and Excel export the same fixed report and retain reproducible bytes',async()=>{
 const s=snapshot(),word=await renderReport(s);
 assert.deepEqual(await renderReport(s),word);
 const zip=await JSZip.loadAsync(word),xml=await zip.file('word/document.xml')!.async('string');
 assert.match(xml,/供水服务年季月分类型同比环比/);
 assert.doesNotMatch(xml,/statistics-draft v1 工程草稿/);
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await renderReport({...s,input:{...s.input,format:'xlsx'}}) as any);
 const cells:string[]=[];workbook.eachSheet(sheet=>sheet.eachRow(row=>row.eachCell(c=>cells.push(String(c.value)))));
 assert.ok(cells.includes('供气服务年季月分类型同比环比'));
 assert.ok(cells.includes('压力问题'));
});
test('legacy immutable snapshots still render and unsupported renderers remain rejected',async()=>{
 const old=freezeReportSnapshot(input,capture([row(1,'water','2026-11-10')]),[{kind:'all'}]);
 old.renderPlan='statistics-draft-v1/docx9.9.0-exceljs4.4.0/2';
 assert.ok((await renderReport(old)).length>1000);
 await assert.rejects(renderReport({...old,renderPlan:'unsupported'} as any),/RENDERER_UNAVAILABLE/);
});
