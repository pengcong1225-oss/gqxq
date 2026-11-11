import React from 'react';
import {Button,Card,Descriptions,Space,Typography} from 'antd';
import type {ComplaintDetail,ComplaintSourceDocument} from '../types/api';
const raw=(value:string|null|undefined)=><span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value??'来源未提供'}</span>;
export default function ComplaintSourceSummary({detail,canReadDocument,documentLoading,onReadDocument}:{detail:ComplaintDetail;canReadDocument:boolean;documentLoading:boolean;onReadDocument:()=>void}) {
 const s=detail.sourceSummary;
 return <Card title="来源业务信息" style={{marginBottom:16}}>
  <Descriptions bordered size="small" column={2}>
   <Descriptions.Item label="案件公文号">{raw(detail.sourceId)}</Descriptions.Item>
   <Descriptions.Item label="案件类型">{raw(s?.caseType)}</Descriptions.Item>
   <Descriptions.Item label="来源案件主类型">{raw(s?.majorCategory)}</Descriptions.Item>
   <Descriptions.Item label="来源案件二级类型">{raw(s?.minorCategory)}</Descriptions.Item>
   <Descriptions.Item label="责任部门">{raw(s?.department)}</Descriptions.Item>
   <Descriptions.Item label="二级单位">{raw(s?.secondaryDepartment)}</Descriptions.Item>
   <Descriptions.Item label="来源区">{raw(s?.district)}</Descriptions.Item>
   <Descriptions.Item label="来源街道">{raw(s?.street)}</Descriptions.Item>
   <Descriptions.Item label="来源小区／社区">{raw(s?.community)}</Descriptions.Item>
   <Descriptions.Item label="来源网格">{raw(s?.grid)}</Descriptions.Item>
   <Descriptions.Item label="来源录入时间">{detail.sourceReportedAt?new Date(detail.sourceReportedAt).toLocaleString('zh-CN'):'来源未提供'}</Descriptions.Item>
   <Descriptions.Item label="来源督办状态">{raw(s?.supervisionStatus)}</Descriptions.Item>
   <Descriptions.Item label="规定完成时间（来源原值）">{raw(s?.deadlineRaw)}</Descriptions.Item>
   <Descriptions.Item label="实际完成时间（来源原值）">{raw(s?.completedRaw)}</Descriptions.Item>
   <Descriptions.Item label="来源处理结果" span={2}>{raw(s?.result)}</Descriptions.Item>
   <Descriptions.Item label="市民姓名及电话" span={2}>{canReadDocument?<Space wrap><Button size="small" loading={documentLoading} onClick={onReadDocument}>查看市民信息及来源原件</Button><Typography.Text type="secondary">按来源原件权限读取并留存访问记录</Typography.Text></Space>:'需来源原件读取权限'}</Descriptions.Item>
  </Descriptions>
 </Card>;
}
/** Only render after the audited source-document endpoint has authorized this read. */
export function SourceCitizenFields({document}:{document:ComplaintSourceDocument}) {
 const payload=document.sourcePayload??{};const metadata=payload.metadata&&typeof payload.metadata==='object'&&!Array.isArray(payload.metadata)?payload.metadata as Record<string,unknown>:{};
 const value=(keys:string[])=>{for(const bag of [metadata,payload])for(const key of keys){const v=bag[key];if((typeof v==='string'&&v.trim())||typeof v==='number')return String(v);}return null;};
 return <Descriptions bordered size="small" column={1} style={{marginBottom:16}}>
  <Descriptions.Item label="市民姓名">{raw(value(['市民姓名','来电人姓名','citizenName']))}</Descriptions.Item>
  <Descriptions.Item label="市民电话">{raw(value(['市民电话','联系电话','来电人电话','citizenPhone']))}</Descriptions.Item>
 </Descriptions>;
}
