import {chineseLabel} from '../utils/chineseDisplay';
import React,{useState,useEffect,useRef} from 'react';
import {Alert,Button,Card,Table,Tag,Space,Empty} from 'antd';
import {Link} from 'react-router-dom';
import StatisticsFilters,{initialStatisticsDraft,type StatisticsDraft} from '../components/StatisticsFilters';
import {usePermissionAccess} from '../stores/roleAccess';
import {useAppStore} from '../stores/appStore';
import {getHeatData,type HeatData,type HeatLevel} from '../api/heatRules';
import type {StatisticsDataset,StatisticsQuery} from '../types/statistics';
const labels:Record<HeatLevel,string>={green:'绿',blue:'蓝',yellow:'黄',orange:'橙',red:'红'};
const colors:Record<HeatLevel,string>={green:'#52c41a',blue:'#1677ff',yellow:'#fadb14',orange:'#fa8c16',red:'#f5222d'};
function HeatGeometry({data}:{data:HeatData}){
 const paths=data.grids.flatMap(g=>g.coverages.flatMap(c=>c.coordinateSystem==='WGS84'&&c.geometry?c.geometry.features.flatMap(f=>(f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates).map(rings=>({rings,color:g.level?colors[g.level]:'#999999',key:g.code+':'+c.version}))):[]));
 const coordinates=[...paths.flatMap(p=>p.rings.flat()),...data.points.map(p=>[p.longitude,p.latitude])];if(!coordinates.length)return <Empty description="无可展示的授权位置或覆盖几何"/>;
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const [x,y] of coordinates){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}const scale=Math.min(560/(maxX-minX||1),280/(maxY-minY||1));const project=([x,y]:number[])=>[20+(x-minX)*scale,300-(y-minY)*scale];
 return <><svg role="img" aria-label="网格覆盖与诉求位置" viewBox="0 0 600 320" style={{width:'100%',maxHeight:400,background:'#fafafa'}}>{paths.map((p,i)=><path key={p.key+':'+i} d={p.rings.map(r=>r.map((v,j)=>(j?'L':'M')+project(v).join(',')).join(' ')+'Z').join(' ')} fill={p.color+'22'} stroke={p.color} fillRule="evenodd"/>)}{data.points.map(p=>{const [x,y]=project([p.longitude,p.latitude]);return <circle key={p.complaintId} cx={x} cy={y} r={3} fill="#595959"/>;})}</svg></>;
}
export default function HeatmapView(){
 const user=useAppStore(s=>s.userInfo);
 const manage=usePermissionAccess('heatmap.manage').can;
 const allowed:StatisticsDataset[]=(['ledger','analysis'] as const).filter(d=>user?.permissions.includes(d==='ledger'?'dashboard.read':'analysis.read'));
 const can=Boolean(user&&!user.mustChangePassword&&user.permissions.includes('heatmap.read')&&user.permissions.includes('statistics.read')&&allowed.length);
 const [draft,setDraft]=useState<StatisticsDraft>(()=>initialStatisticsDraft(allowed[0]??'ledger'));
 const [data,setData]=useState<HeatData|null>(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const owner=useRef(0);
 const permissionKey=user?.permissions.join('|');
 const authorizationKey=JSON.stringify([user?.userId,user?.authorizationVersion,permissionKey]);
 const currentAuthorization=useRef(authorizationKey);
 currentAuthorization.current=authorizationKey;
 const load=async()=>{
  const generation=++owner.current;
  const requestAuthorization=authorizationKey;
  const isCurrent=()=>generation===owner.current&&requestAuthorization===currentAuthorization.current;
  setData(null);setError('');
  if(!can||!draft.projection||!allowed.includes(draft.dataset)){setBusy(false);return;}
  setBusy(true);
  try{
   const value=await getHeatData(draft as StatisticsQuery);
   if(isCurrent())setData(value);
  }catch(e){
   if(isCurrent())setError(e instanceof Error?e.message:'热力数据查询失败');
  }finally{
   if(isCurrent())setBusy(false);
  }
 };
 useEffect(()=>{
  if(can&&draft.projection&&allowed.includes(draft.dataset))void load();
  else{owner.current++;setData(null);setError('');setBusy(false);}
  return()=>{owner.current++;};
 },[can,user?.userId,user?.authorizationVersion,permissionKey]);
 return <div><h2>热力图管理</h2>{manage&&<Link to="/heat-rules"><Button>管理热力规则</Button></Link>}{!can?<Alert type="warning" message="需要热力、统计及所选数据集查询权限"/>:<><StatisticsFilters value={draft} onChange={v=>{owner.current++;setData(null);setBusy(false);setDraft(v);}} onApply={()=>void load()} allowed={allowed} loading={busy}/>{error&&<Alert type="error" message={error}/>} {data&&<><Space><Tag>诉求总量 {data.total}</Tag><Tag>未定位 {data.unlocatedCount}</Tag><Tag>网格桶非加和</Tag></Space><p>{data.query.dataset==='ledger'?'诉求总账':'分析库'} · {data.query.projection==='current'?'当前有效值':'入库时数据'} · {data.query.from} 至 {data.query.to} · 规则日期 {data.selectionDate} · {data.days} 天 · 截止 {data.dataCutoffAt}</p>{data.partial&&<Alert type="warning" message="部分统计结果" description="部分记录信息不完整，未计入统计。"/>}<Card title="网格与诉求分布"><HeatGeometry data={data}/></Card><Table rowKey="code" dataSource={data.grids} pagination={{pageSize:20}} columns={[{title:'服务网格',dataIndex:'code'},{title:'实际数量',dataIndex:'count'},{title:'五档等级',render:(_,g)=>g.level?<Tag color={g.level}>{labels[g.level]}</Tag>:g.reason==='CATEGORY_SELECTION_REQUIRED'?'请选择类别':'未配置'},{title:'原因',dataIndex:'reason',render:value=>chineseLabel(value,undefined,'暂不可用')},{title:'政策版本',render:(_,g)=>g.policyId?g.policyId+' / '+g.policyVersion:'—'}]}/></>}</>}</div>;
}
