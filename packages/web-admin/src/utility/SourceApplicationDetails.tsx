import React from 'react';
import {Descriptions,Table,Typography} from 'antd';
import {formatUtilityTime} from './shared';

const labels:Record<string,string>={companyName:'报备企业',projectName:'项目名称',projectType:'工程类型',reportCode:'报备编号',tingshuiDate:'停水时间',tingqiDate:'停气时间',fugongDate:'恢复供给时间',kgDate:'开工日期',jhwcDate:'计划完工日期',tingshuiDescribe:'停水说明',tingqiDescribe:'停气说明',shigongDescribe:'施工说明',tingshuiRange:'停水影响范围',tingqiRange:'停气影响范围',effectResidentTotal:'影响居民户数',effectNotResidentTotal:'影响非居民户数',isReportTingshui:'停水类型',isReportTingqi:'停气类型',isPlanShigong:'施工类型',sgdwName:'施工单位',isAdvanceReport:'是否提前报备',isNoticeResident:'是否通知居民',isNoticeKeynote:'是否通知重点单位',keyUnit:'重点单位',isImplementReport:'是否落实报备',isAvoid:'是否避开高峰',planYear:'计划年度',createDate:'申请时间'};
function display(value:unknown):string{
 if(value==null||value==='')return '—';
 if(typeof value==='string'&&value.trim().startsWith('[')){try{return display(JSON.parse(value));}catch{/* Free text remains unchanged. */}}
 if(Array.isArray(value))return value.map(item=>typeof item==='object'&&item?String((item as Record<string,unknown>).name||'已绘制影响范围'):String(item)).join('、')||'—';
 if(typeof value==='object')return '已提供';
 return String(value);
}
export default function SourceApplicationDetails({fields,traces}:{fields:Record<string,unknown>;traces:unknown[]}){
 const history=traces.filter((v):v is Record<string,unknown>=>!!v&&typeof v==='object');
 return <><Descriptions bordered size="small" column={2} items={Object.entries(labels).filter(([key])=>fields[key]!=null).map(([key,label])=>({key,label,children:display(fields[key])}))}/><Typography.Title level={5}>原申请审批记录</Typography.Title><Table size="small" pagination={false} rowKey={(_,index)=>String(index)} dataSource={history} columns={[{title:'办理动作',dataIndex:'action',render:display},{title:'办理人',dataIndex:'operator',render:display},{title:'办理时间',dataIndex:'time',render:v=>v?formatUtilityTime(String(v)):'—'},{title:'办理意见',dataIndex:'opinion',render:display}]} locale={{emptyText:'来源系统尚无审批记录'}}/></>;
}
