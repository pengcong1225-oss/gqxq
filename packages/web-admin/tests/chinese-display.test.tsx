import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ChineseDetail from '../src/components/ChineseDetail';
import {chineseLabel,namedLabel,fieldValue,detailLines,systemMessage} from '../src/utils/chineseDisplay';

test('source systems and channels display Chinese names and keep unknown codes hidden',()=>{
 assert.equal(fieldValue('sourceSystem','LOCAL_ACCEPTANCE'),'本地验收来源');
 assert.equal(fieldValue('source_system','YJJB'),'宜接就办');
 assert.equal(fieldValue('sourceChannel','hotline'),'热线');
 assert.equal(fieldValue('source_channel','WEB'),'网页端');
 assert.equal(fieldValue('sourceSystem','UNRECOGNIZED_SOURCE'),'来源系统待核实');
 assert.equal(fieldValue('sourceChannel','UNRECOGNIZED_CHANNEL'),'来源渠道待核实');
 assert.equal(fieldValue('sourceChannel','12345热线'),'12345热线');
 assert.equal(fieldValue('sourceChannel',null),'—');
});

test('the same internal state has Chinese labels appropriate to its workflow',()=>{
 assert.equal(chineseLabel('pending','supervision_status'),'待推送');
 assert.equal(chineseLabel('pending','correction_status'),'待纠偏');
 assert.equal(chineseLabel('pending','report_todo_status'),'待处理');
 assert.equal(chineseLabel('in_progress','report_todo_status'),'处理中');
 assert.equal(chineseLabel('accepted','source_event_status'),'已受理');
 assert.equal(chineseLabel('accepted','reporting_status'),'企业已签收');
 assert.equal(namedLabel('future_state','future_state','supervision_status'),'未知状态');
 assert.equal(namedLabel('pending','自定义待推送','supervision_status'),'自定义待推送');
});
test('authorized detail displays Chinese fields and enums, preserves business content and does not mutate the response',()=>{
 const data=Object.freeze({before:Object.freeze({business_type:'water',status:'enabled'}),after:Object.freeze({business_type:'gas',status:'disabled'}),changes:[{fieldName:'complaint_type',oldValue:'complaint',newValue:'help'}],content:'Customer supplied English text',complaintNo:'CASE-2026-001',enabled:true});
 const html=renderToStaticMarkup(<ChineseDetail value={data}/>);
 for(const text of ['变更前','变更后','供水','燃气','启用','停用','诉求类型','投诉','求助','是','CASE-2026-001','Customer supplied English text'])assert.ok(html.includes(text),text);
 for(const code of ['business_type','enabled','disabled','fieldName','complaint_type','before','after'])assert.equal(html.includes(code),false,code);
 assert.equal(data.before.business_type,'water');assert.equal(data.after.status,'disabled');
});
test('unknown configuration keys and values, rule reasons and transport errors never leak English system codes',()=>{
 assert.equal(detailLines({unrecognized_configuration: {state:'future_state'}}),'其他信息：状态：未知状态');
 assert.equal(chineseLabel('POLICY_INCOMPLETE'),'规则配置尚未完整');
 assert.equal(fieldValue('roles','unknown_custom_role'),'其他角色');
 assert.equal(chineseLabel('来源导出 metadata.坐席满意度'),'来源坐席评价记录');
 assert.equal(fieldValue('status',1),'启用');assert.equal(fieldValue('status',0),'停用');
 assert.equal(systemMessage('Network Error'),'无法连接服务，请检查网络后重试');
 assert.equal(systemMessage('timeout of 15000ms exceeded'),'请求超时，请稍后重试');
 assert.equal(systemMessage('Internal Server Error'),'请求失败，请稍后重试');
 assert.equal(systemMessage('数据版本已变化，请刷新'),'数据版本已变化，请刷新');
});
