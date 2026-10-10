import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Table} from 'antd';
import {listDispatchOrders} from '../api/dispatch';
import {usePermissionAccess} from '../stores/roleAccess';
import {useAppStore} from '../stores/appStore';
import {chineseLabel,systemMessage} from '../utils/chineseDisplay';
import type {DispatchOrderListItem} from '../types/api';
import ReportingResultPanel from './ReportingResultPanel';

/** Includes completed/archived assignments; unrelated complaints and obsolete auth responses never render. */
export default function ComplaintReportingResults({complaintId}:{complaintId:string}){
 const read=usePermissionAccess('dispatch.read');const complaintRead=usePermissionAccess('complaint.read');
 const token=useAppStore(s=>s.token);const user=useAppStore(s=>s.userInfo);
 const key=JSON.stringify([complaintId,token,user?.userId,user?.authorizationVersion,user?.roles,user?.permissions,user?.mustChangePassword]);
 const keyRef=useRef(key);const serial=useRef(0);if(keyRef.current!==key){keyRef.current=key;serial.current++;}
 const [state,setState]=useState<{key:string;rows:DispatchOrderListItem[];total:number;page:number;loading:boolean;error:string}|null>(null);
 const [selection,setSelection]=useState<{key:string;assignmentId:string}|null>(null);
 const canRead=read.can&&complaintRead.can;
 const load=useCallback(async(page=1)=>{
  if(!canRead)return;const sequence=++serial.current;const owns=()=>keyRef.current===key&&serial.current===sequence;
  setSelection(null);setState({key,rows:[],total:0,page,loading:true,error:''});
  try{const value=await listDispatchOrders({complaintId,page,size:10});
   if(!owns())return;
   if(value.content.some(row=>row.complaintId!==complaintId))throw Error('事项与当前诉求不一致，请刷新重试');
   setState({key,rows:value.content,total:value.total,page,loading:false,error:''});
  }catch(error){if(owns())setState({key,rows:[],total:0,page,loading:false,error:systemMessage((error as Error).message,'事项结果读取失败，请重试')});}
 },[key,canRead,complaintId]);
 useEffect(()=>{void load();return()=>{serial.current++;};},[load]);
 if(!canRead)return null;
 const current=state?.key===key?state:null;
 const selected=selection?.key===key&&current?.rows.find(row=>row.assignmentId===selection.assignmentId);
 return <Card title="填报事项结果" style={{marginTop:16}} extra={<Button loading={current?.loading} onClick={()=>void load(current?.page??1)}>刷新结果</Button>}>
  {current?.error&&<Alert type="error" showIcon message={current.error} style={{marginBottom:12}}/>}
  <Table rowKey="assignmentId" size="small" loading={current?.loading} dataSource={current?.rows??[]} locale={{emptyText:current?.error?'读取失败':'暂无关联填报事项'}}
   pagination={{current:current?.page??1,pageSize:10,total:current?.total??0,onChange:page=>void load(page),showSizeChanger:false}}
   columns={[
    {title:'交办单号',dataIndex:'orderNo'},
    {title:'责任单位',dataIndex:'targetEnterpriseName',render:value=>value??'—'},
    {title:'填报状态',dataIndex:'externalStatus',render:value=>chineseLabel(value,'reporting_status')},
    {title:'归档状态',dataIndex:'archivedAt',render:value=>value?'已归档':'未归档'},
    {title:'操作',render:(_,row)=><Button type="link" onClick={()=>setSelection({key,assignmentId:row.assignmentId})}>查看事项结果</Button>},
   ]}/>
  {selected&&<ReportingResultPanel key={key+selected.assignmentId} assignmentId={selected.assignmentId} readOnly/>}
 </Card>;
}
