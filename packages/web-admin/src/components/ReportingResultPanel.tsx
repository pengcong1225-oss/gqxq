import {chineseLabel,fieldLabel,fieldValue} from '../utils/chineseDisplay';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Descriptions,Empty,Space,Tag,Typography,message} from 'antd';
import request from '../api/request';
import {useWriteAccess} from '../stores/roleAccess';
import {useAppStore} from '../stores/appStore';
interface Attachment{attachmentId:string;fileName:string;sha256:string;size:number}
interface EventPayload{eventType:string;submissionVersion?:number;eventSequence?:number;enterpriseDisposalResult?:Record<string,string|number|boolean|null>;withheldFieldCount?:number;attachments?:Attachment[]}
interface Result{taskUrl:string|null;events:Array<{eventId:string;state:string;payload:EventPayload}>}
export default function ReportingResultPanel({assignmentId,readOnly=false}:{assignmentId:string;readOnly?:boolean}){
 const user=useAppStore(s=>s.userInfo);const token=useAppStore(s=>s.token);
 const key=JSON.stringify([assignmentId,token,user?.userId,user?.authorizationVersion,user?.roles,user?.permissions,readOnly]);
 const keyRef=useRef(key),sequence=useRef(0);if(keyRef.current!==key){keyRef.current=key;sequence.current++;}
 const [loaded,setLoaded]=useState<{key:string;result:Result|null;error:string}|null>(null);const [busy,setBusy]=useState(false);const pushAccess=useWriteAccess('dispatch.push');const reconcileAccess=useWriteAccess('dispatch.reconcile');
 const result=loaded?.key===key?loaded.result:null;const error=loaded?.key===key?loaded.error:'';
 const setError=(error:string)=>setLoaded(current=>({key,result:current?.key===key?current.result:null,error}));
 const endpoint='/dispatch/orders/'+encodeURIComponent(assignmentId);
 const load=useCallback(async()=>{const serial=++sequence.current;const owns=()=>keyRef.current===key&&serial===sequence.current;setLoaded(null);try{const result=await request.get<Result,Result>(endpoint+'/reporting-result');if(owns())setLoaded({key,result,error:''});}catch(e){if(owns())setLoaded({key,result:null,error:(e as Error).message});}},[key,endpoint]);
 useEffect(()=>{void load();return()=>{sequence.current++;};},[load]);
 const action=async(kind:'preflight'|'reconcile')=>{setBusy(true);try{const response=await request.post<unknown,{ready?:boolean;issues?:Array<{message:string}>}>(endpoint+'/'+kind);if(response.ready===false){setError((response.issues??[]).map(i=>i.message).join('；'));}else{void message.success(kind==='preflight'?'配置与业务授权已就绪':'对账已完成');setError('');}if(response.ready!==false) await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const download=async(a:Attachment)=>{const owner=sequence.current;const owns=()=>keyRef.current===key&&sequence.current===owner;try{const blob=await request.get<Blob,Blob>(endpoint+'/reporting-attachments/'+encodeURIComponent(a.attachmentId),{responseType:'blob'});if(!owns())return;const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=a.fileName;link.click();URL.revokeObjectURL(url);}catch(e){if(owns())void message.error((e as Error).message);}};
 const latest=result?.events.filter(e=>e.state==='applied'&&(readOnly?['TASK_APPROVED','TASK_REJECTED'].includes(e.payload.eventType.toUpperCase()):e.payload.submissionVersion)).reverse()[0];
 return <Card title={readOnly?'同步处理结果':'填报进度与处置证据'} size="small" style={{marginTop:16}} extra={<Space><Button onClick={()=>void load()}>{readOnly?'刷新结果':'刷新进度'}</Button>{!readOnly&&<><Button disabled={!pushAccess.can||busy} onClick={()=>void action('preflight')}>推送预检</Button><Button disabled={!reconcileAccess.can||busy} onClick={()=>void action('reconcile')}>签名对账</Button></>}</Space>}>
 {error&&<Alert type="error" showIcon message={error}/>}
 {!readOnly&&result?.taskUrl&&<Typography.Link href={result.taskUrl} target="_blank" rel="noopener noreferrer">打开企业填报任务</Typography.Link>}
 {!readOnly&&result?.events.some(e=>e.state==='pending')&&<Alert type="warning" showIcon message="部分审批进度正在更新，请稍后刷新。"/>}
 {!readOnly&&<Space wrap>{result?.events.map(e=><Tag key={e.eventId}>{chineseLabel(e.payload.eventType,'event_type','审批进度待核对')} · {e.state==='pending'?'等待更新':chineseLabel(e.state)} {e.payload.eventSequence?'#'+e.payload.eventSequence:''}</Tag>)}</Space>}
 {latest?<>{!readOnly&&<Typography.Paragraph>当前提交版本：{latest.payload.submissionVersion}</Typography.Paragraph>}{Boolean(latest.payload.withheldFieldCount)&&<Alert type="info" message="部分处置信息暂未展示"/>}<Descriptions size="small" bordered column={1}>{Object.entries(latest.payload.enterpriseDisposalResult??{}).map(([key,value])=><Descriptions.Item key={key} label={fieldLabel(key)}>{fieldValue(key,value)}</Descriptions.Item>)}</Descriptions><Space direction="vertical">{latest.payload.attachments?.map(a=><Button type="link" key={a.attachmentId} onClick={()=>void download(a)}>{a.fileName}（{a.size} 字节）</Button>)}</Space></>:<Empty description={readOnly?'尚未同步处理完成的事项结果':'尚未收到企业提交结果'}/>}
 </Card>;
}
