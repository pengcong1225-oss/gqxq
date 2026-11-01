import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Input,Modal,Space} from 'antd';
import {useAppStore} from '../stores/appStore';
import {useWriteAccess} from '../stores/roleAccess';
import {closeComplaint,listComplaintCorrections} from '../api/corrections';
import type {ComplaintDetail} from '../types/api';

function Confirmation({detail,onSaved}:{detail:ComplaintDetail;onSaved:()=>void}) {
  const access=useWriteAccess('complaint.close');
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const [open,setOpen]=useState(false),[basis,setBasis]=useState(''),[pending,setPending]=useState<number|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const ready=access.can&&!detail.closedInSystem&&detail.reportingStatusCode==='approved';
  useEffect(()=>{
    if(!open||!ready)return;
    let alive=true;setPending(null);setError('');
    void listComplaintCorrections(detail.complaintId).then(items=>{
      if(alive)setPending(items.filter(item=>!['confirmed','rejected'].includes(item.status)).length);
    }).catch(e=>{if(alive)setError(e.message||'纠偏状态读取失败');});
    return()=>{alive=false;};
  },[open,ready,detail.complaintId]);
  if(!access.can||detail.closedInSystem)return null;
  const save=async()=>{
    if(!ready||pending!==0||!basis.trim()||busy)return;
    setBusy(true);setError('');
    try{await closeComplaint(detail.complaintId,{basis:basis.trim()});if(alive.current){setOpen(false);onSaved();}}
    catch(e){if(alive.current)setError((e as Error).message||'确认办结失败');}
    finally{if(alive.current)setBusy(false);}
  };
  return <>
    <Button style={{marginTop:12}} disabled={!ready} onClick={()=>{setBasis('');setOpen(true);}}>确认本系统办结</Button>
    <Modal title="确认本系统办结" open={open&&ready} onCancel={()=>setOpen(false)} onOk={()=>void save()} okText="确认办结" confirmLoading={busy} okButtonProps={{disabled:pending!==0||!basis.trim()}}>
      <Space direction="vertical" style={{width:'100%'}}>
        <Alert type="info" showIcon message="最终审批通过、全部纠偏处理完成后，由人工确认办结" description="本次确认留存确认人、时间和依据，不改写来源办理状态。"/>
        {pending===null?<span>正在核对纠偏状态…</span>:pending>0?<Alert type="warning" message={'仍有 '+pending+' 项纠偏未处理，请先完成整体纠偏'}/>:<span>全部纠偏项已处理。</span>}
        {error&&<Alert type="error" message={error}/>}
        <Input.TextArea aria-label="本系统办结依据" placeholder="填写办结确认依据" maxLength={500} value={basis} onChange={e=>setBasis(e.target.value)}/>
      </Space>
    </Modal>
  </>;
}

export default function ComplaintClosureConfirmation(props:{detail:ComplaintDetail;onSaved:()=>void}) {
  const token=useAppStore(s=>s.token),user=useAppStore(s=>s.userInfo);
  const key=JSON.stringify([props.detail.complaintId,token,user?.userId,user?.authorizationVersion,user?.roles,user?.permissions,user?.mustChangePassword]);
  return <Confirmation key={key} {...props}/>;
}
