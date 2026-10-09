import React,{useEffect,useState} from 'react';
import {Alert,Button,Input,Modal,Space,Table} from 'antd';
import type {ComplaintDetail} from '../types/api';
import type {CategoryRef,CategoryRevision} from '../types/masterData';
import {useWriteAccess} from '../stores/roleAccess';
import {getCategoryHistory,saveComplaintCategory} from '../api/masterData';
import CategorySelector from './CategorySelector';
export default function ComplaintCategoryEditor({detail,onSaved}:{detail:ComplaintDetail;onSaved:()=>void}) {
 const access=useWriteAccess('complaint.correct');const [open,setOpen]=useState(false);const [draft,setDraft]=useState<CategoryRef|null>(detail.category??null);const [basis,setBasis]=useState('');const [error,setError]=useState('');const [saving,setSaving]=useState(false);const [history,setHistory]=useState<CategoryRevision[]|null>(null);
 useEffect(()=>{if(!open)setDraft(detail.category??null);},[detail.category,open]);
 const save=async()=>{if(!draft||!basis.trim()){setError('请选择正式分类并填写核对依据');return;}setSaving(true);try{await saveComplaintCategory(detail.complaintId,draft,detail.editVersion,basis.trim());setOpen(false);setError('');onSaved();}catch(e){setError((e as {message?:string}).message??'分类纠偏失败');}finally{setSaving(false);}};
 return <Space direction="vertical">
  <span>{detail.category?`${detail.category.majorCode}${detail.category.minorCode?' / '+detail.category.minorCode:''}（字典版本 ${detail.category.dictionaryVersion}）`:'未分类'}</span>
  {detail.sourceCategory&&<span>来源分类：{detail.sourceCategory.majorCode} / {detail.sourceCategory.minorCode??'—'}</span>}
  <Space>{access.can&&<Button size="small" onClick={()=>{setError('');setOpen(true);}}>纠偏正式分类</Button>}<Button size="small" onClick={async()=>{try{setHistory(await getCategoryHistory(detail.complaintId));}catch(e){setError((e as {message?:string}).message??'历史加载失败');}}}>分类历史</Button></Space>
  {error&&!open&&<Alert type="error" message={error}/>}
  <Modal title="纠偏正式大小类" open={open} onCancel={()=>setOpen(false)} onOk={()=>void save()} okText="保存分类" confirmLoading={saving} destroyOnClose>
   <Space direction="vertical" style={{width:'100%'}}>{error&&<Alert type="error" message={error}/>}<CategorySelector value={draft} onChange={setDraft}/><Input aria-label="分类核对依据" placeholder="核对依据" value={basis} onChange={e=>setBasis(e.target.value)}/><span>保留诉求性质、来源分类和已有修订记录。</span></Space>
  </Modal>
  <Modal title="分类修订历史" open={history!==null} onCancel={()=>setHistory(null)} footer={null}><Table rowKey="revisionId" pagination={false} dataSource={history??[]} columns={[{title:'大类',dataIndex:'majorCode'},{title:'小类',dataIndex:'minorCode'},{title:'字典版本',dataIndex:'dictionaryVersion'},{title:'编辑版本',dataIndex:'editVersion'}]}/></Modal>
 </Space>;
}
