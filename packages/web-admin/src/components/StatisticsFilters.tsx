import React from 'react';
import {Button,Space,Typography} from 'antd';
import type {StatisticsQuery,PeriodKind,StatisticsDataset,StatisticsProjection} from '../types/statistics';
export type StatisticsDraft=Omit<StatisticsQuery,'projection'>&{projection:StatisticsProjection|''};
export function statisticsToday(){return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});}
export function initialStatisticsDraft(dataset:StatisticsDataset):StatisticsDraft {
 const to=statisticsToday();const d=new Date(to+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-29);
 return {dataset,projection:dataset==='ledger'?'current':'',periodKind:'custom',from:d.toISOString().slice(0,10),to,comparisonPolicyId:'candidate-calendar-v1'};
}
const fieldStyle:React.CSSProperties={display:'inline-flex',flexDirection:'column',gap:4,minWidth:130};
const controlStyle:React.CSSProperties={height:32,border:'1px solid #d9d9d9',borderRadius:6,padding:'4px 8px',background:'white'};
export default function StatisticsFilters({value,onChange,onApply,allowed,loading}:{value:StatisticsDraft;onChange:(v:StatisticsDraft)=>void;onApply:()=>void;allowed:StatisticsDataset[];loading:boolean}){
 const update=(v:Partial<StatisticsDraft>)=>onChange({...value,...v,bucket:undefined});
 const preset=(kind:PeriodKind)=>{const today=statisticsToday();const month=Number(today.slice(5,7));const from=kind==='year'?today.slice(0,4)+'-01-01':kind==='quarter'?today.slice(0,4)+'-'+String(Math.floor((month-1)/3)*3+1).padStart(2,'0')+'-01':kind==='month'?today.slice(0,7)+'-01':value.from;update({periodKind:kind,from,to:today});};
 return <div style={{padding:16,background:'#fafafa',borderRadius:8,marginBottom:16}}><Space wrap align="end">
  <label style={fieldStyle}>数据集<select aria-label="统计数据集" style={controlStyle} value={value.dataset} onChange={e=>update({dataset:e.target.value as StatisticsDataset,projection:e.target.value==='ledger'?'current':''})}>{allowed.map(d=><option key={d} value={d}>{d==='ledger'?'诉求总账':'分析库'}</option>)}</select></label>
  {value.dataset==='analysis'?<label style={fieldStyle}>分析投影<select aria-label="分析投影" style={controlStyle} value={value.projection} onChange={e=>update({projection:e.target.value as StatisticsProjection})}><option value="">请选择分析投影</option><option value="current">已入分析集合 · 当前有效值</option><option value="entry_snapshot">入库快照 · 缺失值如实未知</option></select></label>:<Typography.Text>当前有效值</Typography.Text>}
  <label style={fieldStyle}>期间<select aria-label="统计期间" style={controlStyle} value={value.periodKind} onChange={e=>preset(e.target.value as PeriodKind)}><option value="custom">自定义</option><option value="month">本月截至今日</option><option value="quarter">本季度截至今日</option><option value="year">本年截至今日</option></select></label>
  <label style={fieldStyle}>起始业务日<input aria-label="起始业务日" style={controlStyle} type="date" value={value.from} max={statisticsToday()} onChange={e=>update({from:e.target.value,periodKind:'custom'})}/></label>
  <label style={fieldStyle}>结束业务日<input aria-label="结束业务日" style={controlStyle} type="date" value={value.to} max={statisticsToday()} onChange={e=>update({to:e.target.value,periodKind:'custom'})}/></label>
  {([['businessType','业务编码'],['majorCode','正式大类编码'],['minorCode','正式小类编码'],['enterpriseCode','企业编码'],['districtCode','区划编码'],['serviceGridCode','服务网格编码']] as const).map(([field,label])=><label key={field} style={fieldStyle}>{label}<input aria-label={label} style={controlStyle} value={value[field]??''} maxLength={64} placeholder="全部" onChange={e=>update({[field]:e.target.value||undefined})}/></label>)}
  <Button type="primary" loading={loading} disabled={!value.projection||!allowed.includes(value.dataset)} onClick={onApply}>应用统计筛选</Button>
 </Space></div>;
}
