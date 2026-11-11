import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Space,Typography} from 'antd';
import {loadSdk} from './TiandituLocationPicker';
import type {AdministrativeHeatData} from '../api/administrativeHeat';
export const heatColors={green:'#52c41a',blue:'#1677ff',yellow:'#fadb14',orange:'#fa8c16',red:'#f5222d'};
type Grid=AdministrativeHeatData['grids'][number];
export default function AdministrativeHeatMap({data,showPoints,onGrid}:{data:AdministrativeHeatData;showPoints:boolean;onGrid:(g:Grid)=>void}){
 const host=useRef<HTMLDivElement>(null),callback=useRef(onGrid);callback.current=onGrid;
 const [error,setError]=useState(''),[hover,setHover]=useState<Grid|null>(null),[reload,setReload]=useState(0),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;let map:any;let timer:ReturnType<typeof setTimeout>;setError('');setHover(null);setLoading(true);
 const key=import.meta.env.VITE_TIANDITU_TK?.trim();
 if(!key){setError('地图底图尚未配置。可在下方网格列表查看数量和明细。');setLoading(false);return;}
 timer=setTimeout(()=>{if(active){setError('地图加载超时，请重试；下方网格统计和明细仍可查看。');setLoading(false);}},15000);
 void loadSdk(key).then(raw=>{if(!active||!host.current)return;const T=raw as any;
  map=new T.Map(host.current);map.centerAndZoom(new T.LngLat(111.29,30.7),11);map.enableScrollWheelZoom?.();
  const bounds:any[]=[];
  for(const g of data.grids)for(const c of g.coverages){if(c.coordinateSystem!=='WGS84')continue;for(const f of c.geometry?.features??[]){
   const polys=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;
   for(const rings of polys){const points=rings[0].map(([lng,lat])=>new T.LngLat(lng,lat));bounds.push(...points);
    // SDK supports polygon rings; holes remain excluded from membership counts server-side.
    const shape=new T.Polygon(rings.length===1?points:rings.map(r=>r.map(([lng,lat])=>new T.LngLat(lng,lat))),{color:g.level?heatColors[g.level]:'#8c8c8c',weight:2,opacity:1,fillColor:g.level?heatColors[g.level]:'#bfbfbf',fillOpacity:g.level?.45:.18});
    map.addOverLay(shape);shape.addEventListener('mouseover',()=>{if(active)setHover(g);});shape.addEventListener('click',()=>callback.current(g));
   }
  }}
  if(showPoints)for(const p of data.points){const point=new T.LngLat(p.longitude,p.latitude);bounds.push(point);const circle=new T.Circle(point,35,{color:p.needsCorrection?'#8c8c8c':'#262626',weight:1,fillColor:p.needsCorrection?'#8c8c8c':'#262626',fillOpacity:.5});map.addOverLay(circle);}
  if(bounds.length)map.setViewport?.(bounds);
  clearTimeout(timer);setLoading(false);
 }).catch(()=>{if(active){setError('地图底图加载失败，请重试；可使用下方网格列表查看统计和明细。');setLoading(false);clearTimeout(timer);}});
 return()=>{active=false;clearTimeout(timer);map?.clearOverLays?.();map?.destroy?.();if(host.current)host.current.innerHTML='';};
 },[data,showPoints,reload]);
 return <div style={{position:'relative'}}>{error&&<Alert type="warning" message={error} action={<Button onClick={()=>setReload(n=>n+1)}>重试地图</Button>}/>}<div ref={host} aria-label="行政网格五色热力地图" style={{height:480,width:'100%',background:'#f3f6f8'}}/>
 <div style={{position:'absolute',left:12,top:error?65:12,zIndex:450,background:'white',padding:'10px 14px',borderRadius:6,maxWidth:380,boxShadow:'0 2px 8px #0002'}}>{hover?<><strong>{hover.name}</strong><div>社区 / 小区：{hover.communities.join('、')||'未登记'}</div><div>当前类别诉求 {hover.count} 件</div><Button size="small" onClick={()=>onGrid(hover)}>查看网格诉求</Button></>:<Typography.Text>{loading?'正在加载地图…':'将鼠标移到网格查看名称和数量，点击查看诉求明细。'}</Typography.Text>}</div>
 </div>;
}
