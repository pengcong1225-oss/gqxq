import {chineseLabel} from '../utils/chineseDisplay';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Space,Typography} from 'antd';
import {getFollowups,createFollowup,reviseFollowup,concludeFollowup} from '../api/followups';
import {usePermissionAccess,useWriteAccess} from '../stores/roleAccess';
import {useAppStore} from '../stores/appStore';
import type {ComplaintFollowupsView,FollowupView,FollowupFacts} from '../types/api';
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const localDate=(value:string)=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const label=(r:FollowupView)=>!r.contacted?'未接通':r.evaluationCode==='satisfied'?'满意':r.evaluationCode==='dissatisfied'?'不满意':'接通，未取得评价';
type Editor={key:string;epoch:number;mode:'create'|'revise'|'conclude';target:FollowupView|null};
const inputStyle:React.CSSProperties={display:'block',width:'100%',padding:8,border:'1px solid #d9d9d9',borderRadius:6,marginTop:4};
/** Each complaint/auth generation fences both reads and writes, including same-scope revocation. */
const ComplaintFollowups:React.FC<{complaintId:string}>=({complaintId})=>{
 const user=useAppStore(s=>s.userInfo);const read=usePermissionAccess('complaint.read');const create=useWriteAccess('followup.create');const conclude=useWriteAccess('followup.conclude');
 const contextKey=JSON.stringify([complaintId,user?.userId,user?.authorizationVersion,user?.accountType,user?.roles,user?.permissions]);
 const keyRef=useRef(contextKey);const serial=useRef(0);const epoch=useRef(0);if(keyRef.current!==contextKey){keyRef.current=contextKey;serial.current++;epoch.current++;}
 const [loaded,setLoaded]=useState<{key:string;epoch:number;value:ComplaintFollowupsView}|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);
 const [editor,setEditor]=useState<Editor|null>(null);const [submitting,setSubmitting]=useState(false);const [contacted,setContacted]=useState(false);const [occurredAt,setOccurredAt]=useState('');const [evaluation,setEvaluation]=useState<FollowupFacts['evaluationCode']>(null);const [dissatisfactionReason,setDissatisfactionReason]=useState('');const [notes,setNotes]=useState('');const [reason,setReason]=useState('');const [conclusion,setConclusion]=useState('');
 const retry=useRef<{fingerprint:string;requestId:string}|null>(null);
 const load=useCallback(async(expectedEpoch=epoch.current)=>{if(expectedEpoch!==epoch.current||contextKey!==keyRef.current)return;const request=++serial.current;const ownsRead=()=>request===serial.current&&expectedEpoch===epoch.current&&contextKey===keyRef.current;setError(null);if(!read.can){setLoaded(null);setLoading(false);return;}setLoading(true);try{const value=await getFollowups(complaintId);if(ownsRead())setLoaded({key:contextKey,epoch:expectedEpoch,value});}catch(e){if(ownsRead()){setLoaded(null);setError(e instanceof Error?e.message:'回访读取失败');}}finally{if(ownsRead())setLoading(false);}},[complaintId,contextKey,read.can]);
 useEffect(()=>{setLoaded(null);setEditor(null);setNotice(null);setSubmitting(false);retry.current=null;void load();return()=>{serial.current++;epoch.current++;};},[load]);
 const data=loaded?.key===contextKey&&loaded.epoch===epoch.current?loaded.value:null;const active=editor?.key===contextKey&&editor.epoch===epoch.current?editor:null;
 const supervisor=conclude.can&&user?.accountType==='internal';
 const open=(mode:Editor['mode'],target:FollowupView|null)=>{setEditor({key:contextKey,epoch:epoch.current,mode,target});setContacted(target?.contacted??false);setOccurredAt(localDate(target?.occurredAt??new Date().toISOString()));setEvaluation(target?.evaluationCode??null);setDissatisfactionReason(target?.dissatisfactionReason??'');setNotes(target?.notes??'');setReason('');setConclusion(target?.conclusion??'');retry.current=null;setNotice(null);};
 const submit=async(event:React.FormEvent)=>{
  event.preventDefault();if(!active||submitting)return;const capturedKey=contextKey;const capturedEpoch=epoch.current;const ownsWrite=()=>capturedKey===keyRef.current&&capturedEpoch===epoch.current;setNotice(null);
  if(active.mode==='conclude'?!supervisor:!create.can)return;
  if(active.mode!=='conclude'&&(!occurredAt||!Number.isFinite(new Date(occurredAt).getTime()))){setNotice('回访时间必填且须有效');return;}
  if(active.mode!=='conclude'&&evaluation==='dissatisfied'&&!dissatisfactionReason.trim()){setNotice('不满意理由必填');return;}
  if(active.mode!=='create'&&!reason.trim()){setNotice('理由必填');return;}
  if(active.mode==='conclude'&&!conclusion.trim()){setNotice('主管结论必填');return;}
  const facts:FollowupFacts={contacted,occurredAt:active.mode==='conclude'?active.target!.occurredAt:new Date(occurredAt).toISOString(),evaluationCode:contacted?evaluation:null,dissatisfactionReason:contacted&&evaluation==='dissatisfied'?dissatisfactionReason.trim():null,notes:notes.trim()||null};
  const body=active.mode==='conclude'?{expectedVersion:active.target!.version,conclusion:conclusion.trim(),reason:reason.trim()}:active.mode==='revise'?{...facts,expectedVersion:active.target!.version,reason:reason.trim()}:facts;
  const fingerprint=JSON.stringify([contextKey,capturedEpoch,active.mode,active.target?.followupId,body]);if(retry.current?.fingerprint!==fingerprint)retry.current={fingerprint,requestId:crypto.randomUUID()};const requestId=retry.current.requestId;setSubmitting(true);
  try{if(active.mode==='create')await createFollowup(complaintId,{...facts,requestId});else if(active.mode==='revise')await reviseFollowup(active.target!.followupId,{...facts,expectedVersion:active.target!.version,reason:reason.trim(),requestId});else await concludeFollowup(active.target!.followupId,{expectedVersion:active.target!.version,conclusion:conclusion.trim(),reason:reason.trim(),requestId});if(!ownsWrite())return;setEditor(null);retry.current=null;setNotice('回访记录已保存');await load(capturedEpoch);}
  catch(e){if(!ownsWrite())return;setNotice(e instanceof Error?e.message:'回访保存失败');if((e as {status?:number}).status===409){setNotice('版本或请求内容冲突，请核对刷新后的记录，重新打开操作。');await load(capturedEpoch);}}
  finally{if(ownsWrite())setSubmitting(false);}
 };
 if(!read.can)return null;
 return <Card title="人工回访" style={{marginTop:16}} extra={<Button disabled={submitting} loading={loading} onClick={()=>void load()}>刷新回访</Button>}>
  <Typography.Text type="secondary">诉求：{complaintId}。回访事实、主管结论与来源评价分别保存。</Typography.Text>
  {error&&<Alert role="alert" type="error" message={error} style={{marginTop:8}}/>}{notice&&<Alert role="status" type="info" message={notice} style={{marginTop:8}}/>}
  {data&&<><p>来源坐席评价：{data.sourceEvaluation.label??data.sourceEvaluation.reason}（{chineseLabel(data.sourceEvaluation.provenance,undefined,'来源坐席记录')}）</p><Alert type="info" message={data.formalEvaluation.reason.replace(/^Q\d+\s*/,'')}/>
   {create.can&&<Button disabled={submitting} style={{marginTop:12}} onClick={()=>open('create',null)}>登记回访</Button>}
   {!data.records.length&&<p>暂无人工回访记录</p>}
   {data.records.map(r=><div key={r.followupId} style={{borderBottom:'1px solid #eee',padding:'12px 0'}}><p>{date(r.occurredAt)} · {label(r)} · 登记人 {r.ownerId} · 版本 {r.version}</p>{r.dissatisfactionReason&&<p>不满意理由：{r.dissatisfactionReason}</p>}{r.notes&&<p>备注：{r.notes}</p>}<p>主管结论：{r.conclusion??'尚无主管结论'}{r.concludedBy&&'（'+r.concludedBy+'）'}</p><Space>{create.can&&r.ownerId===user?.userId&&<Button disabled={submitting} onClick={()=>open('revise',r)}>更正回访</Button>}{supervisor&&<Button disabled={submitting} onClick={()=>open('conclude',r)}>填写主管结论</Button>}</Space></div>)}
   <details style={{marginTop:12}}><summary>查看版本历史（{data.history.length} 条）</summary>{data.history.map(r=><p key={r.followupId+':'+r.version}>{r.followupId} · 版本 {r.version} · {label(r)} · {r.operatorName} · {date(r.revisedAt)}{' · 回访时间：'+date(r.occurredAt)}{r.dissatisfactionReason&&' · 不满意理由：'+r.dissatisfactionReason}{r.reason&&' · 理由：'+r.reason}{r.notes&&' · 备注：'+r.notes}{r.conclusion&&' · 主管结论：'+r.conclusion}</p>)}</details>
  </>}
  {active&&<form onSubmit={event=>void submit(event)} style={{marginTop:16,display:'grid',gap:12,maxWidth:620}}>
   {active.mode!=='conclude'?<><label>是否接通<select aria-label="是否接通" style={inputStyle} disabled={submitting} value={String(contacted)} onChange={e=>{const v=e.target.value==='true';setContacted(v);if(!v){setEvaluation(null);setDissatisfactionReason('');}}}><option value="false">未接通</option><option value="true">已接通</option></select></label>
    <label>回访时间<input aria-label="回访时间" type="datetime-local" value={occurredAt} disabled={submitting} onChange={e=>setOccurredAt(e.target.value)} style={inputStyle}/></label>
    <label>回访评价<select aria-label="回访评价" style={inputStyle} disabled={submitting||!contacted} value={evaluation??''} onChange={e=>{setEvaluation(e.target.value as FollowupFacts['evaluationCode']||null);if(e.target.value!=='dissatisfied')setDissatisfactionReason('');}}><option value="">未取得评价</option><option value="satisfied">满意</option><option value="dissatisfied">不满意</option></select></label>
    {evaluation==='dissatisfied'&&contacted&&<label>不满意理由<textarea aria-label="不满意理由" style={inputStyle} maxLength={500} disabled={submitting} value={dissatisfactionReason} onChange={e=>setDissatisfactionReason(e.target.value)}/></label>}
    <label>回访备注<textarea aria-label="回访备注" style={inputStyle} maxLength={2000} disabled={submitting} value={notes} onChange={e=>setNotes(e.target.value)}/></label></>:<label>主管结论<textarea aria-label="主管结论" style={inputStyle} maxLength={1000} disabled={submitting} value={conclusion} onChange={e=>setConclusion(e.target.value)}/></label>}
   {active.mode!=='create'&&<label>{active.mode==='conclude'?'结论理由':'更正理由'}<textarea aria-label={active.mode==='conclude'?'结论理由':'更正理由'} style={inputStyle} maxLength={500} disabled={submitting} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   <Space><Button htmlType="submit" type="primary" loading={submitting}>{active.mode==='conclude'?'保存主管结论':active.mode==='revise'?'保存更正':'保存回访'}</Button><Button disabled={submitting} onClick={()=>setEditor(null)}>取消</Button></Space>
  </form>}
 </Card>;
};
export default ComplaintFollowups;
