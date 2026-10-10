import React,{useEffect,useState} from 'react';
import {Alert,Button,Card,Descriptions,Empty,Space,Tag,Typography,message} from 'antd';
import request from '../api/request';
import {useWriteAccess} from '../stores/roleAccess';
interface Attachment{attachmentId:string;fileName:string;sha256:string;size:number}
interface EventPayload{eventType:string;submissionVersion?:number;eventSequence?:number;enterpriseDisposalResult?:Record<string,string|number|boolean|null>;withheldFieldCount?:number;attachments?:Attachment[]}
interface Result{taskUrl:string|null;events:Array<{eventId:string;state:string;payload:EventPayload}>}
export default function ReportingResultPanel({assignmentId}:{assignmentId:string}){
 const [result,setResult]=useState<Result|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const pushAccess=useWriteAccess('dispatch.push');const reconcileAccess=useWriteAccess('dispatch.reconcile');
 const endpoint='/dispatch/orders/'+encodeURIComponent(assignmentId);
 const load=async()=>{try{setResult(await request.get<Result,Result>(endpoint+'/reporting-result'));setError('');}catch(e){setError((e as Error).message);}};
 useEffect(()=>{void load();},[assignmentId]);
 const action=async(kind:'preflight'|'reconcile')=>{setBusy(true);try{const response=await request.post<unknown,{ready?:boolean;issues?:Array<{message:string}>}>(endpoint+'/'+kind);if(response.ready===false){setError((response.issues??[]).map(i=>i.message).join('；'));}else{void message.success(kind==='preflight'?'配置与业务授权已就绪':'对账已完成');setError('');}if(response.ready!==false) await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const download=async(a:Attachment)=>{try{const blob=await request.get<Blob,Blob>(endpoint+'/reporting-attachments/'+encodeURIComponent(a.attachmentId),{responseType:'blob'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=a.fileName;link.click();URL.revokeObjectURL(url);}catch(e){void message.error((e as Error).message);}};
 const latest=result?.events.filter(e=>e.state==='applied'&&e.payload.submissionVersion).reverse()[0];
 return <Card title="填报进度与处置证据" size="small" style={{marginTop:16}} extra={<Space><Button onClick={()=>void load()}>刷新进度</Button><Button disabled={!pushAccess.can||busy} onClick={()=>void action('preflight')}>推送预检</Button><Button disabled={!reconcileAccess.can||busy} onClick={()=>void action('reconcile')}>签名对账</Button></Space>}>
 {error&&<Alert type="error" showIcon message={error}/>}
 {result?.taskUrl&&<Typography.Link href={result.taskUrl} target="_blank" rel="noopener noreferrer">打开企业填报任务</Typography.Link>}
 {result?.events.some(e=>e.state==='pending')&&<Alert type="warning" showIcon message="部分审批进度正在更新，请稍后刷新。"/>}
 <Space wrap>{result?.events.map(e=><Tag key={e.eventId}>{({TASK_ACCEPTED:'已签收',TASK_SUBMITTED:'已提交',TASK_RETURNED:'待修正',TASK_REJECTED:'已否决',TASK_APPROVED:'最终通过',TASK_PROGRESS:'审批推进'} as Record<string,string>)[e.payload.eventType]??e.payload.eventType} · {e.state==='applied'?'已应用':e.state==='pending'?'等待补偿':e.state} {e.payload.eventSequence?'#'+e.payload.eventSequence:''}</Tag>)}</Space>
 {latest?<><Typography.Paragraph>当前提交版本：{latest.payload.submissionVersion}</Typography.Paragraph>{Boolean(latest.payload.withheldFieldCount)&&<Alert type="info" message="部分处置信息暂未展示"/>}<Descriptions size="small" bordered column={1}>{Object.entries(latest.payload.enterpriseDisposalResult??{}).map(([key,value])=><Descriptions.Item key={key} label={key}>{String(value??'—')}</Descriptions.Item>)}</Descriptions><Space direction="vertical">{latest.payload.attachments?.map(a=><Button type="link" key={a.attachmentId} onClick={()=>void download(a)}>{a.fileName}（{a.size} 字节）</Button>)}</Space></>:<Empty description="尚未收到企业提交结果"/>}
 </Card>;
}
