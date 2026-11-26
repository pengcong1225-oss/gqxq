import React from 'react';
import {Button,Card,Descriptions,Space,Tag,Typography} from 'antd';
import type {ComplaintDetail,ComplaintSourceDocument} from '../types/api';
const raw=(value:string|null|undefined)=><span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value??'来源未提供'}</span>;
const SATISFACTION_LABEL:Record<string,string>={satisfied:'满意',basically_satisfied:'基本满意',unsatisfied:'不满意',no_reply:'暂无回复结果'};
export default function ComplaintSourceSummary({detail,canReadDocument,documentLoading,onReadDocument}:{detail:ComplaintDetail;canReadDocument:boolean;documentLoading:boolean;onReadDocument:()=>void}) {
 const s=detail.sourceSummary;
 const satisfactionText=detail.satisfactionText ?? s?.satisfaction ?? null;
 const satisfactionCode=detail.satisfactionCode ?? s?.satisfactionCode ?? null;
 return <Card title="来源业务信息（标书 1.1.2 详情字段）" style={{marginBottom:16}}>
  <Descriptions bordered size="small" column={2}>
   <Descriptions.Item label="案件公文号">{raw(detail.sourceId)}</Descriptions.Item>
   <Descriptions.Item label="案件类型">{raw(s?.caseType)}</Descriptions.Item>
   <Descriptions.Item label="来源案件主类型">{raw(s?.majorCategory)}</Descriptions.Item>
   <Descriptions.Item label="来源案件二级类型">{raw(s?.minorCategory)}</Descriptions.Item>
   <Descriptions.Item label="主办单位">
    {raw(detail.sourceDepartmentName ?? s?.department)}
    {detail.enterpriseName && detail.enterpriseName !== s?.department && (
     <div><Typography.Text type="secondary" style={{fontSize:12}}>主数据企业：{detail.enterpriseName}</Typography.Text></div>
    )}
   </Descriptions.Item>
   <Descriptions.Item label="二级单位">{raw(detail.secondaryDepartment ?? s?.secondaryDepartment)}</Descriptions.Item>
   <Descriptions.Item label="行业主管部门">{raw(detail.industryDepartment)}</Descriptions.Item>
   <Descriptions.Item label="是否保密">{raw(detail.isConfidential)}</Descriptions.Item>
   <Descriptions.Item label="是否自办自结">{raw(detail.selfHandled)}</Descriptions.Item>
   <Descriptions.Item label="事项分类">{raw(detail.itemCategory)}</Descriptions.Item>
   <Descriptions.Item label="来源小类">{raw(detail.sourceSubCategory)}</Descriptions.Item>
   <Descriptions.Item label="来源区">{raw(s?.district)}</Descriptions.Item>
   <Descriptions.Item label="来源街道">{raw(detail.streetName ?? s?.street)}</Descriptions.Item>
   <Descriptions.Item label="来源小区／社区">{raw(detail.communityName ?? s?.community)}</Descriptions.Item>
   <Descriptions.Item label="来源网格">{raw(detail.gridName ?? s?.grid)}</Descriptions.Item>
   <Descriptions.Item label="来源录入时间">{detail.sourceReportedAt?new Date(detail.sourceReportedAt).toLocaleString('zh-CN'):'来源未提供'}</Descriptions.Item>
   <Descriptions.Item label="来源事件状态">{raw(s?.eventStatus)}</Descriptions.Item>
   <Descriptions.Item label="来源督办状态">{raw(s?.supervisionStatus)}</Descriptions.Item>
   {detail.sourceEventStatusCode !== 'unknown' && detail.sourceEventStatusName && (
    <Descriptions.Item label="来源同步状态" span={2}>{detail.sourceEventStatusName}</Descriptions.Item>
   )}
   <Descriptions.Item label="接线员">{raw(detail.operatorName)}</Descriptions.Item>
   <Descriptions.Item label="定位情况">{raw(detail.locationFlag)}</Descriptions.Item>
   <Descriptions.Item label="规定完成时间（来源原件）">{raw(s?.deadlineRaw)}</Descriptions.Item>
   <Descriptions.Item label="实际完成时间（来源原件）">{raw(s?.completedRaw)}</Descriptions.Item>
   <Descriptions.Item label="市民回复结果（满意度）" span={2}>
    {satisfactionText ? (
     <Space size={6} wrap><span>{satisfactionText}</span>{satisfactionCode && <Tag>{SATISFACTION_LABEL[satisfactionCode] ?? satisfactionCode}</Tag>}</Space>
    ) : raw(null)}
   </Descriptions.Item>
   <Descriptions.Item label="坐席满意度" span={2}>{raw(detail.seatSatisfaction)}</Descriptions.Item>
   <Descriptions.Item label="办理结果" span={2}>{raw(detail.handlingResult ?? s?.result)}</Descriptions.Item>
   <Descriptions.Item label="回复市民结果" span={2}>{raw(detail.replyToCitizen)}</Descriptions.Item>
   <Descriptions.Item label="在线办结依据" span={2}>{raw(detail.onlineCloseBasis)}</Descriptions.Item>
   <Descriptions.Item label="市民姓名">{detail.citizenName ? detail.citizenName : raw(null)}</Descriptions.Item>
   <Descriptions.Item label="市民电话">{detail.citizenPhone ? detail.citizenPhone : raw(null)}</Descriptions.Item>
   <Descriptions.Item label="来源原件" span={2}>{canReadDocument?<Space wrap><Button size="small" loading={documentLoading} onClick={onReadDocument}>查看市民信息及来源原件</Button><Typography.Text type="secondary">按来源原件权限读取并留存访问记录</Typography.Text></Space>:'需来源原件读取权限'}</Descriptions.Item>
  </Descriptions>
 </Card>;
}
/** Only render after the audited source-document endpoint has authorized this read. */
export function SourceCitizenFields({document}:{document:ComplaintSourceDocument}) {
 const payload=document.sourcePayload??{};const metadata=payload.metadata&&typeof payload.metadata==='object'&&!Array.isArray(payload.metadata)?payload.metadata as Record<string,unknown>:{};
 const value=(keys:string[])=>{for(const bag of [metadata,payload])for(const key of keys){const v=bag[key];if((typeof v==='string'&&v.trim())||typeof v==='number')return String(v);}return null;};
 return <Descriptions bordered size="small" column={1} style={{marginBottom:16}}>
  <Descriptions.Item label="市民姓名">{raw(value(['市民姓名','来电人姓名','诉求人','citizenName']))}</Descriptions.Item>
  <Descriptions.Item label="市民电话">{raw(value(['市民电话','联系电话','来电人电话','诉求人电话','citizenPhone']))}</Descriptions.Item>
 </Descriptions>;
}
