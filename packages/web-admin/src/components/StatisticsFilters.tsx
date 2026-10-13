import {chineseLabel} from '../utils/chineseDisplay';
import React,{useEffect,useState} from 'react';
import {Alert,Button,Collapse,Input,Select,Space,Typography} from 'antd';
import {useAppStore} from '../stores/appStore';
import {getCategoryOptions} from '../api/masterData';
import {getDictItems} from '../api/dicts';
import {listEnterpriseOptions} from '../api/enterprises';
import type {DictionaryItem} from '../types/masterData';
import type {StatisticsQuery,PeriodKind,StatisticsDataset,StatisticsProjection} from '../types/statistics';
export type StatisticsDraft=Omit<StatisticsQuery,'projection'>&{projection:StatisticsProjection|''};
export function statisticsToday(){return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});}
export function initialStatisticsDraft(dataset:StatisticsDataset):StatisticsDraft {
 const to=statisticsToday();const d=new Date(to+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-29);
 return {dataset,projection:dataset==='ledger'?'current':'',periodKind:'custom',from:d.toISOString().slice(0,10),to,comparisonPolicyId:'candidate-calendar-v1'};
}
export function statisticsDateError(value:Pick<StatisticsDraft,'from'|'to'>){
 const valid=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
 if(!valid(value.from)||!valid(value.to))return '请填写有效的开始日期和结束日期。';
 if(Number(value.from.slice(0,4))<1000||Number(value.to.slice(0,4))<1000)return '日期年份不能早于1000年。';
 if(value.from>value.to)return '开始日期不能晚于结束日期。';
 if(value.to>statisticsToday())return '结束日期不能晚于今天。';
 if((Date.parse(value.to)-Date.parse(value.from))/86400000+1>3660)return '统计日期范围最多3660天，请缩短期间。';
 return '';
}
export function getStatisticsDraftError(value:StatisticsDraft,allowed:StatisticsDataset[]){return statisticsDateError(value)||(!allowed.includes(value.dataset)?'当前账号无此统计范围的查询权限。':!value.projection?'请选择统计取值方式。':'');}
type Option={value:string;label:string};
export function useStatisticsOptions(includeCategories=true){
 const user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token);
 const [enterpriseSearch,setEnterpriseSearch]=useState('');
 const key=JSON.stringify([enterpriseSearch,token,user?.userId,user?.authorizationVersion,user?.permissions,user?.mustChangePassword,includeCategories]);
 const [retry,setRetry]=useState(0),[state,setState]=useState<{key:string;categories:DictionaryItem[];districts:Option[];enterprises:Option[];errors:string[];loading:boolean}|null>(null);
 useEffect(()=>{let active=true;const permissions=user&&!user.mustChangePassword?user.permissions:[];
 const errors:string[]=[];if(!permissions.includes('dict.read'))errors.push('当前账号未开通分类、区县选项查看权限，请联系管理员。');if(!permissions.includes('enterprise.read'))errors.push('当前账号未开通企业选项查看权限，请联系管理员。');
 setState({key,categories:[],districts:[],enterprises:[],errors,loading:true});
 void Promise.allSettled([permissions.includes('dict.read')&&includeCategories?getCategoryOptions():Promise.resolve({items:[]}),permissions.includes('dict.read')?getDictItems('district'):Promise.resolve([]),permissions.includes('enterprise.read')?listEnterpriseOptions({keyword:enterpriseSearch}):Promise.resolve({content:[]})]).then(results=>{
 if(!active)return;
 results.forEach((r,i)=>{if(r.status==='rejected')errors.push(['分类','区县','企业'][i]+'选项加载失败：'+(r.reason instanceof Error?r.reason.message:String(r.reason)));});
 const [c,d,e]=results;
 setState({key,categories:c.status==='fulfilled'?c.value.items:[],districts:d.status==='fulfilled'?d.value:[],enterprises:e.status==='fulfilled'?e.value.content.map(item=>({value:item.enterpriseCode,label:item.enterpriseName+'（'+item.enterpriseCode+'）'})):[],errors,loading:false});
 });return()=>{active=false;};},[key,retry]);
 const current=state?.key===key?state:null;
 return {categories:current?.categories??[],districts:current?.districts??[],enterprises:current?.enterprises??[],errors:current?.errors??[],loading:current?.loading??true,searchEnterprise:setEnterpriseSearch,retry:()=>setRetry(n=>n+1)};
}
export const statisticsFieldStyle:React.CSSProperties={display:'inline-flex',flexDirection:'column',gap:4,minWidth:160};
export default function StatisticsFilters({value,onChange,onApply,allowed,loading,hideApply=false}:{value:StatisticsDraft;onChange:(v:StatisticsDraft)=>void;onApply:()=>void;allowed:StatisticsDataset[];loading:boolean;hideApply?:boolean}){
 const options=useStatisticsOptions();const dateError=statisticsDateError(value);
 const update=(v:Partial<StatisticsDraft>)=>onChange({...value,...v,bucket:undefined});
 const preset=(kind:PeriodKind)=>{const today=statisticsToday();const month=Number(today.slice(5,7));const from=kind==='year'?today.slice(0,4)+'-01-01':kind==='quarter'?today.slice(0,4)+'-'+String(Math.floor((month-1)/3)*3+1).padStart(2,'0')+'-01':kind==='month'?today.slice(0,7)+'-01':value.from;update({periodKind:kind,from,to:today});};
 return <div style={{padding:16,background:'#fafafa',borderRadius:8,marginBottom:16}}><Space wrap align="end">
  <label style={statisticsFieldStyle}>统计范围<Select aria-label="统计数据集" value={value.dataset} onChange={dataset=>update({dataset,projection:dataset==='ledger'?'current':''})} options={allowed.map(d=>({value:d,label:d==='ledger'?'全部诉求':'已入分析库诉求'}))}/></label>
  {value.dataset==='analysis'?<label style={{...statisticsFieldStyle,minWidth:250}}>统计取值方式<Select aria-label="统计取值方式" placeholder="请选择统计取值方式" value={value.projection||undefined} onChange={projection=>update({projection})} options={[{value:'current',label:'按最新信息统计'},{value:'entry_snapshot',label:'按入库时保存的信息统计'}]}/></label>:<Typography.Text>按最新信息统计</Typography.Text>}
  <label style={statisticsFieldStyle}>统计期间<Select aria-label="统计期间" value={value.periodKind} onChange={preset} options={[{value:'custom',label:'自定义'},{value:'month',label:'本月截至今日'},{value:'quarter',label:'本季度截至今日'},{value:'year',label:'本年截至今日'}]}/></label>
  <label style={statisticsFieldStyle}>开始日期<Input aria-label="开始日期" type="date" value={value.from} max={statisticsToday()} onChange={e=>update({from:e.target.value,periodKind:'custom'})}/></label>
  <label style={statisticsFieldStyle}>结束日期<Input aria-label="结束日期" type="date" value={value.to} max={statisticsToday()} onChange={e=>update({to:e.target.value,periodKind:'custom'})}/></label>
  <label style={statisticsFieldStyle}>业务类型<Select aria-label="业务类型" allowClear placeholder="全部" value={value.businessType} onChange={businessType=>update({businessType})} options={['water','gas','lpg'].map(code=>({value:code,label:chineseLabel(code,'business_type')}))}/></label>
 </Space>
 <Collapse ghost style={{marginTop:12}} items={[{key:'more',label:'更多筛选（分类、企业、区县、网格）',children:<><Space wrap align="end">
  <label style={statisticsFieldStyle}>诉求大类<Select aria-label="诉求大类" showSearch optionFilterProp="label" allowClear placeholder="全部" loading={options.loading} value={value.majorCode} options={options.categories.filter(i=>!i.parentCode).map(i=>({value:i.code,label:i.label}))} onChange={majorCode=>update({majorCode,minorCode:undefined})}/></label>
  <label style={statisticsFieldStyle}>诉求小类<Select aria-label="诉求小类" showSearch optionFilterProp="label" allowClear placeholder="请先选择大类" disabled={!value.majorCode} value={value.minorCode} options={options.categories.filter(i=>i.parentCode===value.majorCode).map(i=>({value:i.code,label:i.label}))} onChange={minorCode=>update({minorCode})}/></label>
  <label style={statisticsFieldStyle}>企业<Select aria-label="企业" showSearch filterOption={false} onSearch={options.searchEnterprise} allowClear placeholder="全部，可搜索名称" style={{minWidth:230}} loading={options.loading} value={value.enterpriseCode} options={options.enterprises} onChange={enterpriseCode=>update({enterpriseCode})}/></label>
  <label style={statisticsFieldStyle}>区县<Select aria-label="区县" showSearch optionFilterProp="label" allowClear placeholder="全部" loading={options.loading} value={value.districtCode} options={options.districts} onChange={districtCode=>update({districtCode})}/></label>
  <label style={statisticsFieldStyle}>服务网格编码<Input aria-label="服务网格编码" value={value.serviceGridCode??''} maxLength={64} placeholder="可选，按已知网格编码筛选" onChange={e=>update({serviceGridCode:e.target.value.trim()||undefined})}/></label>
 </Space><Collapse ghost items={[{key:'codes',label:'按已知编码筛选',children:<><Typography.Paragraph type="secondary">适用于历史企业、历史分类，或暂无名称选项查看权限时。请输入已知的真实编码；留空表示全部，结果仍按当前账号的数据权限展示。</Typography.Paragraph><Space wrap>{([['enterpriseCode','企业编码'],['majorCode','大类编码'],['minorCode','小类编码'],['districtCode','区县编码']] as const).map(([field,label])=><label key={field} style={statisticsFieldStyle}>{label}<Input aria-label={label} value={value[field]??''} maxLength={64} placeholder="可选，输入已知编码" onChange={e=>update({[field]:e.target.value.trim()||undefined,...(field==='majorCode'?{minorCode:undefined}:{})})}/></label>)}</Space></>}]} />{options.errors.length>0&&<Alert style={{marginTop:12}} showIcon type="warning" message="部分筛选选项不可用" description={options.errors.join(' ')} action={<Button onClick={options.retry}>重试选项</Button>}/>}</>}]}/>
 <Typography.Paragraph type="secondary" style={{margin:'8px 0'}}>日期按北京时间归属，优先使用来源填报日期；缺失时使用接收日期。{value.dataset==='analysis'&&'入库时保存的信息缺失时保留未知，不用后续修改补齐。'}</Typography.Paragraph>
 {dateError&&<Alert type="error" showIcon message={dateError} style={{marginBottom:12}}/>}
 <Space>{!hideApply&&<Button type="primary" loading={loading} disabled={!!dateError||!value.projection||!allowed.includes(value.dataset)} onClick={onApply}>应用统计筛选</Button>}<Button onClick={()=>onChange(initialStatisticsDraft(value.dataset))}>重置筛选</Button></Space>
 </div>;
}
