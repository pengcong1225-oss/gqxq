import React,{useState,useEffect,useRef} from 'react';
import {Alert,Button,Table,Space,Card} from 'antd';
import {usePermissionAccess} from '../stores/roleAccess';
import {listHeatRules,heatCategoryOptions,saveHeatRule,previewHeatRule,publishHeatRule,type HeatDraft,type HeatDraftRow,type HeatPolicy} from '../api/heatRules';
import type {DictionaryItem} from '../types/masterData';
const blank=():HeatDraft=>({ruleId:'',category:{majorCode:'',minorCode:null,dictionaryVersion:''},coefficients:['','','','',''],policyId:'',policyVersion:1,policy:{},effectiveFrom:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),expectedVersion:0});
const policyFields:{key:keyof HeatPolicy;label:string;values:string[]}[]=[{key:'anchor',label:'系数锚点',values:['lower','upper']},{key:'endpointOwner',label:'端点归属',values:['lower','upper']},{key:'zero',label:'零值处理',values:['green','null']},{key:'belowFirst',label:'首档以下',values:['green','null']},{key:'top',label:'最高界以上',values:['red','null']},{key:'day',label:'计日候选',values:['shanghai_inclusive']},{key:'classFallback',label:'类目回退',values:['exact_only','minor_then_major']},{key:'noRule',label:'无规则行为',values:['null']},{key:'ruleSelection',label:'选规则日期候选',values:['query_end']}];
export default function HeatRuleManager(){
 const can=usePermissionAccess('heatmap.manage').can;const [rows,setRows]=useState<HeatDraftRow[]>([]);const [items,setItems]=useState<DictionaryItem[]>([]);const [dictVersion,setDictVersion]=useState('');const [draft,setDraft]=useState<HeatDraft>(blank);const [savedInput,setSavedInput]=useState('');const [preview,setPreview]=useState('');const [count,setCount]=useState('');const [days,setDays]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const owner=useRef(0);
 const refresh=async()=>{const generation=++owner.current;setError('');setBusy(true);try{const [r,c]=await Promise.all([listHeatRules(),heatCategoryOptions()]);if(generation!==owner.current)return;setRows(r);setItems(c.items);setDictVersion(c.dictionaryVersion);}catch(e){if(generation===owner.current){setRows([]);setItems([]);setError(e instanceof Error?e.message:'读取失败');}}finally{if(generation===owner.current)setBusy(false);}};
 useEffect(()=>{if(can)void refresh();else{owner.current++;setRows([]);setItems([]);setDraft(blank());setPreview('');setBusy(false);}return()=>{owner.current++;};},[can]);
 const action=async(kind:'save'|'preview'|'publish',row?:HeatDraftRow)=>{
  const generation=++owner.current;
  setBusy(true);setError('');setPreview('');
  try{
   if(kind==='save'){
    const value=await saveHeatRule({...draft,category:{...draft.category,dictionaryVersion:dictVersion}});
    if(generation!==owner.current)return;
    setDraft({...value.input,expectedVersion:value.editVersion});
    setSavedInput(JSON.stringify({...value.input,expectedVersion:0}));
    setRows(rs=>[value,...rs.filter(r=>r.ruleId!==value.ruleId)]);
   }
   if(kind==='preview'){
    const value=await previewHeatRule(draft.ruleId,Number(count),Number(days),draft.expectedVersion);
    if(generation!==owner.current)return;
    setPreview('候选预览（未经 Q7 正式批准）：'+(value.level??value.reason??'不可用')+' · '+value.ruleVersion);
   }
   if(kind==='publish'&&row){
    await publishHeatRule(row.ruleId,row.editVersion);
    if(generation!==owner.current)return;
    await refresh();
   }
  }catch(e){
   if(generation===owner.current)setError(e instanceof Error?e.message:'操作失败');
  }finally{
   if(generation===owner.current)setBusy(false);
  }
 };
 if(!can)return <Alert type="warning" message="当前账号未获热力规则管理权限"/>;
 return <div><h2>五档热力规则</h2><Alert type="info" message="候选政策与草稿，Q7 尚未正式批准" description="所有政策行为须显式选择；upper 必须选择首界以下 green，lower 必须选择最高界以上 red，冲突组合不可预览或发布。这是候选约束，不是 Q7 业务确认。上海含首尾日候选同日计1日；query_end 使用窗口结束业务日的同一规则，跨规则期间不逐事件加权。政策版本内容不可改写；没有服务端精确确认记录不能正式发布。"/>{error&&<Alert type="error" message={error}/>}<Button disabled={busy} onClick={()=>{setDraft(blank());setPreview('');}}>新建草稿</Button><Card title={'草稿版本 '+draft.expectedVersion}><fieldset disabled={busy}><Space wrap>
 {([['ruleId','规则编码'],['policyId','政策编码'],['effectiveFrom','生效开始日']] as const).map(([key,label])=><label key={key}>{label}<input aria-label={label} type={key==='effectiveFrom'?'date':'text'} disabled={key==='ruleId'&&draft.expectedVersion>0} value={draft[key]} onChange={e=>{setDraft({...draft,[key]:e.target.value});setPreview('');}}/></label>)}
 <label>政策版本<input aria-label="政策版本" type="number" min={1} value={draft.policyVersion} onChange={e=>{setDraft({...draft,policyVersion:Number(e.target.value)});setPreview('');}}/></label>
 <label>正式大类<select aria-label="规则正式大类" disabled={draft.expectedVersion>0} value={draft.category.majorCode} onChange={e=>setDraft({...draft,category:{majorCode:e.target.value,minorCode:null,dictionaryVersion:dictVersion}})}><option value="">请选择已发布大类</option>{items.filter(i=>!i.parentCode).map(i=><option key={i.code} value={i.code}>{i.label} ({i.code})</option>)}</select></label>
 <label>正式小类<select aria-label="规则正式小类" disabled={draft.expectedVersion>0} value={draft.category.minorCode??''} onChange={e=>setDraft({...draft,category:{...draft.category,minorCode:e.target.value||null,dictionaryVersion:dictVersion}})}><option value="">大类整体规则</option>{items.filter(i=>i.parentCode===draft.category.majorCode).map(i=><option key={i.code} value={i.code}>{i.label} ({i.code})</option>)}</select></label>
 {['绿','蓝','黄','橙','红'].map((label,index)=><label key={label}>{label}系数<input aria-label={label+'系数'} inputMode="decimal" value={draft.coefficients[index]} onChange={e=>{const coefficients=[...draft.coefficients];coefficients[index]=e.target.value;setDraft({...draft,coefficients});setPreview('');}}/></label>)}
 {policyFields.map(f=><label key={f.key}>{f.label}<select aria-label={f.label} value={draft.policy[f.key]??''} onChange={e=>{const policy={...draft.policy};if(e.target.value)Object.assign(policy,{[f.key]:e.target.value});else delete policy[f.key];setDraft({...draft,policy});setPreview('');}}><option value="">未选择（预览不可用）</option>{f.values.map(v=><option key={v} value={v}>{v}</option>)}</select></label>)}
 <Button onClick={()=>void action('save')}>保存草稿</Button><label>样本数量<input aria-label="样本数量" type="number" min={0} value={count} onChange={e=>{setCount(e.target.value);setPreview('');}}/></label><label>样本天数<input aria-label="样本天数" type="number" min={1} max={3660} value={days} onChange={e=>{setDays(e.target.value);setPreview('');}}/></label><Button disabled={!draft.expectedVersion||JSON.stringify({...draft,expectedVersion:0})!==savedInput||count===''||days===''} onClick={()=>void action('preview')}>候选样本预览</Button></Space></fieldset>{preview&&<Alert type="info" message={preview}/>}<p>字典版本 {dictVersion||'不可用'}；系数为非负十进制字符串，最多两位小数，绿蓝黄橙红严格递增。修改后须先保存再预览。发布内容与开始日不可变，后续版本须追加更晚开始日。</p></Card><Table rowKey="ruleId" dataSource={rows} columns={[{title:'规则',dataIndex:'ruleId'},{title:'版本',dataIndex:'editVersion'},{title:'政策确认',render:(_,r)=>r.approvalStatus==='confirmed'?'服务端存在精确确认':'Q7 待确认，不可发布'},{title:'操作',render:(_,r)=><Space><Button disabled={busy} onClick={()=>{setDraft({...r.input,expectedVersion:r.editVersion});setSavedInput(JSON.stringify({...r.input,expectedVersion:0}));setPreview('');}}>编辑草稿</Button><Button disabled={busy||r.approvalStatus!=='confirmed'} onClick={()=>void action('publish',r)}>发布规则</Button></Space>}]} pagination={{pageSize:20}}/></div>;
}
