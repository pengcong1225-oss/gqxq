import {Link} from 'react-router-dom';
import React,{useState,useEffect,useRef} from 'react';
import {Alert,Button,Table,Space,Card,Input,Tag} from 'antd';
import {usePermissionAccess} from '../stores/roleAccess';
import {useAppStore} from '../stores/appStore';
import {listHeatRules,heatCategoryOptions,saveTenderHeatRule,type TenderHeatInput,type HeatDraftRow} from '../api/heatRules';
import type {DictionaryItem} from '../types/masterData';

const colors=[{name:'绿',color:'#389e0d'},{name:'蓝',color:'#1677ff'},{name:'黄',color:'#d4b106'},{name:'橙',color:'#fa8c16'},{name:'红',color:'#cf1322'}];
const blank=():TenderHeatInput=>({category:{majorCode:'',minorCode:null,dictionaryVersion:''},coefficients:['','','','',''],expectedVersion:0});
const coefficientUnits=(value:string)=>/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$/.test(value)?BigInt(value.split('.')[0])*100n+BigInt((value.split('.')[1]??'').padEnd(2,'0')):null;
const decimal=(value:bigint)=>String(value/100n)+(value%100n?'.'+String(value%100n).padStart(2,'0').replace(/0$/,''):'');
const fieldStyle:React.CSSProperties={display:'flex',flexDirection:'column',gap:8,minWidth:180};
const selectStyle:React.CSSProperties={height:34,border:'1px solid #d9d9d9',borderRadius:6,padding:'4px 10px',background:'#fff'};
export default function HeatRuleManager(){
 const can=usePermissionAccess('heatmap.manage').can;
 const userInfo=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token);
 const actorKey=JSON.stringify([token,userInfo?.userId,userInfo?.authorizationVersion,userInfo?.permissions,userInfo?.roles]);
 const actorRef=useRef(actorKey);actorRef.current=actorKey;
 const [rows,setRows]=useState<HeatDraftRow[]>([]),[items,setItems]=useState<DictionaryItem[]>([]),[dictVersion,setDictVersion]=useState('');
 const [draft,setDraft]=useState<TenderHeatInput>(blank),[count,setCount]=useState('450'),[days,setDays]=useState('30');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
 const owner=useRef(0);
 useEffect(()=>{
  const generation=++owner.current;
  setRows([]);setItems([]);setDraft(blank());setSuccess('');setError('');
  if(!can){setBusy(false);return;}
  setBusy(true);
  Promise.all([listHeatRules(),heatCategoryOptions()]).then(([r,c])=>{
   if(generation!==owner.current||actorRef.current!==actorKey)return;setRows(r);setItems(c.items);setDictVersion(c.dictionaryVersion);
  }).catch(e=>{if(generation===owner.current&&actorRef.current===actorKey)setError(e instanceof Error?e.message:'读取失败');}).finally(()=>{if(generation===owner.current&&actorRef.current===actorKey)setBusy(false);});
  return()=>{owner.current++;};
 },[can,actorKey]);
 const selectCategory=(majorCode:string,minorCode:string|null)=>{
  const row=rows.find(r=>r.input.category.majorCode===majorCode&&r.input.category.minorCode===minorCode);
  setDraft(row?{ruleId:row.ruleId,category:{majorCode,minorCode,dictionaryVersion:dictVersion},coefficients:[...row.input.coefficients],expectedVersion:row.editVersion}:{...blank(),category:{majorCode,minorCode,dictionaryVersion:dictVersion}});
  setSuccess('');setError('');
 };
 const units=draft.coefficients.map(coefficientUnits);
 const coefficientsValid=units.every((n,i)=>n!==null&&(i===0||n>units[i-1]!));
 const sampleDays=Number(days),sampleCount=Number(count);
 const sampleValid=days!==''&&count!==''&&Number.isSafeInteger(sampleDays)&&sampleDays>0&&sampleDays<=3660&&Number.isSafeInteger(sampleCount)&&sampleCount>=0;
 const thresholds=coefficientsValid&&sampleValid?units.map(n=>n!*BigInt(sampleDays)):null;
 const level=thresholds?(sampleCount===0?0:Math.max(0,thresholds.findIndex(t=>BigInt(sampleCount)*100n<=t))):null;
 const actualLevel=thresholds&&level!==null?(sampleCount>0&&BigInt(sampleCount)*100n>thresholds[4]?4:level):null;
 const save=async()=>{
  const generation=++owner.current;setBusy(true);setError('');setSuccess('');
  try{
   const value=await saveTenderHeatRule({...draft,category:{...draft.category,dictionaryVersion:dictVersion}});
   if(generation!==owner.current||actorRef.current!==actorKey)return;
   setDraft({ruleId:value.ruleId,category:{...value.input.category},coefficients:[...value.input.coefficients],expectedVersion:value.editVersion});
   setRows(rs=>[value,...rs.filter(r=>r.ruleId!==value.ruleId)]);
   const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
   setSuccess('规则已保存，将用于统计结束日在 '+value.effectiveFrom+' 及之后的查询。'+(value.effectiveFrom>today?'为保留已有历史规则，本次安排于该日期生效。':'今日起生效。'));
  }catch(e){if(generation===owner.current&&actorRef.current===actorKey)setError(e instanceof Error?e.message:'保存失败');}
  finally{if(generation===owner.current&&actorRef.current===actorKey)setBusy(false);}
 };
 const categoryLabel=(row:HeatDraftRow)=>{
  const name=(code:string)=>items.find(i=>i.code===code)?.label??'历史分类';
  return name(row.input.category.majorCode)+(row.input.category.minorCode?' / '+name(row.input.category.minorCode):' / 全部小类');
 };
 if(!can)return <Alert type="warning" message="当前账号未获热力规则管理权限"/>;
 return <div style={{maxWidth:1280}}>
  <h2>热力规则配置</h2>
  <p>配置诉求类别的五档热力系数及生效版本。<Link to="/heatmap">打开后台效果预览</Link></p>
  <Alert type="info" showIcon style={{marginBottom:20}} message="按标书设置五档热力系数" description={<><div>热力值 = 统计天数 × 热力系数。诉求量处于两个热力值之间时，显示较大热力值对应的颜色。等于阈值归较低档，零值为绿色，超过最高阈值为红色。</div><div>小类规则优先，未设置时使用所属大类规则；没有规则时不设等级。统计天数含首尾自然日。<Link to="/dicts">维护诉求分类</Link></div></>}/>
  {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
  {success&&<Alert type="success" showIcon message={success} style={{marginBottom:16}}/>}
  <Card title="设置类别与系数" style={{marginBottom:20}}>
   <fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
    <div style={{display:'flex',gap:24,flexWrap:'wrap',marginBottom:24}}>
     <label style={fieldStyle}>诉求大类<select aria-label="诉求大类" style={selectStyle} value={draft.category.majorCode} onChange={e=>selectCategory(e.target.value,null)}><option value="">请选择诉求大类</option>{items.filter(i=>!i.parentCode).map(i=><option key={i.code} value={i.code}>{i.label}</option>)}</select></label>
     <label style={fieldStyle}>诉求小类<select aria-label="诉求小类" style={selectStyle} disabled={!draft.category.majorCode} value={draft.category.minorCode??''} onChange={e=>selectCategory(draft.category.majorCode,e.target.value||null)}><option value="">全部小类（设置大类规则）</option>{items.filter(i=>i.parentCode===draft.category.majorCode).map(i=><option key={i.code} value={i.code}>{i.label}</option>)}</select></label>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:16}}>
     {colors.map((c,index)=><label key={c.name} style={{borderTop:'4px solid '+c.color,background:'#fafafa',borderRadius:6,padding:14,display:'flex',flexDirection:'column',gap:10}}><span>{c.name}色系数</span><Input aria-label={c.name+'色系数'} inputMode="decimal" placeholder="请输入系数" value={draft.coefficients[index]} onChange={e=>{const values=[...draft.coefficients];values[index]=e.target.value;setDraft({...draft,coefficients:values});setSuccess('');}}/></label>)}
    </div>
    <p style={{color:'#595959',margin:'12px 0 20px'}}>请填写实际业务系数，绿、蓝、黄、橙、红依次递增，最多保留两位小数。标书未规定默认系数。</p>
    <Button type="primary" loading={busy} disabled={!draft.category.majorCode||!coefficientsValid} onClick={()=>void save()}>保存规则</Button>
    <span style={{marginLeft:12,color:'#595959'}}>保存后自动生效；若该类别当天已有发布版本，则安排在下一可用日期生效，并显示实际日期。</span>
   </fieldset>
  </Card>
  <Card title="效果预览" style={{marginBottom:20}}>
   <Space wrap size={20}><label>统计天数 <Input aria-label="预览统计天数" style={{width:110}} inputMode="numeric" value={days} onChange={e=>setDays(e.target.value)}/></label><label>诉求量 <Input aria-label="预览诉求量" style={{width:130}} inputMode="numeric" value={count} onChange={e=>setCount(e.target.value)}/></label>
    {actualLevel!==null&&<Tag color={colors[actualLevel].color} style={{fontSize:16,padding:'4px 12px'}}>{colors[actualLevel].name}色 · {sampleCount} 件</Tag>}
   </Space>
   {thresholds?<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:16,marginTop:20}}>{colors.map((c,i)=><div key={c.name} style={{borderLeft:'4px solid '+c.color,padding:'4px 12px'}}><div>{c.name}色热力值</div><strong>{decimal(thresholds[i])} 件</strong><div style={{color:'#595959',fontSize:12}}>{sampleDays} 天 × {draft.coefficients[i]}</div></div>)}</div>:<p style={{color:'#8c8c8c'}}>填齐递增系数及有效样本后，即可预览颜色。统计天数须为1至3660的整数，诉求量须为非负整数。</p>}
   <p style={{color:'#595959',marginBottom:0}}>标书示例：黄色系数10、橙色系数20，统计30天时，450件显示橙色。预览参数仅用于试算，保存以所填业务系数为准。</p>
  </Card>
  <Card title="已保存的分类规则"><Table<HeatDraftRow> rowKey="ruleId" dataSource={rows} scroll={{x:800}} columns={[
   {title:'适用类别',render:(_,r)=>categoryLabel(r)},
   {title:'绿 / 蓝 / 黄 / 橙 / 红系数',render:(_,r)=><Space>{r.input.coefficients.map((n,i)=><span key={i} style={{color:colors[i].color}}>{n}</span>)}</Space>},
   {title:'计划生效日',render:(_,r)=>r.input.effectiveFrom},
   {title:'计算口径',render:(_,r)=>r.input.policyId==='TENDER_1_1_9_V1'?'标书五档':'历史配置（保存后按标书生成新版本）'},
   {title:'操作',render:(_,r)=><Button disabled={busy} onClick={()=>selectCategory(r.input.category.majorCode,r.input.category.minorCode)}>修改系数</Button>}
  ]} locale={{emptyText:'暂无规则，请选择诉求类别并填写系数'}} pagination={{pageSize:10}}/></Card>
 </div>;
}
