import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Space,Typography} from 'antd';
import {loadAmapSdk,ringToGcj02,wgs84ToGcj02} from './amapSdk';
import type {AdministrativeHeatData} from '../api/administrativeHeat';
export const heatColors={green:'#52c41a',blue:'#1677ff',yellow:'#fadb14',orange:'#fa8c16',red:'#f5222d'};
type Grid=AdministrativeHeatData['grids'][number];

/**
 * 行政网格五色热力地图（高德 JS API）。
 *
 * 数据是 WGS84（后端契约），高德地图使用 GCJ-02，因此绘制前统一 wgs84ToGcj02；
 * 天地图已下线，不再有"未配天地图 Key"的降级文案，改为"未配置高德 Key"。
 * 交互：悬停显示网格名/数量/覆盖率，点击回调 onGrid；点位按 needsCorrection 区分。
 */
export default function AdministrativeHeatMap({data,showPoints,onGrid}:{data:AdministrativeHeatData;showPoints:boolean;onGrid:(g:Grid)=>void}){
 const host=useRef<HTMLDivElement>(null),callback=useRef(onGrid);callback.current=onGrid;
 const [error,setError]=useState(''),[hover,setHover]=useState<Grid|null>(null),[reload,setReload]=useState(0),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;let map:any;let timer:ReturnType<typeof setTimeout>;setError('');setHover(null);setLoading(true);
 timer=setTimeout(()=>{if(active){setError('高德地图加载超时，请重试；下方网格统计和明细仍可查看。');setLoading(false);}},15000);
 void loadAmapSdk().then(rawSdk=>{if(!active||!host.current)return;const AMap:any=rawSdk as any;
  map=new AMap.Map(host.current,{zoom:11,center:wgs84ToGcj02(111.29,30.7),viewMode:'2D'});
  const overlays:any[]=[];
  for(const g of data.grids)for(const c of g.coverages){if(c.coordinateSystem!=='WGS84')continue;for(const f of c.geometry?.features??[]){
   const polys:any=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;
   for(const rings of polys){
    // 环 0 为外环，其余为洞：高德 Polygon 用 path 数组表达多环（洞按顺时针约定，后端已保证）
    const path=rings.map((ring:number[][])=>ringToGcj02(ring));
    const shape=new AMap.Polygon({path:path.length===1?path[0]:path,strokeColor:g.level?heatColors[g.level]:'#8c8c8c',strokeWeight:2,fillColor:g.level?heatColors[g.level]:'#8c8c8c',fillOpacity:0.35});
    overlays.push(shape);
    shape.on('mouseover',()=>{if(active)setHover(g);});
    shape.on('click',()=>callback.current(g));
   }
  }}
  if(showPoints)for(const p of data.points){
   const circle=new AMap.Circle({center:wgs84ToGcj02(p.longitude,p.latitude),radius:35,strokeColor:p.needsCorrection?'#8c8c8c':'#262626',strokeWeight:1,fillColor:p.needsCorrection?'#8c8c8c':'#262626',fillOpacity:0.6});
   overlays.push(circle);
  }
  if(overlays.length){map.add(overlays);map.setFitView(overlays);}
  clearTimeout(timer);setLoading(false);
 }).catch((e:unknown)=>{if(active){setError('高德地图加载失败（'+(e instanceof Error?e.message:'未知原因')+'），请重试；可使用下方网格列表查看统计和明细。');setLoading(false);clearTimeout(timer);}});
 return()=>{active=false;clearTimeout(timer);try{map?.clearMap?.();map?.destroy?.();}catch{}if(host.current)host.current.innerHTML='';};
 },[data,showPoints,reload]);
 return <div style={{position:'relative'}}>
  {error&&<Alert type="warning" message={error} action={<Button onClick={()=>setReload(n=>n+1)}>重试地图</Button>}/>}
  <div ref={host} aria-label="行政网格五色热力地图（高德）" style={{width:'100%',height:420,border:'1px solid #f0f0f0',borderRadius:8,overflow:'hidden'}}/>
  {loading&&!error&&<div style={{position:'absolute',inset:0,display:'grid',placeItems:'center',color:'#8c8c8c'}}>高德地图加载中…</div>}
  <div style={{position:'absolute',left:12,top:error?65:12,zIndex:450,background:'white',padding:'10px 14px',borderRadius:6,maxWidth:380,boxShadow:'0 2px 8px #0002'}}>
   {hover?<><strong>{hover.name}</strong><br/><Space direction="vertical" size={0}><span>诉求 {hover.count} 件 · 等级 {hover.level ?? '未分级'}</span><span>规则版本 {hover.ruleVersion ?? '未发布'}</span>{hover.reason&&<Typography.Text type="secondary">{hover.reason}</Typography.Text>}</Space></>:<Typography.Text type="secondary">悬停网格查看名称、诉求量与覆盖率；点击可查看明细</Typography.Text>}
  </div>
 </div>;
}
