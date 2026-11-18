import test from 'node:test';
import assert from 'node:assert/strict';
import {projectComplaintDetail} from '../src/services/complaintProjection';
import {parseListQuery} from '../src/services/complaintService';
import {buildWhere} from '../src/repositories/complaintRepo';
import {runAsTrustedSystem} from '../src/auth/accessScope';
import {normalizeComplaintTable} from '../src/services/complaintImportParser';
import {parseLocationCorrectionInput,assertLocationReviewState} from '../src/services/locationValidationService';
import express from 'express';
import request from 'supertest';
import {followupsRouter} from '../src/routes/followups';
import {errorHandler,notFoundHandler} from '../src/middleware/errorHandler';
const access={userId:'reader',roles:['analyst'],scopeVersion:1,rules:[{kind:'all'}] as const,canReadSource:false};
const row={id:1,complaint_id:'C-1',complaint_no:'CS-1',title:'测试',business_type:'gas',complaint_type:'complaint',urgency_level:'normal',source_id:'A-1',source_payload:{metadata:{'案件类型名':'燃气安全','部门名称':'测试部门','街道':'测试街道','小区':'测试小区','规定完成时间':'2026-11-10 18:00:00','实际完成时间':'2026-11-10T19:30:00+08:00','处理结果':'已核实','市民姓名':'测试人','市民电话':'13800000000'}}};
test('source summary exposes known business fields and valid source dates without exposing citizen data',()=>{
 const detail=projectComplaintDetail(row,access as never) as any;
 assert.equal(detail.sourceSummary.caseType,'燃气安全');assert.equal(detail.sourceSummary.department,'测试部门');
 assert.equal(detail.sourceSummary.street,'测试街道');assert.equal(detail.sourceSummary.community,'测试小区');assert.equal(detail.sourceSummary.result,'已核实');
 assert.equal(detail.sourceDeadlineAt,'2026-11-10T10:00:00.000Z');assert.equal(detail.sourceCompletedAt,'2026-11-10T11:30:00.000Z');
 assert.ok(!JSON.stringify(detail).includes('13800000000'));assert.ok(!JSON.stringify(detail).includes('测试人'));
});
test('missing and invalid source dates remain unavailable and never use local closure time',()=>{
 const detail=projectComplaintDetail({...row,closed_at:'2026-11-10T10:00:00Z',source_payload:{metadata:{'规定完成时间':'2026-02-30 18:00:00'}}},access as never);
 assert.equal(detail.sourceDeadlineAt,null);assert.equal(detail.sourceCompletedAt,null);assert.ok(detail.sourceFieldReasons.sourceDeadlineAt);
});
test('source major/minor filters use shared parameterized list and stats conditions',()=>runAsTrustedSystem(()=>{
 const {filter}=parseListQuery({sourceMajorCategory:'供气',sourceMinorCategory:"安全' OR 1=1 --",districtCode:'420502'});
 const where=buildWhere(filter);assert.ok(where.params.includes('供气'));assert.ok(where.params.includes("安全' OR 1=1 --"));assert.ok(!where.text.includes("OR 1=1 --"));assert.ok(where.text.includes('source_major_category_code'));assert.ok(where.text.includes('district_code'));
}));
test('Excel metadata preserves supplied citizen and community fields',()=>{
 const headers=['案件公文号','诉求类型','来话内容','录入时间','案件主类型名','案件二级类型名','市民姓名','市民电话','小区'];
 const [record]=normalizeComplaintTable([headers,['A1','投诉类','测试诉求','2026-11-10 12:00:00','公共事业','供气服务','测试人','13800000000','测试小区']]);
 assert.equal(record.metadata['市民姓名'],'测试人');assert.equal(record.metadata['市民电话'],'13800000000');assert.equal(record.metadata['小区'],'测试小区');
});
test('revising a completed location is explicit and still requires version and basis',()=>{
 const input={complaintId:'C-1',expectedVersion:3,districtCode:null,address:'核实地址',longitude:null,latitude:null,adminGridCode:null,communityCode:null,coordinateSystem:null,coordinateSource:null,basis:'现场重新核实',revision:true};
 assert.equal((parseLocationCorrectionInput(input) as any).revision,true);
 assert.throws(()=>parseLocationCorrectionInput({...input,revision:'true'}));assert.throws(()=>parseLocationCorrectionInput({...input,basis:''}));assert.throws(()=>parseLocationCorrectionInput({...input,expectedVersion:0}));
});
test('confirmed locations need explicit revision while closed and rejected records remain protected',()=>{
 assert.throws(()=>assertLocationReviewState([{status:'confirmed'}],false,false));
 assert.doesNotThrow(()=>assertLocationReviewState([{status:'confirmed'}],true,false));
 assert.throws(()=>assertLocationReviewState([{status:'confirmed'}],true,true));
 assert.throws(()=>assertLocationReviewState([{status:'rejected'}],true,false));
 assert.doesNotThrow(()=>assertLocationReviewState([{status:'pending'}],false,false));
});
test('mounted followup HTTP routes reach guarded services and never accept an absent actor',async()=>{
 const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers['x-test-actor'])req.user={id:'test',username:'test'} as never;next();});app.use(followupsRouter);app.use(notFoundHandler);app.use(errorHandler);
 const facts={requestId:'followup-request-1',contacted:true,occurredAt:'2026-11-10T12:00:00+08:00',evaluationCode:'satisfied',dissatisfactionReason:null,notes:null};
 for(const response of [
  await request(app).get('/complaints/C-1/followups'),
  await request(app).post('/complaints/C-1/followups').send(facts),
  await request(app).patch('/followups/FUP-test').send({...facts,expectedVersion:1,reason:'更正依据'}),
  await request(app).patch('/followups/FUP-test/conclusion').send({requestId:'followup-request-2',expectedVersion:1,reason:'核对依据',conclusion:'已核实'}),
 ]){assert.equal(response.status,401);assert.equal(response.headers['cache-control'],'no-store');}
 const invalid=await request(app).post('/complaints/C-1/followups').set('x-test-actor','yes').send({...facts,evaluationCode:'dissatisfied'});
 assert.equal(invalid.status,400);assert.ok(invalid.body.message.includes('回访请求不合法'));
});

test('v2 27-column export maps source summary and list filters fall back to v2 keys',()=>{
 const v2row={...row,address:'宜昌市西陵区东山大道178号石马小区2栋',district_name:'西陵区',source_payload:{metadata:{'大类':'住','中类':'供气服务','小类':'燃气报损报修问题','主办单位':'中燃宜昌公司','事件状态':'已办结','办理结果':'已处理'}}};
 const detail=projectComplaintDetail(v2row as never,access as never) as any;
 assert.equal(detail.sourceSummary.caseType,'燃气报损报修问题');
 assert.equal(detail.sourceSummary.majorCategory,'住');
 assert.equal(detail.sourceSummary.minorCategory,'供气服务');
 assert.equal(detail.sourceSummary.department,'中燃宜昌公司');
 assert.equal(detail.sourceSummary.district,'西陵区');
 assert.equal(detail.sourceSummary.community,'石马小区');
 assert.equal(detail.sourceSummary.supervisionStatus,'已办结');
 assert.equal(detail.sourceSummary.result,'已处理');
 assert.equal(detail.sourceSummary.deadlineRaw,null);
 const {filter}=parseListQuery({sourceMajorCategory:'住'});
 const where=buildWhere(filter);
 assert.ok(where.text.includes('json_unquote(json_extract(c.source_payload, ?)) = ?'));
 assert.ok(where.params.includes('$.metadata."大类"'));
});
