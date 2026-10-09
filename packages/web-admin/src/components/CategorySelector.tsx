import React,{useEffect,useState} from 'react';
import {Alert,Space} from 'antd';
import {getCategoryOptions} from '../api/masterData';
import type {CategoryRef,DictionaryItem} from '../types/masterData';
export default function CategorySelector({value,onChange,disabled=false}:{value?:CategoryRef|null;onChange:(ref:CategoryRef|null)=>void;disabled?:boolean}) {
 const [data,setData]=useState<{dictionaryVersion:string;items:DictionaryItem[]}|null>(null);const [error,setError]=useState('');
 useEffect(()=>{let active=true;getCategoryOptions().then(v=>{if(active){setData(v);setError('');}}).catch(e=>{if(active)setError(e.message??'分类加载失败');});return()=>{active=false;};},[]);
 const majors=data?.items.filter(i=>!i.parentCode)??[];const minors=data?.items.filter(i=>i.parentCode===value?.majorCode)??[];
 const style={minWidth:160,height:32,border:'1px solid #d9d9d9',borderRadius:6,background:'#fff'};
 return <Space direction="vertical" style={{width:'100%'}}>
  {error&&<Alert type="error" message={error}/>}
  <Space wrap>
   <select aria-label="正式大类" style={style} value={value?.majorCode??''} disabled={disabled||!data||!!error} onChange={e=>onChange(e.target.value?{majorCode:e.target.value,minorCode:null,dictionaryVersion:data!.dictionaryVersion}:null)}>
    <option value="">请选择大类</option>{value?.majorCode&&!majors.some(i=>i.code===value.majorCode)&&<option value={value.majorCode} disabled>历史分类 {value.majorCode}</option>}{majors.map(i=><option key={i.code} value={i.code}>{i.label}</option>)}
   </select>
   <select aria-label="正式小类" style={style} value={value?.minorCode??''} disabled={disabled||!value?.majorCode||!data||!!error} onChange={e=>onChange({majorCode:value!.majorCode,minorCode:e.target.value||null,dictionaryVersion:data!.dictionaryVersion})}>
    <option value="">不选小类</option>{value?.minorCode&&!minors.some(i=>i.code===value.minorCode)&&<option value={value.minorCode} disabled>历史分类 {value.minorCode}</option>}{minors.map(i=><option key={i.code} value={i.code}>{i.label}</option>)}
   </select>
  </Space>
  {data&&data.items.length===0&&<span>暂无启用的正式分类，请联系字典管理员。</span>}
  {value&&<span>分类字典版本：{value.dictionaryVersion}</span>}
 </Space>;
}
