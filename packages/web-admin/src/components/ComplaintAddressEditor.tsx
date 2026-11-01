import React, {useEffect, useState} from 'react';
import {Alert, Button, Modal, Spin} from 'antd';
import type {ComplaintDetail, CorrectionItem} from '../types/api';
import {listComplaintCorrections} from '../api/corrections';
import {useWriteAccess} from '../stores/roleAccess';
import LocationReviewPanel from './LocationReviewPanel';

export default function ComplaintAddressEditor({detail, initialOpen=false, onSaved}: {
  detail: ComplaintDetail; initialOpen?: boolean; onSaved: () => void;
}) {
  const access=useWriteAccess('complaint.correct');
  const [open,setOpen]=useState(initialOpen),[items,setItems]=useState<CorrectionItem[]|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    if(!open||!access.can)return;
    let alive=true;
    setItems(null);setError('');
    void listComplaintCorrections(detail.complaintId).then(value=>{if(alive)setItems(value);})
      .catch(e=>{if(alive)setError(e.message||'地址信息加载失败');});
    return()=>{alive=false;};
  },[open,detail.complaintId,detail.editVersion,access.can]);
  if(!access.can)return null;
  return <>
    <Button onClick={()=>setOpen(true)}>完善地址</Button>
    <Modal title="完善地址" open={open} onCancel={()=>setOpen(false)} footer={null} width="min(1000px, 96vw)" destroyOnClose>
      {error?<Alert type="error" message={error}/>:items===null?<Spin/>:
        <LocationReviewPanel detail={detail} items={items} singleRecord
          onSaved={()=>{setOpen(false);onSaved();}} onDeferred={()=>{setOpen(false);onSaved();}}/>}
    </Modal>
  </>;
}
