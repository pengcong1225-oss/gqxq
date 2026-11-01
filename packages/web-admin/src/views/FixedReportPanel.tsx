import {chineseLabel,systemMessage} from '../utils/chineseDisplay';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Checkbox,Select,Space,Table,Tag} from 'antd';
import StatisticsFilters,{initialStatisticsDraft,getStatisticsDraftError,type StatisticsDraft} from '../components/StatisticsFilters';
import {createReport,listReports,retryReport,downloadReport,getReport} from '../api/reports';
import {useAppStore} from '../stores/appStore';
import {useWriteAccess} from '../stores/roleAccess';
import type {StatisticsDataset,StatisticsQuery} from '../types/statistics';
import type {ReportArtifact} from '../types/report';
const stateNames={pending:'等待生成',generating:'生成中',succeeded:'已生成',failed:'生成失败'};
const errorText=(value:unknown)=>value instanceof Error?value.message:'报告操作失败，请重试';
export default function FixedReportPanel({todoIds,onTodosCompleted}:{todoIds:string[];onTodosCompleted?:(ids:string[])=>void}){
 const user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token),generate=useWriteAccess('report.generate'),retry=useWriteAccess('report.retry');
 const authKey=JSON.stringify([token,user?.userId,user?.authorizationVersion,user?.roles,user?.permissions,user?.mustChangePassword]);
 const codes=user&&!user.mustChangePassword?user.permissions:[];
 const allowed:StatisticsDataset[]=['dashboard.read','analysis.read'].flatMap((c,i)=>codes.includes(c)?[i?'analysis' as const:'ledger' as const]:[]);
 const canRead=['report.read','statistics.read','complaint.read'].every(c=>codes.includes(c))&&allowed.length>0;
 const [draft,setDraft]=useState<StatisticsDraft>(()=>initialStatisticsDraft(allowed[0]??'ledger'));
 const [rows,setRows]=useState<ReportArtifact[]>([]),[cursors,setCursors]=useState<(string|undefined)[]>([undefined]),[page,setPage]=useState(0),[next,setNext]=useState<string|null>(null);
 const [format,setFormat]=useState<'docx'|'xlsx'>('docx'),[heat,setHeat]=useState(false),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const epoch=useRef(0),seq=useRef(0),submission=useRef<{payload:string;requestId:string}|null>(null);
 const currentAuth=useRef(authKey);currentAuth.current=authKey;
 const knownStates=useRef(new Map<string,ReportArtifact['state']>());
 const tracked=useRef(new Map<string,string[]>()),completedCallback=useRef(onTodosCompleted);completedCallback.current=onTodosCompleted;
 const [trackingVersion,setTrackingVersion]=useState(0);
 const observe=useCallback((reports:ReportArtifact[])=>{
  for(const report of reports){const ids=tracked.current.get(report.reportId),previous=knownStates.current.get(report.reportId);knownStates.current.set(report.reportId,report.state);if(report.state==='succeeded'&&(ids||(previous&&previous!=='succeeded'))){tracked.current.delete(report.reportId);completedCallback.current?.(ids??[]);}}
 },[]);
 const load=useCallback(async(cursor?:string)=>{
  const n=++seq.current,e=epoch.current;setLoading(true);setError(null);
  try{const result=await listReports(cursor);if(currentAuth.current!==authKey||e!==epoch.current||n!==seq.current)return;setRows(result.content);setNext(result.hasMore?result.continuation:null);observe(result.content);}
  catch(x){if(currentAuth.current===authKey&&e===epoch.current&&n===seq.current){setRows([]);setNext(null);setError(errorText(x));}}
  finally{if(currentAuth.current===authKey&&e===epoch.current&&n===seq.current)setLoading(false);}
 },[authKey,observe]);
 useEffect(()=>{epoch.current++;seq.current++;tracked.current.clear();knownStates.current.clear();setRows([]);setNext(null);setCursors([undefined]);setPage(0);setHeat(false);setBusy(false);setError(null);submission.current=null;setDraft(initialStatisticsDraft(allowed[0]??'ledger'));if(canRead)void load();return()=>{epoch.current++;seq.current++;};},[authKey,canRead,load]);
 useEffect(()=>{
  if(!canRead||(!tracked.current.size&&!rows.some(r=>r.state==='pending'||r.state==='generating')))return;
  let active=true,polling=false;const e=epoch.current;
  const timer=setInterval(()=>{if(polling)return;polling=true;void (async()=>{
   try{const reports=await Promise.all([...tracked.current.keys()].map(id=>getReport(id)));if(!active||e!==epoch.current||currentAuth.current!==authKey)return;observe(reports);await load(cursors[page]);}
   catch(x){if(active&&e===epoch.current&&currentAuth.current===authKey)setError(errorText(x));}
   finally{polling=false;}
  })();},15000);
  return()=>{active=false;clearInterval(timer);};
 },[canRead,rows,load,cursors,page,authKey,observe,trackingVersion]);
 const action=async(fn:()=>Promise<void>)=>{if(busy)return;const e=epoch.current;setBusy(true);setError(null);try{await fn();}catch(x){if(e===epoch.current&&currentAuth.current===authKey)setError(errorText(x));}finally{if(e===epoch.current&&currentAuth.current===authKey)setBusy(false);}};
 const validation=getStatisticsDraftError(draft,allowed)||(todoIds.length&&draft.dataset!=='analysis'?'已选择分析待办，请将统计数据集切换为分析库并选择统计方式。':'');
 const generateDraft=()=>action(async()=>{
  if(!generate.can||validation)throw Error(validation||'当前账号无生成权限');
  const e=epoch.current,payload={templateCode:'procurement-statistics' as const,templateVersion:'v1' as const,query:{...draft,projection:draft.projection} as StatisticsQuery,format,includeHeat:heat&&codes.includes('heatmap.read'),todoIds:[...todoIds]};
  const key=JSON.stringify(payload);if(submission.current?.payload!==key)submission.current={payload:key,requestId:crypto.randomUUID()};
  const report=await createReport({...payload,requestId:submission.current.requestId});if(e!==epoch.current||currentAuth.current!==authKey)return;
  submission.current=null;if(payload.todoIds.length){tracked.current.set(report.reportId,payload.todoIds);setTrackingVersion(v=>v+1);observe([report]);}
  setCursors([undefined]);setPage(0);await load();
 });
 const download=(r:ReportArtifact)=>action(async()=>{const e=epoch.current,blob=await downloadReport(r.reportId,r.format);if(e!==epoch.current||currentAuth.current!==authKey)return;const url=URL.createObjectURL(blob),a=document.createElement('a');try{a.href=url;a.download=r.reportId+'.'+r.format;document.body.appendChild(a);a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}});
 return <Card title="诉求统计分析报告" style={{marginBottom:24}}>
  {!canRead?<Alert type="info" message="当前账号无报告查询权限，请联系管理员。"/>:<>
   {generate.can&&<><StatisticsFilters value={draft} onChange={setDraft} onApply={()=>{}} allowed={allowed} loading={busy} hideApply/>
    <Alert type="info" showIcon style={{marginBottom:16}} message="报告按统计筛选范围生成" description={'所选待办用于关联报告，不会将报告缩小为仅包含这些记录。'+(todoIds.length?'已选择 '+todoIds.length+' 条待办；请选择分析库，所选待办必须属于当前日期及其他筛选范围。':'可在下方选择需要关联的分析待办。')}/>
    {validation&&<Alert type="warning" showIcon message={validation} style={{marginBottom:16}}/>}
    <Space wrap style={{marginBottom:16}}><Select aria-label="报告格式" value={format} onChange={setFormat} options={[{value:'docx',label:'Word 文档（DOCX）'},{value:'xlsx',label:'Excel 表格（XLSX）'}]}/>{codes.includes('heatmap.read')&&<Checkbox checked={heat} onChange={e=>setHeat(e.target.checked)}>包含热力数据</Checkbox>}<Button type="primary" loading={busy} disabled={Boolean(validation)} onClick={()=>void generateDraft()}>生成固定模板报告</Button></Space></>}
   <Space wrap style={{marginBottom:16}}><Button onClick={()=>void load(cursors[page])} loading={loading}>刷新报告</Button><Button disabled={page===0||loading} onClick={()=>{setPage(page-1);void load(cursors[page-1]);}}>上一页</Button><span>第 {page+1} 页</span><Button disabled={!next||loading} onClick={()=>{if(next){setCursors([...cursors.slice(0,page+1),next]);setPage(page+1);void load(next);}}}>下一页</Button></Space>
   {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
   <Table<ReportArtifact> rowKey="reportId" dataSource={rows} loading={loading} pagination={false} scroll={{x:1170}} columns={[
    {width:220,title:'报告编号',dataIndex:'reportId'},{width:150,title:'格式',dataIndex:'format',render:v=>v==='docx'?'Word 文档':'Excel 表格'},{width:140,title:'状态',render:(_,r)=><Tag>{stateNames[r.state]??chineseLabel(r.state)}</Tag>},{width:190,title:'数据截止时间',dataIndex:'dataCutoffAt',render:v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—'},{width:260,title:'失败原因',dataIndex:'failureReason',render:v=>v?systemMessage(v,'报告生成失败，请重试'):'—'},
    {width:210,title:'操作',render:(_,r)=><Space wrap>{r.state==='succeeded'&&codes.includes('report.download')&&<Button disabled={busy} onClick={()=>void download(r)}>下载</Button>}{r.state==='failed'&&retry.can&&generate.can&&<Button disabled={busy} onClick={()=>void action(async()=>{const e=epoch.current;await retryReport(r.reportId);if(e===epoch.current&&currentAuth.current===authKey)await load(cursors[page]);})}>重新生成</Button>}</Space>}
   ]}/>
  </>}
 </Card>;
}
