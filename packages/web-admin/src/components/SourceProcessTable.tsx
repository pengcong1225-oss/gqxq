import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Empty,Table,Typography} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import {usePermissionAccess} from '../stores/roleAccess';
import {getComplaintSourceProcesses} from '../api/complaints';
import type {SourceProcessResult,SourceProcessRevision} from '../types/api';

const text=(value:string|null)=><span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value??'—'}</span>;
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN'):'来源时间缺失';
const columns:ColumnsType<SourceProcessRevision>=[
 {title:'来源时间',dataIndex:'occurredAt',width:150,render:time},
 {title:'来源顺序',dataIndex:'sourceSequence',width:90,render:value=>value??'未提供'},
 {title:'办理阶段',dataIndex:'stage',width:120,render:text},
 {title:'办理部门',dataIndex:'department',width:140,render:text},
 {title:'联系人',dataIndex:'contactName',width:110,render:text},
 {title:'处理意见',dataIndex:'opinion',render:text},
 {title:'来源版号',dataIndex:'sourceVersion',width:110,render:value=>text(value??'未提供')},
];
const SourceProcessTable:React.FC<{complaintId:string}>=({complaintId})=>{
 const access=usePermissionAccess('complaint.read');const requestSeq=useRef(0);
 const [result,setResult]=useState<SourceProcessResult|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState<string|null>(null);
 useEffect(()=>{requestSeq.current++;setResult(null);setError(null);setLoading(false);return()=>{requestSeq.current++;};},[complaintId,access.can]);
 const load=async()=>{
  const seq=++requestSeq.current;setLoading(true);setError(null);setResult(null);
  try{const data=await getComplaintSourceProcesses(complaintId);if(seq===requestSeq.current)setResult(data);}
  catch(err){if(seq===requestSeq.current)setError((err as {message?:string}).message??'来源全过程读取失败');}
  finally{if(seq===requestSeq.current)setLoading(false);}
 };
 if(!access.can)return null;
 return <Card title="来源全过程" style={{marginTop:16}} extra={<Button loading={loading} onClick={()=>void load()}>查看来源全过程</Button>}>

  {error&&<Alert type="error" showIcon message={error}/>}
  {result&&<>
   <Alert showIcon style={{marginBottom:12}} type={result.state==='error'?'error':result.complete?'success':'warning'}
    message={result.state==='unavailable'?'来源全过程尚未接入':result.complete?'完整批次已保存':'来源全过程尚未完整'}
    description={<>{result.syncError&&<div>{result.syncError}</div>}<div>已完成批次截止时间：{result.cutoffAt?new Date(result.cutoffAt).toLocaleString('zh-CN'):'未提供可信截止时间'}</div>{result.missingTimeNodeIds.length>0&&<div>部分节点缺少来源时间，无法确认完整业务时序。</div>}</>}/>
   {result.nodes.length===0?<Empty description="暂无已核实的来源节点"/>:<Table size="small" pagination={false} columns={columns} dataSource={result.nodes} rowKey="nodeId" scroll={{x:850}}
    expandable={{rowExpandable:node=>result.revisions.filter(r=>r.nodeId===node.nodeId).length>1,expandedRowRender:node=><><Typography.Text type="secondary">该节点已保存的来源修订</Typography.Text><Table size="small" pagination={false} columns={columns} dataSource={result.revisions.filter(r=>r.nodeId===node.nodeId)} rowKey={r=>String(r.revision)}/></>}}/>}
  </>}
 </Card>;
};
export default SourceProcessTable;
