import {useSearchParams} from 'react-router-dom';
import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Input,Select,Space,Spin,Tabs,Tag,Typography,message} from 'antd';
import {useAppStore} from '../stores/appStore';
import {statisticsToday} from '../components/StatisticsFilters';
import {downloadSupportReport,getSupportData,getSupportWarnings,putSupportWarnings,previewSupport,importSupport,type ImportPreview} from '../tenderSupport/api';
import type {TenderDataset,SupportWarningConfig,SupportWarningRule} from '../tenderSupport/types';
import SupportWarningRules from '../tenderSupport/SupportResearch';
const saveJson=(name:string,data:unknown)=>{const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
export default function TenderSupportView(){
 const [params,setParams]=useSearchParams();
 const activeTab=params.get('tab')==='rules'?'rules':'data';
 const user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token),permissions=user?.permissions??[];
 const auth=JSON.stringify([token,user?.userId,user?.authorizationVersion,user?.mustChangePassword,permissions]);
 const canRead=!!user&&!user.mustChangePassword&&['statistics.read','complaint.read'].every(x=>permissions.includes(x));
 const canImport=canRead&&permissions.includes('masterdata.import'),canManage=canRead&&permissions.includes('heatmap.manage');
 const [mode,setMode]=useState<'simulation'|'real'>('simulation'),[from,setFrom]=useState(statisticsToday().slice(0,4)+'-01-01'),[to,setTo]=useState(statisticsToday()),[refresh,setRefresh]=useState(0);
 const [state,setState]=useState<{key:string;data?:TenderDataset;config?:SupportWarningConfig;error?:string}>(),[pending,setPending]=useState<{dataset:unknown;preview:ImportPreview}|null>(null),[busy,setBusy]=useState(false);
 const key=JSON.stringify([auth,mode,refresh]),current=state?.key===key?state:undefined,seq=useRef(0),currentKey=useRef(key);currentKey.current=key;
 useEffect(()=>{setPending(null);setBusy(false);const n=++seq.current;if(!canRead)return;void Promise.all([getSupportData(mode),getSupportWarnings(mode)]).then(([data,config])=>{if(n===seq.current)setState({key,data,config});}).catch(e=>{if(n===seq.current)setState({key,error:e.message??'加载失败'});});return()=>{seq.current++;};},[key,canRead]);
 const saveRules=async(rules:SupportWarningRule[])=>{if(!current?.config)throw Error('请先加载配置');const expected=key;const config=await putSupportWarnings(mode,{revision:current.config.revision,rules});if(currentKey.current===expected)setState(s=>s?.key===expected?{...s,config}:s);};
 const fileChanged=async(file?:File)=>{if(!file)return;const expected=key;setPending(null);setBusy(true);try{if(file.size>15*1024*1024)throw Error('数据包不能超过15MB');const dataset=JSON.parse(await file.text());if(currentKey.current!==expected)return;const preview=await previewSupport(dataset);if(currentKey.current===expected)setPending({dataset,preview});}catch(e){if(currentKey.current===expected)message.error(e instanceof Error?e.message:'文件校验失败');}finally{if(currentKey.current===expected)setBusy(false);}};
 const applyImport=async()=>{if(!pending)return;const expected=key;setBusy(true);try{await importSupport(pending.dataset,pending.preview.expectedRevision);if(currentKey.current===expected){message.success('真实专题数据已导入并保留版本记录');setMode('real');setRefresh(n=>n+1);setPending(null);}}catch(e){if(currentKey.current===expected)message.error(e instanceof Error?e.message:'导入失败');}finally{if(currentKey.current===expected)setBusy(false);}};
 const download=async(format:'docx'|'xlsx')=>{const expected=key;setBusy(true);try{const blob=await downloadSupportReport(mode,from,to,format);if(currentKey.current!==expected)return;if(!(blob instanceof Blob)||!blob.size)throw Error('报告内容为空');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(mode==='simulation'?'模拟数据-':'真实数据-')+'专题统计报告.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message.success('专题报告已下载');}catch(e){if(currentKey.current===expected)message.error(e instanceof Error?e.message:'下载失败');}finally{if(currentKey.current===expected)setBusy(false);}};
 const data=current?.data,config=current?.config,dateError=!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||from>to||to>statisticsToday();
 if(!canRead)return <Alert type="warning" message="专题数据管理需要统计及诉求明细查询权限"/>;
 return <div><Typography.Title level={3}>专题数据与预警管理</Typography.Title>
 <Space wrap style={{marginBottom:16}}>
  <label>数据来源 <Select aria-label="专题数据来源" value={mode} onChange={setMode} style={{width:210}} options={[{value:'simulation',label:'模拟数据'},{value:'real',label:'真实专题数据'}]}/></label>
  <Button onClick={()=>setRefresh(n=>n+1)}>刷新数据</Button>
 </Space>
 <Alert
  showIcon
  type={mode==='simulation'?'warning':'info'}
  message={mode==='simulation'?'模拟数据专区：边界、小区、管线、事件、评价、办结和户数均为模拟':'真实专题数据：仅使用已导入并通过校验的数据'}
  description={mode==='simulation'?'当前数据和报告用于演示。导入校验通过后可替换真实专题数据。':'专题数据按独立版本管理，真实诉求总账使用自身数据。'}
  style={{marginBottom:16}}
 />
 {current?.error?<Alert type="error" message={current.error}/>:!data||!config?<Spin/>:<>
 <Space style={{marginBottom:16}} wrap><Tag color={mode==='simulation'?'orange':'green'}>{data.sourceLabel}</Tag><Tag>版本 {data.revision}</Tag></Space>
 <Tabs activeKey={activeTab} onChange={tab=>setParams({tab})} destroyOnHidden items={[
 {key:'data',label:'数据接入与替换',children:<Card title="真实数据接入"><Typography.Paragraph>下载结构模板，填入企业、行政网格、小区、诉求及办理评价、停供改造事件、管线。坐标统一WGS84；时间使用带时区ISO格式。先校验预览，再整包替换真实专题版本；原版本保留，模拟数据不会写入真实诉求总账。</Typography.Paragraph><Space wrap><Button onClick={()=>saveJson('专题真实数据模板.json',{schemaVersion:1,mode:'real',revision:0,sourceLabel:'请填写真实来源单位及批次',updatedAt:new Date().toISOString(),grids:[],communities:[],enterprises:[],complaints:[],events:[],pipelines:[]})}>下载空白模板</Button><Button onClick={()=>saveJson(`专题${mode==='simulation'?'模拟':'真实'}数据-v${data.revision}.json`,data)}>导出当前数据及字段示例</Button></Space><Typography.Paragraph style={{marginTop:16}}>字段说明：grids=网格（ring闭合边界）；communities=小区（gridId、households）；enterprises=企业（businessType、households）；complaints=诉求（occurredAt、completedAt、evaluation、gridId、communityId、scenario）；events=事件（kind、gridIds、startsAt、endsAt、households、workers、reason、area、plan、housing）；pipelines=管线（path折线）。编号必须唯一且引用存在。评价为satisfied/unsatisfied/unevaluated；未办结不能有结果评价。场景winter/summer/planned/installation/other。真实数据不能使用SIM-编号。</Typography.Paragraph>
 {['report.read','report.generate','report.download'].every(p=>permissions.includes(p))&&<Card size="small" title="导出专题报告" style={{margin:'16px 0'}}>
  <Space wrap>
   <label>开始日期 <Input type="date" aria-label="专题开始日期" value={from} onChange={e=>setFrom(e.target.value)}/></label>
   <label>结束日期 <Input type="date" aria-label="专题结束日期" value={to} max={statisticsToday()} onChange={e=>setTo(e.target.value)}/></label>
   <Button disabled={busy||dateError} onClick={()=>void download('docx')}>导出专题Word报告</Button>
   <Button disabled={busy||dateError} onClick={()=>void download('xlsx')}>导出专题Excel报告</Button>
  </Space>
  {dateError&&<Alert type="error" message="请选择有效的日期区间，结束日期不能晚于今天"/>}
 </Card>}
 {canImport?<><input aria-label="上传真实专题数据JSON" type="file" accept="application/json,.json" disabled={busy} onChange={e=>{void fileChanged(e.target.files?.[0]);e.target.value='';}}/>{busy&&<Spin/>}{pending&&<Card size="small" title="校验通过，待替换"><div>来源：{pending.preview.sourceLabel}；当前真实版本：{pending.preview.expectedRevision}</div><pre>{JSON.stringify(pending.preview.counts,null,2)}</pre><Button type="primary" loading={busy} onClick={()=>void applyImport()}>替换真实专题数据</Button></Card>}</>:<Alert type="info" message="上传替换需要主数据导入权限及全域数据范围"/>}</Card>},
 {key:'rules',label:'预警规则配置',children:<SupportWarningRules key={key} config={config} onSaveRules={saveRules} canManage={canManage}/>},
 ]}/></>}
 </div>;
}
