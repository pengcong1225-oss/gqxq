import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Checkbox,Select,Space,Table,Tag} from 'antd';
import StatisticsFilters,{initialStatisticsDraft,type StatisticsDraft} from '../components/StatisticsFilters';
import {createReport,listReports,retryReport,downloadReport} from '../api/reports';
import {useAppStore} from '../stores/appStore';
import {useWriteAccess} from '../stores/roleAccess';
import type {StatisticsDataset,StatisticsQuery} from '../types/statistics';
import type {ReportArtifact} from '../types/report';
const stateNames={pending:'等待生成',generating:'生成中',succeeded:'产物成功',failed:'生成失败'};
export default function FixedReportPanel({todoIds}:{todoIds:string[]}){
 const user=useAppStore(s=>s.userInfo),generate=useWriteAccess('report.generate'),retry=useWriteAccess('report.retry');
 const authKey=JSON.stringify([user?.userId,user?.authorizationVersion,user?.roles,user?.permissions,user?.mustChangePassword]);
 const codes=user&&!user.mustChangePassword?user.permissions:[];
 const allowed:StatisticsDataset[]=['dashboard.read','analysis.read'].flatMap((c,i)=>codes.includes(c)?[i?'analysis' as const:'ledger' as const]:[]);
 const canRead=['report.read','statistics.read','complaint.read'].every(c=>codes.includes(c))&&allowed.length>0;
 const [draft,setDraft]=useState<StatisticsDraft>(()=>initialStatisticsDraft(allowed[0]??'ledger'));
 const [rows,setRows]=useState<ReportArtifact[]>([]),[continuation,setContinuation]=useState<string|null>(null),[next,setNext]=useState<string|null>(null);
 const [format,setFormat]=useState<'docx'|'xlsx'>('docx'),[heat,setHeat]=useState(false),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const epoch=useRef(0),seq=useRef(0),submission=useRef<{payload:string;requestId:string}|null>(null);
 const load=useCallback(async(cursor?:string)=>{const n=++seq.current,e=epoch.current;setLoading(true);setError(null);try{const page=await listReports(cursor);if(e!==epoch.current||n!==seq.current)return;setRows(page.content);setNext(page.hasMore?page.continuation:null);}catch(e){if(n===seq.current){setRows([]);setNext(null);setError(e instanceof Error?e.message:String(e));}}finally{if(n===seq.current)setLoading(false);}},[authKey]);
 useEffect(()=>{epoch.current++;seq.current++;setRows([]);setNext(null);setContinuation(null);setHeat(false);setBusy(false);setError(null);submission.current=null;setDraft(initialStatisticsDraft(allowed[0]??'ledger'));if(canRead)void load();return()=>{epoch.current++;seq.current++;};},[authKey,canRead,load]);
 useEffect(()=>{if(!canRead||!rows.some(r=>r.state==='pending'||r.state==='generating'))return;const timer=setInterval(()=>void load(continuation??undefined),15000);return()=>clearInterval(timer);},[canRead,rows,load,continuation]);
 const action=async(fn:()=>Promise<void>)=>{const e=epoch.current;setBusy(true);setError(null);try{await fn();}catch(x){if(e===epoch.current){setError(x instanceof Error?x.message:String(x));setRows([]);setNext(null);}}finally{if(e===epoch.current)setBusy(false);}};
 const generateDraft=()=>action(async()=>{
  const e=epoch.current,payload={templateCode:'statistics-draft' as const,templateVersion:'v1' as const,query:draft as StatisticsQuery,format,includeHeat:heat&&codes.includes('heatmap.read'),todoIds:draft.dataset==='analysis'?todoIds:[]};
  const key=JSON.stringify(payload);if(submission.current?.payload!==key)submission.current={payload:key,requestId:crypto.randomUUID()};
  await createReport({...payload,requestId:submission.current.requestId});if(e!==epoch.current)return;submission.current=null;setContinuation(null);await load();
 });
 const download=(r:ReportArtifact)=>action(async()=>{const e=epoch.current,blob=await downloadReport(r.reportId,r.format);if(e!==epoch.current)return;const url=URL.createObjectURL(blob),a=document.createElement('a');try{a.href=url;a.download='statistics-draft-v1.'+r.format;document.body.appendChild(a);a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}});
 return <Card title="固定模板统计报告 · statistics-draft/v1" style={{marginBottom:24}}>
  <Alert type="warning" showIcon message="工程草稿：统计政策、正式核准与对外发布规则待业务确认" description="产物只包含实际聚合统计、表格、图与未知原因。热力政策未确认时如实显示不可用。报告待办只有关联产物成功后才完成。" style={{marginBottom:16}}/>
  {!canRead?<Alert type="info" message="读取报告内容需要 report.read、statistics.read、complaint.read 及相应数据集权限；暂无可读取内容。"/>:<>
   {generate.can&&<><StatisticsFilters value={draft} onChange={setDraft} onApply={()=>{submission.current=null;}} allowed={allowed} loading={false}/><Space wrap style={{marginBottom:16}}><Select aria-label="报告格式" value={format} onChange={setFormat} options={[{value:'docx',label:'Word · DOCX'},{value:'xlsx',label:'Excel · XLSX'}]}/>{codes.includes('heatmap.read')&&<Checkbox checked={heat} onChange={e=>setHeat(e.target.checked)}>包含热力数据</Checkbox>}<Button type="primary" loading={busy} disabled={!draft.projection||!allowed.includes(draft.dataset)} onClick={()=>void generateDraft()}>生成工程草稿</Button><span>分析库报告可关联已显式选中的 {todoIds.length} 条待办。</span></Space><div style={{marginBottom:16}}>工程限额：当前及比较期间合计最多20000对象，快照与单个产物各16MiB，单字段8192 UTF-8字节。超限请缩小日期或编码选择；数据库限制可能更小。</div></>}
   <Space style={{marginBottom:16}}><Button onClick={()=>{setContinuation(null);void load();}} loading={loading}>刷新报告</Button>{next&&<Button onClick={()=>{setContinuation(next);void load(next);}}>下一页</Button>}</Space>
   {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
   <Table<ReportArtifact> rowKey="reportId" dataSource={rows} loading={loading} pagination={false} scroll={{x:950}} columns={[
    {title:'报告编号',dataIndex:'reportId'},{title:'格式',dataIndex:'format'},{title:'状态',render:(_,r)=><Tag>{stateNames[r.state]}</Tag>},{title:'数据截止',dataIndex:'dataCutoffAt'},{title:'失败原因',dataIndex:'failureReason'},
    {title:'操作',render:(_,r)=><Space>{r.state==='succeeded'&&codes.includes('report.download')&&<Button disabled={busy} onClick={()=>void download(r)}>下载</Button>}{r.state==='failed'&&retry.can&&generate.can&&<Button disabled={busy} onClick={()=>void action(async()=>{const e=epoch.current;await retryReport(r.reportId);if(e===epoch.current)await load(continuation??undefined);})}>重试原快照</Button>}</Space>}
   ]}/>
  </>}
 </Card>;
}
