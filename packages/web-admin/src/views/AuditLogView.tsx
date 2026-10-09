import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,DatePicker,Descriptions,Drawer,Form,Input,Result,Select,Space,Table,Tag,Typography} from 'antd';
import type {Dayjs} from 'dayjs';
import {listAuditLogs,getAuditLog} from '../api/auditLogs';
import type {AuditLogFilter,AuditLogView,Paged} from '../types/api';
import {FORBIDDEN_MESSAGE,usePermissionAccess} from '../stores/roleAccess';
const resultLabels={success:'成功',failed:'失败',rejected:'拒绝',duplicate:'重复',unknown:'未知'};
const modules=[['auth','登录'],['user','账号'],['role','角色授权'],['corrections','纠偏'],['complaint','诉求'],['dispatch_order','交办'],['analysis_record','分析入库'],['business_event','回调'],['sensitive_word','敏感词字典'],['address_candidate','地址候选'],['security','权限拒绝']];
interface FilterForm extends Omit<AuditLogFilter,'from'|'to'> {timeRange?:[Dayjs,Dayjs]}
const date=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'请求失败，请稍后重试';
const AuditLogView:React.FC=()=>{
 const access=usePermissionAccess('system.audit.read');const [form]=Form.useForm<FilterForm>();
 const [filter,setFilter]=useState<AuditLogFilter>({});const [page,setPage]=useState(1);const [size,setSize]=useState(20);
 const [data,setData]=useState<Paged<AuditLogView>|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState<string|null>(null);
 const [detail,setDetail]=useState<AuditLogView|null>(null);const [detailOpen,setDetailOpen]=useState(false);const [detailLoading,setDetailLoading]=useState(false);const [detailError,setDetailError]=useState<string|null>(null);const detailRequest=useRef(0);
 useEffect(()=>{
  if(!access.can){setData(null);setDetail(null);setDetailOpen(false);detailRequest.current++;return;}
  let cancelled=false;setLoading(true);setData(null);setError(null);
  void listAuditLogs({...filter,page,size}).then(value=>{if(!cancelled)setData(value);}).catch(err=>{if(!cancelled)setError(errorMessage(err));}).finally(()=>{if(!cancelled)setLoading(false);});
  return ()=>{cancelled=true;};
 },[access.can,filter,page,size]);
 useEffect(()=>()=>{detailRequest.current++;},[]);
 const openDetail=async(auditId:string)=>{
  const serial=++detailRequest.current;setDetailOpen(true);setDetail(null);setDetailError(null);setDetailLoading(true);
  try{const value=await getAuditLog(auditId);if(serial===detailRequest.current)setDetail(value);}catch(err){if(serial===detailRequest.current)setDetailError(errorMessage(err));}finally{if(serial===detailRequest.current)setDetailLoading(false);}
 };
 const submit=(values:FilterForm)=>{
  const {timeRange,...other}=values;const next=Object.fromEntries(Object.entries(other).filter(([,value])=>value!==undefined&&value!=='')) as AuditLogFilter;
  if(timeRange?.[0]&&timeRange?.[1]){next.from=timeRange[0].toISOString();next.to=timeRange[1].toISOString();}
  setPage(1);setFilter(next);
 };
 if(!access.can)return <Result status="403" title={FORBIDDEN_MESSAGE}/>;
 return <Card title="登录与操作日志">
  <Alert type="info" showIcon message="业务日志按当前数据范围展示；详情仅含允许字段。未授权或无法确认关联的日志不可查看。" style={{marginBottom:16}}/>
  <Form form={form} layout="inline" onFinish={submit} style={{rowGap:12,marginBottom:16}}>
   <Form.Item name="category" label="日志类别"><Select allowClear style={{width:140}} options={[{value:'login',label:'登录日志'},{value:'operation',label:'操作日志'}]}/></Form.Item>
   <Form.Item name="timeRange" label="时间区间"><DatePicker.RangePicker showTime/></Form.Item>
   <Form.Item name="actor" label="操作人"><Input maxLength={128} placeholder="用户ID或用户名"/></Form.Item>
   <Form.Item name="module" label="模块"><Select allowClear style={{width:150}} options={modules.map(([value,label])=>({value,label}))}/></Form.Item>
   <Form.Item name="action" label="动作"><Input maxLength={128} placeholder="如 USER_UPDATE"/></Form.Item>
   <Form.Item name="result" label="结果"><Select allowClear style={{width:110}} options={Object.entries(resultLabels).map(([value,label])=>({value,label}))}/></Form.Item>
   <Form.Item name="businessNo" label="业务编号"><Input maxLength={128} placeholder="诉求编号或业务键"/></Form.Item>
   <Form.Item><Space><Button type="primary" htmlType="submit">查询</Button><Button onClick={()=>{form.resetFields();setPage(1);setFilter({});}}>重置</Button></Space></Form.Item>
  </Form>
  {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
  <Table<AuditLogView> rowKey="auditId" loading={loading} dataSource={data?.content??[]} scroll={{x:1100}} locale={{emptyText:error?'查询失败':'当前条件下无可查看日志'}}
   pagination={{current:page,pageSize:size,total:data?.total??0,showSizeChanger:true,showTotal:total=>'共 '+total+' 条',onChange:(next,nextSize)=>{setPage(nextSize!==size?1:next);setSize(nextSize);}}}
   columns={[
    {title:'时间',dataIndex:'createdAt',render:date,width:180},
    {title:'类别',dataIndex:'category',render:value=>value==='login'?'登录':'操作',width:70},
    {title:'操作人ID',dataIndex:'userId',render:value=>value??'无平台用户',width:160},
    {title:'模块',dataIndex:'module',render:value=>modules.find(([code])=>code===value)?.[1]??value},
    {title:'动作',dataIndex:'action'},
    {title:'结果',dataIndex:'result',render:(value:AuditLogView['result'],row)=><Tag title={'原始值：'+row.originalResult}>{resultLabels[value]}</Tag>},
    {title:'业务编号',render:(_,row)=>row.businessNo??row.bizId??'—'},
    {title:'操作',render:(_,row)=><Button type="link" onClick={()=>void openDetail(row.auditId)}>查看详情</Button>},
   ]}/>
  <Drawer title="安全详情" open={detailOpen} width={640} loading={detailLoading} onClose={()=>{detailRequest.current++;setDetailOpen(false);setDetail(null);}}>
   {detailError&&<Alert type="error" showIcon message={detailError}/>}
   {detail&&<>
    <Descriptions column={1} bordered size="small" items={[
     {key:'id',label:'审计ID',children:detail.auditId},{key:'time',label:'时间',children:date(detail.createdAt)},
     {key:'actor',label:'操作人ID',children:detail.userId??'无平台用户'},
     {key:'action',label:'动作',children:detail.action},{key:'business',label:'业务编号',children:detail.businessNo??detail.bizId??'—'},
     {key:'result',label:'结果',children:resultLabels[detail.result]+'（原始值：'+(detail.originalResult||'空')+'）'},
     {key:'ip',label:'客户端IP',children:detail.clientIp??'—'},
    ]}/>
    <Typography.Title level={5}>允许字段及前后值</Typography.Title>
    {Object.keys(detail.detail).length?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(detail.detail,null,2)}</pre>:<Typography.Text type="secondary">无可公开的详情字段</Typography.Text>}
   </>}
  </Drawer>
 </Card>;
};
export default AuditLogView;
