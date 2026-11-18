import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Empty, Modal, Select, Space, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { loadAmapSdk, wgs84ToGcj02 } from '../components/amapSdk';
import type { SupportComplaint, SupportEvent, SupportGrid, TenderDataset } from './types';
import { buildGridComparison, complaintsForCommunity, complaintsForEvent, eventBusiness, eventsInRange, inLocalDateRange, supportTimestamp, type GridComparisonRow } from './layersModel';

const KINDS:SupportEvent['kind'][]=['planned-water','planned-gas','emergency-water','emergency-gas','water-project','gas-project'];
const LABELS:Record<SupportEvent['kind'],string>={'planned-water':'计划停水','planned-gas':'计划停气','emergency-water':'突发停水','emergency-gas':'突发停气','water-project':'供水施工','gas-project':'燃气施工'};
const COLORS:Record<SupportEvent['kind'],string>={'planned-water':'#1677ff','planned-gas':'#d48806','emergency-water':'#722ed1','emergency-gas':'#cf1322','water-project':'#08979c','gas-project':'#d46b08'};
type AmapOverlay={on(event:string,handler:()=>void):void};
type AmapMapLike={setCenter(center:[number,number]):void;setZoom(zoom:number):void;setFitView?(overlays?:unknown[]):void;add(overlays:unknown|unknown[]):void;remove(overlays:unknown[]):void;destroy():void};
type AmapInfoWindowLike={open(map:unknown,position:[number,number]):void;close():void};
type ListSource={kind:'event'|'community'|'grid'|'cell';id:string;type?:string};
const validPoint=(p:number[])=>p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
const readableTime=(s:string)=>Number.isNaN(supportTimestamp(s))?s:new Date(supportTimestamp(s)).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});

export default function SupportLayers({data,from,to,onComplaint}:{data:TenderDataset;from:string;to:string;onComplaint:(r:SupportComplaint)=>void}) {
 const [layers,setLayers]=useState<string[]>(['grids','communities',...KINDS,'water-pipe','gas-pipe']);
 const [business,setBusiness]=useState<'all'|'water'|'gas'>('all');
 const [district,setDistrict]=useState('all');
 const [selectedEventId,setSelectedEventId]=useState<string|null>(null);
 const [selectedCommunityId,setSelectedCommunityId]=useState<string|null>(null);
 const [selectedGridId,setSelectedGridId]=useState<string|null>(null);
 const [compareIds,setCompareIds]=useState<string[]>([]);
 const [listSource,setListSource]=useState<ListSource|null>(null);
 const [mapState,setMapState]=useState<'loading'|'ready'|'error'>('loading');
 const [mapError,setMapError]=useState('');
 const [retry,setRetry]=useState(0);
 const mapElement=useRef<HTMLDivElement>(null);
 const latest=useRef({data,onComplaint});latest.current={data,onComplaint};
 const simulation=data.mode==='simulation';
 const provenance=simulation?'模拟演示数据':'导入的真实数据';
 const title=(name:string)=><Space wrap>{name}<Tag color={simulation?'orange':'green'}>{provenance}</Tag></Space>;
 useEffect(()=>{setSelectedEventId(null);setSelectedCommunityId(null);setSelectedGridId(null);setCompareIds([]);setListSource(null);setDistrict('all');},[data]);
 const grids=useMemo(()=>data.grids.filter(g=>district==='all'||g.districtCode===district),[data,district]);
 const communities=useMemo(()=>data.communities.filter(c=>grids.some(g=>g.id===c.gridId)),[data,grids]);
 const rangedEvents=useMemo(()=>eventsInRange(data.events,from,to),[data,from,to]);
 const events=useMemo(()=>rangedEvents.filter(e=>layers.includes(e.kind)&&(business==='all'||eventBusiness(e)===business)&&e.gridIds.some(id=>grids.some(g=>g.id===id))),[rangedEvents,layers,business,grids]);
 const selectedEvent=events.find(e=>e.id===selectedEventId);
 const selectedCommunity=communities.find(c=>c.id===selectedCommunityId);
 const selectedGrid=data.grids.find(g=>g.id===selectedGridId);
 const complaints=useMemo(()=>data.complaints.filter(r=>inLocalDateRange(r.occurredAt,from,to)&&(business==='all'||r.businessType===business)),[data,from,to,business]);
 const comparisonData=useMemo(()=>({...data,complaints}),[data,complaints]);
 const validCompareIds=compareIds.filter(id=>data.grids.some(g=>g.id===id));
 const comparison=validCompareIds.length>=2?buildGridComparison(comparisonData,validCompareIds,from,to):[];
 const eventRecords=(e:SupportEvent)=>complaintsForEvent(data,e,from,to);
 const communityRecords=(id:string)=>complaintsForCommunity(comparisonData,id,from,to);
 const selectEvent=(id:string)=>{setSelectedEventId(id);setSelectedCommunityId(null);setSelectedGridId(null);};
 const selectCommunity=(id:string)=>{setSelectedCommunityId(id);setSelectedEventId(null);setSelectedGridId(null);};
 const selectGrid=(id:string)=>{setSelectedGridId(id);setSelectedCommunityId(null);setSelectedEventId(null);};
 const enterpriseName=(id:string)=>data.enterprises.find(e=>e.id===id)?.name||id;
 const gridNames=(ids:string[])=>ids.map(id=>data.grids.find(g=>g.id===id)?.name||id).join('、');

 useEffect(()=>{
  let active=true;let map:AmapMapLike|undefined;let infoWindow:AmapInfoWindowLike|undefined;const overlays:unknown[]=[];
  setMapState('loading');setMapError('');
  const key=(import.meta.env.VITE_AMAP_KEY??'').trim();
  if(!key){setMapState('error');setMapError('未配置高德 Key（VITE_AMAP_KEY），地图暂不可用；下方小区、事件和网格清单可继续操作。');return;}
  const highlight=new Set([...(selectedEvent?.gridIds??[]),...(selectedGridId?[selectedGridId]:[]),...validCompareIds]);
  const mappedGrids=data.grids.filter(g=>grids.some(x=>x.id===g.id)||highlight.has(g.id));
  const timeout=setTimeout(()=>{if(active){setMapState('error');setMapError('地图加载超时，可重试或使用下方清单。');}},15000);
  loadAmapSdk().then(rawSdk=>{clearTimeout(timeout);
   if(!active||!mapElement.current)return;
   const AMap=rawSdk as any;
   // 库内坐标为 WGS84，高德地图使用 GCJ-02，绘制前统一转换。
   const toPoint=(lng:number,lat:number):[number,number]=>wgs84ToGcj02(lng,lat);
   const initial=mappedGrids[0];map=new AMap.Map(mapElement.current,{zoom:12,center:toPoint(initial?.longitude??111.286,initial?.latitude??30.692),viewMode:'2D'}) as AmapMapLike;
   const add=(overlay:unknown)=>{map?.add(overlay);overlays.push(overlay);return overlay as AmapOverlay;};
   const popup=(point:[number,number],heading:string,lines:string[],action:()=>void)=>{
    if(!active)return;
    const box=document.createElement('div');box.style.cssText='max-width:300px;line-height:1.7;padding:6px';
    const h=document.createElement('strong');h.textContent=heading;box.append(h);
    [provenance,...lines].forEach(line=>{const p=document.createElement('div');p.textContent=line;box.append(p);});
    const btn=document.createElement('button');btn.type='button';btn.textContent='查看详情及关联诉求';btn.onclick=()=>{if(active)action();};box.append(btn);
    try{infoWindow?.close();}catch{/* SDK may already be disposed */}
    infoWindow=new AMap.InfoWindow({content:box,offset:new AMap.Pixel(0,-16)}) as AmapInfoWindowLike;
    infoWindow.open(map,point);
    action();
   };
   const markerShape=(color:string,shape:'circle'|'square'|'diamond')=>shape==='circle'?`<circle cx="14" cy="14" r="10" fill="${color}" stroke="white" stroke-width="3"/>`:shape==='square'?`<rect x="4" y="4" width="20" height="20" rx="2" fill="${color}" stroke="white" stroke-width="3"/>`:`<path d="M14 1L27 14L14 27L1 14Z" fill="${color}" stroke="white" stroke-width="2"/>`;
   const marker=(lng:number,lat:number,color:string,shape:'circle'|'square'|'diamond',onClick:(point:[number,number])=>void):AmapOverlay|undefined=>{
    if(!validPoint([lng,lat]))return undefined;
    const position=toPoint(lng,lat);
    const content='<div style="width:28px;height:28px;line-height:0"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28">'+markerShape(color,shape)+'</svg></div>';
    const handle=add(new AMap.Marker({position,anchor:'center',content,zIndex:120}));
    handle.on('click',()=>{if(active)onClick(position);});
    return handle;
   };
   const focusedOverlays:unknown[]=[];
   mappedGrids.forEach(g=>{
    const highlighted=highlight.has(g.id);
    if((layers.includes('grids')||highlighted)&&g.ring.length>=3&&g.ring.every(validPoint)){
     const poly=add(new AMap.Polygon({path:g.ring.map(p=>toPoint(p[0],p[1])),strokeColor:highlighted?'#eb2f96':'#64748b',strokeWeight:highlighted?4:1,fillColor:highlighted?'#ffadd2':'#dbeafe',fillOpacity:highlighted?0.32:0.1}));
     poly.on('click',()=>{if(active)selectGrid(g.id);});
    }
    if(layers.includes('grids')||highlighted){
     const handle=marker(g.longitude,g.latitude,highlighted?'#eb2f96':'#64748b','square',point=>popup(point,g.name,[g.districtName,highlighted?'已高亮：选中事件影响范围 / 对比网格':'网格中心点'],()=>selectGrid(g.id)));
     if(highlighted&&handle)focusedOverlays.push(handle);
    }
   });
   if(layers.includes('communities'))communities.forEach(c=>marker(c.longitude,c.latitude,'#389e0d','circle',point=>popup(point,c.name,[`所属网格：${gridNames([c.gridId])}`,`覆盖用户：${c.households} 户`,`当前范围关联诉求：${communityRecords(c.id).length} 件`],()=>selectCommunity(c.id))));
   events.forEach(e=>e.gridIds.forEach(gridId=>{
    const g=data.grids.find(r=>r.id===gridId);if(!g)return;
    marker(g.longitude,g.latitude,COLORS[e.kind],'diamond',point=>popup(point,e.title,[LABELS[e.kind],`${readableTime(e.startsAt)} 至 ${readableTime(e.endsAt)}`,`全部影响网格：${gridNames(e.gridIds)}`,`同业务、同网格、事件时间内诉求：${eventRecords(e).length} 件`],()=>selectEvent(e.id)));
   }));
   (data.pipelines??[]).filter(p=>layers.includes(p.businessType+'-pipe')&&(business==='all'||p.businessType===business)&&p.gridIds.some(id=>mappedGrids.some(g=>g.id===id))).forEach(p=>{
    if(p.path.length<2||!p.path.every(validPoint))return;
    const poly=add(new AMap.Polyline({path:p.path.map(x=>toPoint(x[0],x[1])),strokeColor:p.businessType==='water'?'#1677ff':'#d48806',strokeWeight:5,strokeOpacity:0.8,strokeStyle:simulation?'dashed':'solid'}));
    poly.on('click',()=>{if(active)popup(toPoint(p.path[0][0],p.path[0][1]),p.name,[provenance,`企业：${enterpriseName(p.enterpriseId)}`,`网格：${gridNames(p.gridIds)}`],()=>selectGrid(p.gridIds[0]));});
   });
   if(focusedOverlays.length)map.setFitView?.(focusedOverlays);
   if(active)setMapState('ready');
  }).catch((error:unknown)=>{if(active){setMapState('error');setMapError(error instanceof Error?error.message:'高德地图加载失败');}});
  return ()=>{active=false;clearTimeout(timeout);try{infoWindow?.close();}catch{/* SDK may already be disposed */}try{map?.remove(overlays);}catch{/* overlays may already be disposed */}try{map?.destroy();}catch{/* detached map */}if(mapElement.current)mapElement.current.replaceChildren();};
 },[data,from,to,layers,business,district,selectedEventId,selectedGridId,compareIds,retry]);

 const listRows=useMemo(()=>{
  if(!listSource)return [];
  if(listSource.kind==='event'){const event=data.events.find(e=>e.id===listSource.id);return event?complaintsForEvent(data,event,from,to):[];}
  if(listSource.kind==='community')return complaintsForCommunity(comparisonData,listSource.id,from,to);
  return complaints.filter(r=>r.gridId===listSource.id&&(listSource.kind!=='cell'||r.type===listSource.type));
 },[listSource,data,comparisonData,complaints,from,to]);
 const complaintColumns=[{title:'编号',dataIndex:'id',width:155},{title:'诉求',dataIndex:'title',render:(s:string,r:SupportComplaint)=><Button type="link" style={{whiteSpace:'normal',textAlign:'left',height:'auto'}} onClick={()=>{const current=latest.current.data.complaints.find(x=>x.id===r.id);if(current)latest.current.onComplaint(current);}}>{s}</Button>},{title:'业务',dataIndex:'businessType',render:(b:string)=>b==='water'?'供水':'燃气',width:70},{title:'类型',dataIndex:'type',width:100},{title:'网格',dataIndex:'gridId',render:(id:string)=>gridNames([id])},{title:'发生时间',dataIndex:'occurredAt',render:readableTime,width:170}];
 const eventColumns=[{title:'事件',dataIndex:'title',render:(s:string,e:SupportEvent)=><Button type="link" style={{whiteSpace:'normal',height:'auto',textAlign:'left'}} onClick={()=>selectEvent(e.id)}>{s}</Button>},{title:'图层',dataIndex:'kind',render:(k:SupportEvent['kind'])=><Tag color={COLORS[k]}>{LABELS[k]}</Tag>},{title:'时间',key:'time',render:(_:unknown,e:SupportEvent)=><>{readableTime(e.startsAt)}<br/>{readableTime(e.endsAt)}</>},{title:'影响网格',dataIndex:'gridIds',render:gridNames},{title:'关联诉求',key:'count',render:(_:unknown,e:SupportEvent)=><Button type="link" onClick={()=>setListSource({kind:'event',id:e.id})}>{eventRecords(e).length} 件</Button>}];
 const eventDetails=selectedEvent&&<Card size="small" title={title('事件详情 / 全部影响网格已高亮')} style={{marginTop:12}}><Descriptions size="small" column={{xs:1,md:2}} bordered items={[
  {key:'name',label:'事件',children:selectedEvent.title},{key:'kind',label:'业务 / 类型',children:LABELS[selectedEvent.kind]},
  {key:'enterprise',label:'企业',children:enterpriseName(selectedEvent.enterpriseId)},{key:'time',label:'起止时间',children:`${readableTime(selectedEvent.startsAt)} — ${readableTime(selectedEvent.endsAt)}`},
  {key:'households',label:'影响用户',children:`${selectedEvent.households} 户`},{key:'workers',label:'施工 / 抢修人员',children:`${selectedEvent.workers} 人`},
  {key:'reason',label:'原因',children:selectedEvent.reason},{key:'area',label:'影响区域',children:selectedEvent.area},
  {key:'plan',label:'应急保障方案',children:selectedEvent.plan},{key:'housing',label:'影响住宅 / 小区',children:selectedEvent.housing},
  {key:'grid',label:'全部影响网格',children:gridNames(selectedEvent.gridIds)},{key:'count',label:'关联诉求',children:<Button type="link" onClick={()=>setListSource({kind:'event',id:selectedEvent.id})}>{eventRecords(selectedEvent).length} 件 · 查看精确清单</Button>},
 ]}/><Typography.Paragraph type="secondary" style={{marginTop:8,marginBottom:0}}>关联口径：影响网格内、相同供水/燃气业务、发生于事件起止时间内，并与当前日期范围取交集。空间和时间关联不代表因果认定。</Typography.Paragraph></Card>;
 const comparisonColumns=[{title:'诉求类型',dataIndex:'type',key:'type'},...validCompareIds.map(id=>({title:gridNames([id]),key:id,render:(_:unknown,row:GridComparisonRow)=>{const cell=row.cells.find(c=>c.gridId===id)!;return <Button type="link" style={cell.isMaximum?{background:'#fff1f0',color:'#cf1322',fontWeight:700}:undefined} onClick={()=>setListSource({kind:'cell',id,type:row.type})}>{cell.records.length} 件 {cell.isMaximum?'● 最高':''}</Button>;}}))];

 return <Space direction="vertical" size={16} style={{width:'100%'}}>
  <Alert type={simulation?'warning':'info'} showIcon message={`${provenance} · ${data.sourceLabel}`} description={`${simulation?'所有小区、网格、事件、管线和统计仅供功能演示，不代表实际业务。':'展示导入数据；缺少管线几何时仅展示项目影响网格。'} 当前统一统计日期：${from} 至 ${to}（本地日期，包含结束日）。`}/>
  <Card size="small" title={title('高德地图 · 小区、停供、施工与管线')}>
   <Space wrap style={{marginBottom:12}}><span>行政区</span><Select aria-label="GIS行政区" value={district} onChange={value=>{setDistrict(value);setSelectedEventId(null);setSelectedCommunityId(null);}} style={{minWidth:150}} options={[{label:'全部行政区',value:'all'},...Array.from(new Map(data.grids.map(g=>[g.districtCode,{label:g.districtName,value:g.districtCode}])).values())]}/><span>业务</span><Select aria-label="GIS业务" value={business} onChange={setBusiness} style={{width:130}} options={[{value:'all',label:'供水及燃气'},{value:'water',label:'供水'},{value:'gas',label:'燃气'}]}/></Space>
   <Checkbox.Group value={layers} onChange={values=>setLayers(values.map(String))} options={[{label:'网格面 / 中心点',value:'grids'},{label:'小区',value:'communities'},...KINDS.map(k=>({label:LABELS[k],value:k})),{label:'供水管线',value:'water-pipe'},{label:'燃气管线',value:'gas-pipe'}]} style={{display:'flex',flexWrap:'wrap',gap:10,marginBottom:12}}/>
   <div style={{height:420,position:'relative',background:'#f0f5fa',border:'1px solid #d9e2ec',borderRadius:6,overflow:'hidden'}}>
    <div ref={mapElement} aria-label="高德地图业务图层" style={{height:'100%',width:'100%'}}/>
    {mapState==='loading'&&<div style={{position:'absolute',inset:0,display:'grid',placeItems:'center',background:'#ffffffba'}}><Spin tip="正在加载高德地图"><div style={{height:40,width:120}}/></Spin></div>}
    {mapState==='error'&&<div style={{position:'absolute',inset:0,display:'grid',placeItems:'center',padding:24}}><Alert type="info" showIcon message="地图暂不可用" description={<>{mapError}<br/>所有关联查询及对比可在下方清单完成。<br/><Button onClick={()=>setRetry(r=>r+1)}>重试地图</Button></>}/></div>}
   </div>
   <Space wrap style={{marginTop:12}}><Tag color="green">● 小区</Tag><Tag>■ 网格中心 / 边界</Tag><Tag color="magenta">■ 选中影响网格 / 对比网格</Tag>{KINDS.map(k=><Tag key={k} color={COLORS[k]}>◆ {LABELS[k]}</Tag>)}<Tag color="blue">━ 供水管线</Tag><Tag color="gold">━ 燃气管线</Tag></Space>
   <Typography.Paragraph type="secondary" style={{marginTop:8,marginBottom:0}}>事件标记位于各影响网格的中心，仅表达网格覆盖关系；同一事件跨网格显示多个标记，清单仍按一个事件计数。{simulation?'模拟管线以虚线表示。':'管线仅使用已导入坐标，不推测路径。'} 点击事件后高亮其全部影响网格。</Typography.Paragraph>
   {!(data.pipelines?.length)&&<Alert style={{marginTop:10}} type="info" message={simulation?'当前模拟数据未提供管线坐标；施工事件仍可按影响网格查看。':'当前真实数据未导入管线几何；供水、燃气施工以事件和影响网格展示。'}/>}
   {eventDetails}
   {selectedCommunity&&<Card size="small" style={{marginTop:12}} title={title('小区详情')}><Descriptions size="small" items={[{key:'name',label:'小区',children:selectedCommunity.name},{key:'grid',label:'网格',children:gridNames([selectedCommunity.gridId])},{key:'households',label:'覆盖用户',children:`${selectedCommunity.households} 户`},{key:'coordinate',label:'坐标',children:`${selectedCommunity.longitude}, ${selectedCommunity.latitude}`},{key:'count',label:'关联诉求',children:<Button type="link" onClick={()=>setListSource({kind:'community',id:selectedCommunity.id})}>{communityRecords(selectedCommunity.id).length} 件 · 查看清单</Button>}]}/><Typography.Text type="secondary">按小区唯一标识、当前日期及业务精确筛选。</Typography.Text></Card>}
   {selectedGrid&&<Card size="small" style={{marginTop:12}} title={title(`${selectedGrid.name} · 网格详情与事件历史`)}><Space wrap><Typography.Text>{selectedGrid.districtName}</Typography.Text><Button onClick={()=>setListSource({kind:'grid',id:selectedGrid.id})}>当前范围诉求 {complaints.filter(r=>r.gridId===selectedGrid.id).length} 件</Button></Space><Typography.Paragraph type="secondary">历史事件按当前日期重叠及业务筛选，包含未勾选的事件图层。</Typography.Paragraph><Table rowKey="id" size="small" dataSource={rangedEvents.filter(e=>e.gridIds.includes(selectedGrid.id)&&(business==='all'||eventBusiness(e)===business))} columns={eventColumns} pagination={{pageSize:5}} scroll={{x:850}}/></Card>}
  </Card>
  <Card size="small" title={title('小区、事件与网格清单 · 地图不可用时可继续查询')}><Tabs items={[
   {key:'events',label:`停供 / 施工事件（${events.length}）`,children:<><Typography.Paragraph type="secondary">仅包含已勾选图层、业务、行政区与日期范围有交集的事件。</Typography.Paragraph><Table rowKey="id" size="small" dataSource={events} columns={eventColumns} pagination={{pageSize:8}} scroll={{x:900}}/></>},
   {key:'communities',label:`小区（${communities.length}）`,children:<Table rowKey="id" size="small" dataSource={communities} columns={[{title:'小区',dataIndex:'name',render:(s:string,c:{id:string})=><Button type="link" onClick={()=>selectCommunity(c.id)}>{s}</Button>},{title:'所属网格',dataIndex:'gridId',render:(id:string)=>gridNames([id])},{title:'覆盖用户（户）',dataIndex:'households'},{title:'当前范围关联诉求',key:'count',render:(_:unknown,c:{id:string})=><Button type="link" onClick={()=>{selectCommunity(c.id);setListSource({kind:'community',id:c.id});}}>{communityRecords(c.id).length} 件</Button>}]} pagination={{pageSize:8}} scroll={{x:600}}/>},
   {key:'grids',label:`网格（${grids.length}）`,children:<Table rowKey="id" size="small" dataSource={grids} columns={[{title:'网格',dataIndex:'name',render:(s:string,g:SupportGrid)=><Button type="link" onClick={()=>selectGrid(g.id)}>{s}</Button>},{title:'行政区',dataIndex:'districtName'},{title:'停供 / 施工历史',key:'history',render:(_:unknown,g:SupportGrid)=><Button type="link" onClick={()=>selectGrid(g.id)}>{rangedEvents.filter(e=>e.gridIds.includes(g.id)&&(business==='all'||eventBusiness(e)===business)).length} 个事件</Button>},{title:'当前范围诉求',key:'complaints',render:(_:unknown,g:SupportGrid)=><Button type="link" onClick={()=>setListSource({kind:'grid',id:g.id})}>{complaints.filter(r=>r.gridId===g.id).length} 件</Button>}]} pagination={{pageSize:8}}/>},
  ]}/></Card>
  <Card size="small" title={title('网格诉求类型对比 · 同期 2—3 个实际网格')}>
   <Space direction="vertical" style={{width:'100%'}}><Select mode="multiple" aria-label="对比网格" placeholder="选择 2—3 个网格" value={validCompareIds} style={{width:'100%'}} onChange={ids=>{if(ids.length<=3)setCompareIds(ids);}} options={data.grids.map(g=>({label:`${g.districtName} · ${g.name}`,value:g.id,disabled:validCompareIds.length>=3&&!validCompareIds.includes(g.id)}))}/><Typography.Text type="secondary">统计范围：{from} 至 {to}，{business==='all'?'供水及燃气':business==='water'?'供水':'燃气'}；按所选网格分别统计同一类型，红色高亮所有并列最高值，点击数量查看精确清单。对比网格同步在地图高亮。</Typography.Text>{validCompareIds.length<2?<Empty description="至少选择 2 个网格后查看对比"/>:<Table rowKey="type" size="small" columns={comparisonColumns} dataSource={comparison} pagination={false} locale={{emptyText:'当前日期和业务范围内没有诉求'}} scroll={{x:500}}/>}</Space>
  </Card>
  <Modal width={1100} title={title(`关联诉求清单 · ${listRows.length} 件`)} open={!!listSource} onCancel={()=>setListSource(null)} footer={<Button onClick={()=>setListSource(null)}>关闭</Button>} destroyOnClose><Typography.Paragraph type="secondary">{from} 至 {to}；{listSource?.kind==='event'?'事件影响网格 + 相同业务 + 事件起止时间，与所选日期取交集':listSource?.kind==='community'?'精确小区标识 + 所选日期和业务':listSource?.kind==='cell'?`网格 ${gridNames([listSource.id])} + 类型 ${listSource.type} + 所选日期和业务`:'精确网格标识 + 所选日期和业务'}。点击诉求标题查看详情。</Typography.Paragraph><Table rowKey="id" columns={complaintColumns} dataSource={listRows} size="small" pagination={{pageSize:10,showSizeChanger:true}} scroll={{x:1000}}/></Modal>
 </Space>;
}
