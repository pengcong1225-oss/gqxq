import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Modal,Space,Table,Tag,Tooltip} from 'antd';
import {ImportOutlined} from '@ant-design/icons';
import {useAppStore} from '../stores/appStore';
import {previewComplaintImport,getComplaintImport,listComplaintImports,commitComplaintImport,type ComplaintImportBatch,type ComplaintImportSummary,type ComplaintImportDetail} from '../api/complaintImports';
const labels:Record<string,string>={complaint:'投诉',consult:'咨询',suggest:'建议',report:'举报',help:'求助',other:'其他',praise:'表扬'};
const errorText=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'操作未完成，请重试';
function actorKey(){const {token,userInfo:user}=useAppStore.getState();return JSON.stringify([token,user?.userId,user?.authorizationVersion,user?.permissions,user?.roles,user?.mustChangePassword]);}

export default function ComplaintImportDialog({onImported}:{onImported:()=>void}){
 const user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token);
 const can=!!token&&!!user&&!user.mustChangePassword&&!user.roles.includes('readonly')&&user.permissions.includes('complaint.import')&&user.permissions.includes('complaint.read');
 const actor=JSON.stringify([token,user?.userId,user?.authorizationVersion,user?.permissions,user?.roles,user?.mustChangePassword]);
 const liveActor=useRef(actor);liveActor.current=actor;
 const generation=useRef(0),requestId=useRef(''),input=useRef<HTMLInputElement>(null);
 const [open,setOpen]=useState(false),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [batch,setBatch]=useState<ComplaintImportBatch|null>(null),[history,setHistory]=useState<ComplaintImportSummary[]>([]);
 const clear=()=>{generation.current++;setBatch(null);setError('');setBusy(false);requestId.current=crypto.randomUUID();};
 const valid=(g:number,a:string)=>g===generation.current&&a===liveActor.current&&a===actorKey();
 useEffect(()=>{clear();setOpen(false);setFile(null);setHistory([]);},[actor]);
 const recent=async(g:number,a:string)=>{try{const rows=await listComplaintImports();if(valid(g,a))setHistory(rows);}catch(e){if(valid(g,a))setError(errorText(e));}};
 const show=()=>{clear();setFile(null);setHistory([]);setOpen(true);void recent(generation.current,actor);};
 const load=async(id:string)=>{clear();setFile(null);if(input.current)input.current.value='';const g=generation.current,a=actor;setBusy(true);try{const b=await getComplaintImport(id);if(valid(g,a))setBatch(b);}catch(e){if(valid(g,a))setError(errorText(e));}finally{if(valid(g,a))setBusy(false);}};
 const check=async()=>{
  if(!file||busy||!can)return;clear();const g=generation.current,a=actor,f=file;setBusy(true);
  try{if(f.size>10*1024*1024)throw Error('文件超过 10 MB，请拆批导入');if(!/\.(xls|xlsx)$/i.test(f.name))throw Error('请选择 .xls 或 .xlsx 文件');if(!valid(g,a))return;const p=await previewComplaintImport(f,token!,()=>valid(g,a));if(!valid(g,a))return;const b=await getComplaintImport(p.batchId);if(valid(g,a)){setBatch(b);void recent(g,a);}}
  catch(e){if(valid(g,a))setError(errorText(e));}finally{if(valid(g,a))setBusy(false);}
 };
 const confirm=async()=>{
  if(!batch?.preview.canCommit||batch.result||busy||!can)return;const g=generation.current,a=actor,id=batch.preview.batchId;setBusy(true);setError('');
  try{const result=await commitComplaintImport(id,requestId.current);if(!valid(g,a))return;setBatch(b=>b?.preview.batchId===id?{...b,result,preview:{...b.preview,canCommit:false}}:b);onImported();void recent(g,a);}
  catch(e){if(valid(g,a))setError(errorText(e)+'；可重试确认，或查询本批次结果。');}finally{if(valid(g,a))setBusy(false);}
 };
 const p=batch?.preview;
 return <><Tooltip title={can?'':'当前账号没有诉求导入权限'}><span><Button icon={<ImportOutlined/>} disabled={!can} onClick={show}>批量导入</Button></span></Tooltip>
 <Modal title="诉求批量导入" open={open&&can} width={1050} footer={null} destroyOnHidden onCancel={()=>{clear();setOpen(false);setFile(null);setHistory([]);}}>
  <p>请选择宜接就办“综合查询”导出的 Excel，每批最多 2000 行、10 MB。同一文件内重复案件取最后一行，平台已有案件跳过。</p>
  <Space wrap><input ref={input} type="file" aria-label="诉求导入文件" accept=".xls,.xlsx" disabled={busy} onChange={e=>{clear();setFile(e.target.files?.[0]??null);}}/><Button disabled={!file||busy} loading={busy&&!batch} onClick={()=>void check()}>校验预览</Button></Space>
  {error&&<Alert type="error" showIcon message={error} style={{marginTop:12}}/>}
  {p&&<div style={{marginTop:16}}><strong>{p.name}</strong><p>数据 {p.counts.total} 行，案件 {p.counts.unique} 件，文件内重复 {p.counts.duplicates} 行；预计新增 {p.counts.create} 件，跳过 {p.counts.skip} 件，错误 {p.counts.error} 行。</p>
   {!batch?.result&&!batch?.expired&&<p>预览有效至 {new Date(p.expiresAt).toLocaleString('zh-CN')}。请核对后确认。</p>}
   {p.counts.error>0&&<Alert type="error" message="有错误，尚未导入。请按下方行号修正 Excel 后重新上传。"/>}
   {batch?.expired&&!batch.result&&<Alert type="warning" message="预览已过期，请重新上传。"/>}
   {batch?.result?<Alert type="success" showIcon message={`导入完成：新增 ${batch.result.created} 件，跳过 ${batch.result.skipped} 件`}/>:p.canCommit&&<Button type="primary" loading={busy} disabled={busy} onClick={()=>void confirm()}>确认导入</Button>}
   <Button style={{marginLeft:8}} disabled={busy} onClick={()=>void load(p.batchId)}>查询本批次结果</Button>
   <Table<ComplaintImportDetail> style={{marginTop:12}} size="small" rowKey="row" dataSource={batch?.details} pagination={{pageSize:20,showSizeChanger:false}} scroll={{x:800}} columns={[
    {title:'Excel 行号',dataIndex:'row',width:90},{title:'案件公文号',dataIndex:'sourceId',width:180},{title:'诉求摘要',dataIndex:'title',ellipsis:true},
    {title:'业务',render:(_,d)=>d.businessType==='water'?'供水':d.businessType==='gas'?'燃气':'—',width:65},{title:'性质',render:(_,d)=>labels[d.complaintType??'']??'—',width:65},
    {title:'校验结果',render:(_,d)=><>{d.errors.length?d.errors.join('；'):<Tag color={d.action==='create'?'blue':undefined}>{({create:'新增',skip:'已有案件，跳过',duplicate:'文件重复，跳过',error:'错误'})[d.action]}</Tag>}</>,width:230}
   ]}/>
  </div>}
  <p style={{marginTop:20}}>最近导入记录</p><Table<ComplaintImportSummary> size="small" rowKey={b=>b.preview.batchId} dataSource={history} pagination={false} columns={[
   {title:'文件',dataIndex:['preview','name']},{title:'结果',render:(_,b)=>b.result?`新增 ${b.result.created} 件，跳过 ${b.result.skipped} 件`:b.expired?'预览已过期':b.preview.canCommit?'待确认':'校验未通过'},
   {title:'操作',render:(_,b)=><Button size="small" disabled={busy} onClick={()=>void load(b.preview.batchId)}>查看</Button>}
  ]}/>
 </Modal></>;
}
