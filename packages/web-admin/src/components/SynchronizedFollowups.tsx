import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Modal,Table} from 'antd';
import request from '../api/request';
import {useAppStore} from '../stores/appStore';
import {usePermissionAccess} from '../stores/roleAccess';

interface SourceFollowup {id:string;sourceId:string;sourceObjectId:string;sourceVersion:number;payload:{occurredAt:string|null;contacted:boolean|null;evaluation:string|null;dissatisfactionReason:string|null;operatorName:string|null;notes:string|null}}
const columns=[{title:'回访时间',dataIndex:['payload','occurredAt'],render:(v:string|null)=>v?new Date(v).toLocaleString('zh-CN'):'未提供'},
 {title:'接通状态',dataIndex:['payload','contacted'],render:(v:boolean|null)=>v===true?'已接通':v===false?'未接通':'未提供'},
 {title:'满意度',dataIndex:['payload','evaluation'],render:(v:string|null)=>v==='satisfied'?'满意':v==='dissatisfied'?'不满意':'未评价'},
 {title:'不满意原因',dataIndex:['payload','dissatisfactionReason']},{title:'回访人',dataIndex:['payload','operatorName']},{title:'来源版本',dataIndex:'sourceVersion'}];
export default function SynchronizedFollowups({complaintId}:{complaintId:string}){
 const {can}=usePermissionAccess('complaint.read'),user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token),identity=JSON.stringify([user,token]);
 const key=identity+'|'+complaintId,owner=useRef(key);owner.current=key;const seq=useRef(0),detailSeq=useRef(0);
 const [state,setState]=useState<{key:string;rows:SourceFollowup[];total:number;page:number}>({key:'',rows:[],total:0,page:1});
 const [detail,setDetail]=useState<{key:string;history:SourceFollowup[]}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function load(page=1){if(!can)return;const n=++seq.current,k=key;setBusy(true);setError('');try{const result=await request.get<any, {content:SourceFollowup[];total:number}>('/synchronized-followups',{params:{complaintId,page,size:10}});if(owner.current===k&&seq.current===n)setState({key:k,rows:result.content,total:result.total,page});}catch{if(owner.current===k&&seq.current===n)setError('外部回访读取失败，请重试');}finally{if(owner.current===k&&seq.current===n)setBusy(false);}}
 async function open(row:SourceFollowup){const k=key,n=++detailSeq.current;setError('');try{const result=await request.get<any,{history:SourceFollowup[]}>('/synchronized-followups/'+encodeURIComponent(row.id));if(owner.current===k&&detailSeq.current===n)setDetail({key:k,history:result.history});}catch{if(owner.current===k&&detailSeq.current===n)setError('来源回访历史读取失败');}}
 useEffect(()=>{setDetail(null);setError('');setBusy(false);void load();return()=>{seq.current++;detailSeq.current++;};},[key,can]);
 if(!can)return null;const active=state.key===key?state:{rows:[],total:0,page:1};
 return <Card title="外部回访记录" style={{marginTop:16}} extra={<Button onClick={()=>void load(active.page)}>刷新外部回访</Button>}>
  {error&&<Alert type="error" message={error}/>}<Table rowKey="id" loading={busy} dataSource={active.rows} columns={[...columns,{title:'操作',render:(_:unknown,row:SourceFollowup)=><Button onClick={()=>void open(row)}>查看修订明细</Button>}]} pagination={{current:active.page,total:active.total,pageSize:10,onChange:page=>void load(page)}} locale={{emptyText:'来源尚未同步回访记录'}} scroll={{x:1000}}/>
  {detail?.key===key&&<Modal title="外部回访修订历史" open onCancel={()=>{detailSeq.current++;setDetail(null);}} footer={null} width={1000}><Table rowKey={r=>String(r.sourceVersion)} dataSource={detail.history} columns={columns} pagination={false}/></Modal>}
 </Card>;
}
