import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Collapse,Input,Select,Space,Typography} from 'antd';
import {useAppStore} from '../stores/appStore';
import {getComplaint} from '../api/complaints';
import type {ComplaintDetail,CorrectionItem} from '../types/api';
import type {LocationCorrectionOptions,LocationCorrectionResult} from '../types/locationCorrection';
import {confirmLocationGroup,deferLocationGroup,getLocationCorrectionOptions,listComplaintCorrections} from '../api/corrections';
import {locationDraftInput,type LocationDraft} from './LocationCorrectionFields';
import TiandituLocationPicker from './TiandituLocationPicker';
import {adoptLocation,safePlaceQuery,suggestLocations,resolveAddressLocation} from '../utils/locationSuggestions';
export interface LocationReviewPanelProps {detail:ComplaintDetail;items:CorrectionItem[];disabled?:boolean;singleRecord?:boolean;onSaved:(result:LocationCorrectionResult,next:boolean)=>void;onDeferred:(next:boolean)=>void}
const fields=new Set(['address','location_lng','location_lat','district_name','district_code','admin_grid_code','community_code']);
function initial(d:ComplaintDetail):LocationDraft{return {address:d.effectiveAddress??d.correctedAddress??d.address??'',districtCode:d.districtCode,adminGridCode:d.adminGridCode,communityCode:d.communityCode,lng:d.locationLng==null?'':String(d.locationLng),lat:d.locationLat==null?'':String(d.locationLat),coordinateSystem:d.locationCoordinateSystem??'unknown',coordinateSource:d.locationCoordinateSource??''};}
function Review({detail:incoming,items:incomingItems,disabled,singleRecord,onSaved,onDeferred}:LocationReviewPanelProps){
 const [refreshed,setRefreshed]=useState<{detail:ComplaintDetail;items:CorrectionItem[]}|null>(null);
 const detail=refreshed&&refreshed.detail.editVersion>=incoming.editVersion?refreshed.detail:incoming,items=refreshed&&refreshed.detail===detail?refreshed.items:incomingItems;
 const [draft,setDraft]=useState<LocationDraft>(()=>initial(detail)),[options,setOptions]=useState<LocationCorrectionOptions|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState(false),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[deferring,setDeferring]=useState(false),[reason,setReason]=useState(''),[note,setNote]=useState(''),[stale,setStale]=useState(false);
 const alive=useRef(true),lock=useRef(false),changed=useRef(false),version=useRef(detail.editVersion);
 const latestVersion=useRef(detail.editVersion);latestVersion.current=detail.editVersion;
 const pending=items.some(i=>fields.has(i.fieldName)&&i.status==='pending');
 const suggestions=options?suggestLocations(detail,options):null;
 const addressResolution=options?resolveAddressLocation(draft.address??'',options):null;
 useEffect(()=>{alive.current=true;void getLocationCorrectionOptions(detail.complaintId).then(o=>{if(!alive.current)return;setOptions(o);const s=suggestLocations(detail,o);const manual=!!detail.correctedAddress||items.some(i=>fields.has(i.fieldName)&&i.status==='confirmed');setDraft(current=>{
 if(!changed.current&&s.unique&&!manual)return adoptLocation(current,s.unique);
 if(current.address&&!current.districtCode&&!current.adminGridCode&&!current.communityCode){
  const resolved=resolveAddressLocation(current.address,o);return {...current,...resolved.location};
 }
 return current;
 });}).catch(e=>{if(alive.current)setError(e.message||'地点选项加载失败');});return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  if(!pending){version.current=detail.editVersion;setStale(false);setError('');return;}
  if(detail.editVersion!==version.current){setStale(true);setError('记录版本已变化，草稿已保留，请核对最新原文后确认使用新版本');}
 },[detail.editVersion,pending]);
 const change=(patch:Partial<LocationDraft>,location=false)=>{changed.current=true;setDirty(true);setDraft(d=>({...d,...(location?{lng:'',lat:'',coordinateSystem:'unknown' as const,coordinateSource:''}:{}),...patch}));};
 const blocked=disabled||busy||!pending||stale;
 async function submit(next:boolean,defer=false){
  if(lock.current||blocked)return;
  const startedVersion=version.current;
  const basis=defer?[reason,note.trim()].filter(Boolean).join('：'):draft.basis?.trim()||(!dirty&&!suggestions?.conflict&&(suggestions?.candidates.length??0)<=1?'人工核对原文并确认系统建议':'');
  if(!basis){setError(defer?'请选择暂缓原因':'调整或存在冲突时，请填写核对依据');return;}
  if(!defer&&!draft.address?.trim()&&!draft.communityCode){setError('请先选择或填写核实后的地点，也可暂缓处理');return;}
  lock.current=true;setBusy(true);setError('');
  try{if(defer){await deferLocationGroup({complaintId:detail.complaintId,expectedVersion:version.current,basis});if(alive.current&&latestVersion.current===startedVersion)onDeferred(next);}else{const result=await confirmLocationGroup(locationDraftInput(detail.complaintId,version.current,{...draft,basis}));if(alive.current&&latestVersion.current===startedVersion)onSaved(result,next);}}
  catch(e){if(alive.current){const ex=e as {status?:number;message?:string};setError(ex.status===409?'该诉求已被其它窗口修改；草稿已保留，请刷新详情核对版本后重试':ex.message||'保存失败，草稿已保留');if(ex.status===409)setStale(true);}}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function refresh(){if(lock.current)return;lock.current=true;setBusy(true);try{const [fresh,freshItems]=await Promise.all([getComplaint(detail.complaintId),listComplaintCorrections(detail.complaintId)]);if(alive.current){setRefreshed({detail:fresh,items:freshItems});setError('最新原文已加载，草稿已保留，请核对后继续');}}catch(e){if(alive.current)setError((e as Error).message||'刷新失败');}finally{lock.current=false;if(alive.current)setBusy(false);}}
 function useMapAddress(address:string,name=address){
  const resolved=options?resolveAddressLocation(address,options,name):null;
  change(resolved?.location??{address,communityCode:null,adminGridCode:null,districtCode:null});
 }
 function editAddress(address:string){
  const resolved=options?resolveAddressLocation(address,options):null;
  change(resolved?.location??{address,districtCode:null,adminGridCode:null,communityCode:null},true);
 }
 const query=!dirty&&suggestions?.unique?safePlaceQuery((options?.districts.find(d=>d.code===suggestions.unique?.districtCode)?.name??'')+suggestions.unique.address):null;
 return <Card title={singleRecord?"完善地址":"位置核验"} size="small">
  <Typography.Paragraph><strong>原始内容：</strong>{detail.title}　{detail.content||'未提供正文'}</Typography.Paragraph>
  <Typography.Paragraph><strong>原始地址：</strong>{detail.sourceAddress||'来源未提供地址'}</Typography.Paragraph>
  <Typography.Paragraph>当前位置：{detail.effectiveAddress??detail.correctedAddress??detail.address??'待核实'}（{detail.districtName??'区县待核实'}）</Typography.Paragraph>
  <Typography.Paragraph>系统建议：{suggestions?.unique?.address??(suggestions?.candidates.length?'有多个候选，请人工选择':addressResolution?.location.districtCode?'已从地址识别归属，请核对下方结果':'暂未找到可信地点')}</Typography.Paragraph>
  {suggestions?.conflict&&<Alert type="warning" message="原文区划或候选存在冲突，请核对并填写依据"/>}
  {error&&<Alert type="warning" message={error} style={{marginBottom:12}}/>}
  {stale&&<Button disabled={busy} onClick={()=>void refresh()}>刷新核对（保留草稿）</Button>}
  {stale&&detail.editVersion!==version.current&&<Button onClick={()=>{version.current=detail.editVersion;setStale(false);setDirty(true);setError('');}}>已核对最新原文，保留草稿继续</Button>}
  {!pending&&<Alert type="success" message="本条位置待办已处理"/>}
  <Typography.Paragraph>区县：{options?.districts.find(d=>d.code===draft.districtCode)?.name??'待核实'}；网格：{options?.adminGrids.find(g=>g.code===draft.adminGridCode)?.name??'待核实'}；小区：{options?.communities.find(c=>c.code===draft.communityCode)?.name??'待核实'}</Typography.Paragraph>
  <Typography.Paragraph>待确认地点：{draft.address||'待选择'}；坐标{draft.lng&&draft.lat?'已提供，仍按来源状态核验':'未知'}</Typography.Paragraph>
   {draft.address&&addressResolution&&<Alert type="info" showIcon message={addressResolution.message} description={addressResolution.township?'乡镇／街道线索：'+addressResolution.township+'（从地址提取）':undefined} />}
  {suggestions&&suggestions.candidates.length>1&&<Space wrap className="location-suggestion-list">{suggestions.candidates.map((c,i)=><Button key={i} disabled={blocked} onClick={()=>change(adoptLocation(draft,c))}>{c.address} · {options?.districts.find(d=>d.code===c.districtCode)?.name??'区县未知'} · {options?.adminGrids.find(g=>g.code===c.adminGridCode)?.name??'网格未知'}</Button>)}</Space>}
  <Space wrap style={{marginBottom:12}}>{!singleRecord&&<Button type="primary" disabled={blocked||!options} loading={busy} onClick={()=>void submit(true)}>确认位置并下一条</Button>}<Button disabled={blocked||!options} onClick={()=>void submit(false)}>确认位置</Button><Button disabled={blocked} onClick={()=>setEditing(v=>!v)}>调整位置</Button><Button disabled={blocked} onClick={()=>setDeferring(v=>!v)}>暂无法确认</Button></Space>
  {deferring&&<Space direction="vertical" style={{display:'flex'}}><Select aria-label="暂缓原因" placeholder="请选择暂缓原因" style={{width:260}} value={reason||undefined} disabled={blocked} onChange={setReason} options={['原文信息不足','多个地点无法区分','区划或地址冲突','需联系核实'].map(value=>({value,label:value}))}/><Input.TextArea aria-label="暂缓补充说明" placeholder="可补充说明" maxLength={400} value={note} onChange={e=>setNote(e.target.value)}/><Button disabled={blocked} onClick={()=>void submit(!singleRecord,true)}>{singleRecord?"记录暂缓":"记录暂缓并下一条"}</Button></Space>}
  {(editing||dirty||suggestions?.conflict||(suggestions?.candidates.length??0)>1)&&<Space direction="vertical" style={{display:'flex'}}>
   <Typography.Text strong>核实后的地址</Typography.Text>
   <Input aria-label="核实后的地址" value={draft.address} maxLength={500} disabled={blocked} onChange={e=>editAddress(e.target.value)}/>
   <Typography.Text strong>村社区／小区</Typography.Text>
   <Select showSearch optionFilterProp="label" aria-label="核验小区" placeholder="地址自动匹配；未识别时可搜索补选" allowClear style={{width:'100%'}} disabled={blocked} value={draft.communityCode} options={options?.communities.map(c=>({value:c.code,label:c.name+' · '+(options?.adminGrids.find(g=>g.code===c.adminGridCode)?.name??'')}))} onChange={code=>{const c=options?.communities.find(c=>c.code===code),g=options?.adminGrids.find(g=>g.code===c?.adminGridCode);change({communityCode:c?.code??null,adminGridCode:g?.code??null,districtCode:g?.districtCode??null,address:c?.name??draft.address},true);}}/>
   <Typography.Text strong>区县</Typography.Text>
   <Select aria-label="核验区县" placeholder="请选择区县" allowClear style={{width:'100%'}} disabled={blocked} value={draft.districtCode} options={options?.districts.map(d=>({value:d.code,label:d.name}))} onChange={districtCode=>change({districtCode:districtCode??null,adminGridCode:null,communityCode:null},true)}/>
   <Typography.Text strong>行政网格</Typography.Text>
   <Select showSearch optionFilterProp="label" aria-label="核验网格" placeholder="请选择行政网格" allowClear style={{width:'100%'}} disabled={blocked} value={draft.adminGridCode} options={options?.adminGrids.filter(g=>g.districtCode===draft.districtCode).map(g=>({value:g.code,label:g.name}))} onChange={adminGridCode=>change({adminGridCode:adminGridCode??null,communityCode:null},true)}/>
   <Typography.Text strong>核对依据</Typography.Text>
   <Input.TextArea aria-label="位置核对依据" value={draft.basis} maxLength={500} placeholder="调整或冲突时填写核对依据" disabled={blocked} onChange={e=>change({basis:e.target.value})}/>
  </Space>}
  {(editing||suggestions?.unique)&&<TiandituLocationPicker contextKey={JSON.stringify([draft.districtCode,draft.adminGridCode,draft.communityCode])} address={safePlaceQuery(draft.address??'')??''} lng={draft.lng} lat={draft.lat} autoSearch={query} disabled={!!blocked} onPick={p=>change({lng:p.lng,lat:p.lat,coordinateSystem:'unknown',coordinateSource:p.coordinateSource,communityCode:null,adminGridCode:null})} onSelectPlace={place=>useMapAddress(place.address,place.name)} onUseAddressSuggestion={useMapAddress}/>}
  <Collapse style={{marginTop:12}} items={[{key:'coordinates',label:'高级坐标细节（可选）',children:<><Typography.Text type="secondary">坐标系：{draft.coordinateSystem==='WGS84'?'已有来源声明':'未知，不自动用于空间归属判定'}</Typography.Text><Space><Input aria-label="高级经度" value={draft.lng} disabled={blocked} onChange={e=>change({lng:e.target.value,coordinateSystem:'unknown',coordinateSource:'人工填写，坐标系未核实'})}/><Input aria-label="高级纬度" value={draft.lat} disabled={blocked} onChange={e=>change({lat:e.target.value,coordinateSystem:'unknown',coordinateSource:'人工填写，坐标系未核实'})}/></Space></>}]} />
 </Card>;
}
export default function LocationReviewPanel(props:LocationReviewPanelProps){const token=useAppStore(s=>s.token),user=useAppStore(s=>s.userInfo);const actor=JSON.stringify([token,user?.userId,user?.permissions,user?.roles,user?.authorizationVersion,user?.mustChangePassword]);return <Review key={actor+':'+props.detail.complaintId} {...props}/>;}
