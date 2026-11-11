import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Modal,Space,Table,Typography} from 'antd';
import {useNavigate} from 'react-router-dom';
import {useAppStore} from '../stores/appStore';
import {getAdministrativeComplaints} from '../api/administrativeHeat';
import {getStatisticsComplaints,getCommunityStatisticsComplaints} from '../api/statistics';
import type {StatisticsQuery,StatisticsPage,StatisticsComplaint} from '../types/statistics';
export default function StatisticsDetailsModal({query,title='诉求明细',onClose,adminGridCode,communityCode,simulation=false}:{query:StatisticsQuery|null;title?:string;adminGridCode?:string;communityCode?:string;simulation?:boolean;onClose:()=>void}){
 const user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token),navigate=useNavigate();
 const [page,setPage]=useState(1),[size,setSize]=useState(10),[retry,setRetry]=useState(0);
 const [state,setState]=useState<{key:string;data?:StatisticsPage;error?:string}>();
 const seq=useRef(0);
 const queryKey=JSON.stringify([query,adminGridCode,communityCode,simulation]),authKey=JSON.stringify([token,user?.userId,user?.authorizationVersion,user?.permissions,user?.mustChangePassword]);
 const allowed=!!query&&!!user&&!user.mustChangePassword&&['statistics.read','complaint.read',query.dataset==='ledger'?'dashboard.read':'analysis.read'].every(p=>user.permissions.includes(p));
 const previous=useRef(queryKey);const activePage=previous.current===queryKey?page:1;
 const key=JSON.stringify([queryKey,authKey,activePage,size,retry]);const current=state?.key===key?state:undefined;
 useEffect(()=>{if(previous.current!==queryKey){previous.current=queryKey;setPage(1);}},[queryKey]);
 useEffect(()=>{const n=++seq.current;if(!query||!allowed)return;void (adminGridCode?getAdministrativeComplaints(query,adminGridCode,activePage,size,simulation):communityCode?getCommunityStatisticsComplaints(query,communityCode,activePage,size):getStatisticsComplaints(query,activePage,size)).then(data=>{if(n===seq.current)setState({key,data});}).catch(e=>{if(n===seq.current)setState({key,error:e instanceof Error?e.message:'明细加载失败'});});return()=>{seq.current++;};},[key,allowed]);
 return <Modal title={title} open={!!query} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={1100} destroyOnClose>
 {query&&<><Typography.Paragraph type="secondary">{query.from} 至 {query.to} · {query.dataset==='ledger'?'全部诉求':'已入分析库诉求'}{current?.data?' · 共 '+current.data.total+' 件':''}</Typography.Paragraph>
 {!allowed?<Alert type="warning" message="当前账号没有查看诉求明细的权限"/>:<>
 {current?.error&&<Alert type="error" message="明细加载失败" description={current.error} action={<Button onClick={()=>setRetry(n=>n+1)}>重试</Button>}/>}
 <Table<StatisticsComplaint> rowKey="complaintId" loading={!current} dataSource={current?.data?.content??[]} scroll={{x:900}} pagination={{current:activePage,pageSize:size,total:current?.data?.total??0,showSizeChanger:true,showTotal:n=>'共 '+n+' 件',onChange:(p,s)=>{setPage(p);setSize(s);}}} columns={[
 {title:'诉求编号',dataIndex:'complaintNo',render:(v:string,r)=><Button type="link" onClick={()=>{onClose();navigate('/complaints/'+r.id);}}>{v}</Button>},
 {title:'诉求标题',dataIndex:'title'},{title:'统计日期',dataIndex:'businessDay',width:110},{title:'企业',dataIndex:'enterpriseName'},{title:'区县',dataIndex:'districtName'},
 {title:'操作',width:100,render:(_,r)=><Button onClick={()=>{onClose();navigate('/complaints/'+r.id);}}>查看诉求</Button>}
 ]}/></>}</>}
 </Modal>;
}
