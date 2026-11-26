import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Col,Collapse,Empty,Result,Row,Space,Statistic,Table,Tabs,Tag,Typography} from 'antd';
import ReactECharts from 'echarts-for-react';
import type {EChartsOption} from 'echarts';
import StatisticsFilters,{initialStatisticsDraft,getStatisticsDraftError,type StatisticsDraft} from './StatisticsFilters';
import StatisticsDetailsModal from './StatisticsDetailsModal';
import {getTenderStatistics} from '../api/tenderStatistics';
import {useAppStore} from '../stores/appStore';
import type {StatisticsDataset,StatisticsQuery,DimensionBucket,PeriodComparison} from '../types/statistics';
import type {TenderStatisticsResult,TenderServiceStatistics} from '../types/tenderStatistics';
const palette=['#3277ed','#13a89e'];
const pct=(c:PeriodComparison|undefined)=>c?.changePercent==null?'—':(c.changePercent>0?'+':'')+c.changePercent+'%';
const bucket=(b:DimensionBucket)=>b.dimension==='category'?{dimension:b.dimension,code:b.code,level:b.level,dictionaryVersion:b.dictionaryVersion}:{dimension:b.dimension,code:b.code};
const dimensions=(points:{name:string;count:number}[],type:'bar'|'line'='bar'):EChartsOption=>({animationDuration:250,color:palette,aria:{enabled:true},tooltip:{trigger:'axis'},grid:{top:30,left:24,right:20,bottom:46,containLabel:true},xAxis:{type:'category',data:points.map(p=>p.name),axisLabel:{hideOverlap:true,interval:0,rotate:points.length>6?25:0}},yAxis:{type:'value',name:'诉求量（件）',minInterval:1},dataZoom:points.length>12?[{type:'inside'},{type:'slider',height:16,bottom:0}]:[],series:[{type,data:points.map(p=>p.count),barMaxWidth:44,smooth:type==='line'}]});
function Chart({option,onClick,label}:{option:EChartsOption;onClick?:(index:number)=>void;label:string}){return <div role="img" aria-label={label}><ReactECharts option={option} notMerge style={{height:300}} onEvents={onClick?{click:(p:{dataIndex:number})=>onClick(p.dataIndex)}:{}}/></div>;}
function ServicePanel({data,anchorDate,detail}:{data:TenderServiceStatistics;anchorDate:string;detail:(q:StatisticsQuery,title:string)=>void}){
 const [period,setPeriod]=useState('year');const selected=data.periods.find(p=>p.key===period)??data.periods[0];
 return <>
  <Typography.Paragraph type="secondary">以下年、季、月指标以 {anchorDate} 为统计截止日；其他图表和排名采用上方选定期间。年度环比按上年同期累计比较。</Typography.Paragraph>
  <Row gutter={[16,16]}>{data.periods.filter(p=>p.key!=='yesterday').map(p=><Col xs={24} sm={12} xl={6} key={p.key}><Card><Statistic title={p.label} value={p.total} suffix="件"/>{p.demoCount>0&&<Tag color="orange">含演示 {p.demoCount} 件</Tag>}<Typography.Paragraph type="secondary" style={{fontSize:12,margin:'8px 0'}}>{p.query.from} 至 {p.query.to}</Typography.Paragraph><Space wrap>{p.comparisons.map(c=><Typography.Text key={c.kind} title={c.reason??`${c.from} 至 ${c.to}：${c.baselineCount}件`}>{c.kind==='yoy'?'同比':'环比'} {pct(c)}</Typography.Text>)}</Space><div style={{marginTop:8}}><Button size="small" onClick={()=>detail(p.query,data.title+' · '+p.label)}>查看明细</Button></div></Card></Col>)}</Row>
  <Space style={{margin:'16px 0'}} wrap><Tag color="blue">选定期间 {data.total} 件</Tag><Typography.Text>{data.query.from} 至 {data.query.to}</Typography.Text><Button onClick={()=>detail(data.query,data.title+' · 选定期间明细')}>查看全部明细</Button>{data.sourceTimeFallbackCount>0&&<Tag color="gold">其中 {data.sourceTimeFallbackCount} 件使用接收时间</Tag>}</Space>
  <Row gutter={[16,16]}>
   <Col xs={24} xl={12}><Card title="按诉求类型统计" extra={<Typography.Text type="secondary">点击柱形查看明细</Typography.Text>}>{data.categories.length?<Chart label="诉求类型柱状图" option={dimensions(data.categories)} onClick={i=>{const b=data.categories[i];if(b)detail({...data.query,bucket:bucket(b)},data.title+' · '+b.name);}}/>:<Empty description="选定期间无诉求类型数据"/>}<Table size="small" pagination={false} rowKey={r=>JSON.stringify(bucket(r))} dataSource={data.categories} columns={[{title:'诉求类型',dataIndex:'name',render:(v:string,r)=><Button type="link" onClick={()=>detail({...data.query,bucket:bucket(r)},data.title+' · '+v)}>{v}</Button>},{title:'数量',dataIndex:'count',width:85}]}/></Card></Col>
   <Col xs={24} xl={12}><Card title="诉求类型月度统计" extra={<Typography.Text type="secondary">采用当前类型筛选，可点月份</Typography.Text>}><Chart label="每月诉求数量折线图" option={dimensions(data.months.map(m=>({name:m.key,count:m.count})),'line')} onClick={i=>{const m=data.months[i];if(m)detail(m.query,data.title+' · '+m.key);}}/></Card></Col>
  </Row>
  <Card title="本年、本季、本月各类型同比环比" style={{marginTop:16}}><Tabs activeKey={period} onChange={setPeriod} items={data.periods.filter(p=>p.key!=='yesterday').map(p=>({key:p.key,label:p.label.replace('诉求量','')}))}/><Table size="small" pagination={false} rowKey={r=>JSON.stringify(bucket(r.bucket))} dataSource={selected.types} columns={[{title:'诉求类型',render:(_,r)=><Button type="link" onClick={()=>detail({...selected.query,bucket:bucket(r.bucket)},data.title+' · '+selected.label+' · '+r.bucket.name)}>{r.bucket.name}</Button>},{title:'本期数量',dataIndex:'count'},{title:'同比',render:(_,r)=>pct(r.comparisons.find(c=>c.kind==='yoy'))},{title:'环比',render:(_,r)=>pct(r.comparisons.find(c=>c.kind==='mom'))},{title:'说明',render:(_,r)=>r.comparisons.filter(c=>c.reason).map(c=>c.reason).join('；')||'按相同期间比较'}]}/></Card>
 </>;
}
export default function TenderStatisticsPanel({initialDataset}:{initialDataset:StatisticsDataset}){
 const user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token);const permissions=user?.permissions??[];
 const allowed:StatisticsDataset[]=(['ledger','analysis'] as const).filter(d=>user&&!user.mustChangePassword&&permissions.includes('statistics.read')&&permissions.includes(d==='ledger'?'dashboard.read':'analysis.read'));
 const [draft,setDraft]=useState<StatisticsDraft>(()=>initialStatisticsDraft(initialDataset)),[query,setQuery]=useState<StatisticsQuery>(()=>initialStatisticsDraft(initialDataset) as StatisticsQuery),[refresh,setRefresh]=useState(0),[tab,setTab]=useState('gas');
 const [state,setState]=useState<{key:string;data?:TenderStatisticsResult;error?:string}>(),[detail,setDetail]=useState<{query:StatisticsQuery;title:string}|null>(null);
 const authKey=JSON.stringify([token,user?.userId,user?.authorizationVersion,user?.mustChangePassword,permissions]);
 const key=JSON.stringify([authKey,query,refresh]),current=state?.key===key?state:undefined,seq=useRef(0),currentKey=useRef(key);currentKey.current=key;
 const canQuery=allowed.includes(query.dataset),canDetail=permissions.includes('complaint.read');
 useEffect(()=>{const n=++seq.current;setDetail(null);if(!canQuery)return;void getTenderStatistics(query).then(data=>{if(n===seq.current&&currentKey.current===key)setState({key,data});}).catch(e=>{if(n===seq.current&&currentKey.current===key)setState({key,error:e instanceof Error?e.message:'统计加载失败'});});return()=>{seq.current++;};},[key,canQuery]);
 const open=(q:StatisticsQuery,title:string)=>{setDetail({query:q,title});};
 if(!allowed.length)return <Result status="403" title="当前账号无统计查询权限" subTitle="请联系管理员开通对应权限。"/>;
 const data=current?.data;
 const activeTab=data?.services.some(service=>service.businessType===tab)?tab:data?.services[0]?.businessType;
 return <div><Typography.Title level={3}>{initialDataset==='analysis'?'诉求数据分析':'诉求统计'}</Typography.Title>
  <StatisticsFilters value={draft} onChange={setDraft} onApply={()=>{if(!getStatisticsDraftError(draft,allowed))setQuery({...draft,projection:draft.projection as StatisticsQuery['projection'],bucket:undefined});}} allowed={allowed} loading={!current&&canQuery}/>
  <Space style={{margin:'4px 0 16px'}} wrap><Button onClick={()=>setRefresh(v=>v+1)} loading={!current&&canQuery}>刷新统计</Button><Typography.Text type="secondary">按当前账号授权范围统计，图表与明细使用相同条件。</Typography.Text></Space>
  {!canDetail&&<Alert type="info" message="当前账号可查看统计，尚无诉求明细查询权限。" style={{marginBottom:16}}/>}
  {!canQuery?<Alert type="warning" message="请选择有权限的数据集并应用筛选。"/>:current?.error?<Alert type="error" showIcon message="统计加载失败" description={current.error} action={<Button onClick={()=>setRefresh(v=>v+1)}>重试</Button>}/>:!data?<Card loading/>:<>
   <Space wrap style={{marginBottom:16}}><Tag>{query.dataset==='ledger'?'诉求总账':'分析库'}</Tag><Tag>{query.projection==='current'?'最新有效信息':'入库时保存的信息'}</Tag><Typography.Text type="secondary">数据截止：{new Date(data.dataCutoffAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</Typography.Text></Space>
   {query.comparisonPolicyId==='procurement-source-completed-v2'&&<Alert type="info" showIcon style={{marginBottom:16}} message="标书采购范围：来源明确办结的供水供气诉求" description={<>{data.timeBasis}。关闭或平台闭环不能代替办结；旧入库快照缺来源证据时排除。{Object.entries(data.excludedByReason??{}).map(([reason,count])=><div key={reason}>{reason}：{count} 条未计入</div>)}</>}/>}
   {(data.demoCount>0||data.extendedDemoCount>0)&&<Alert type="warning" showIcon message={`本页统计包含演示数据：选定期间 ${data.demoCount} 件，年季月及比较扩展范围 ${data.extendedDemoCount} 件。`} description="演示记录按其真实标识计入当前账本统计，各期间卡另列演示件数；请勿将这些合计用于真实业务结论。" style={{marginBottom:16}}/>}
   {data.partial&&<Alert type="warning" showIcon message={`有 ${data.dateFilterUnavailableCount} 件业务日期未知，未计入日期统计；比较不完整。`} style={{marginBottom:16}}/>}
   <Card title="整体诉求量" extra={<Space><Tag color="blue">选定期间 {data.total} 件</Tag><Button onClick={()=>open(query,'整体诉求明细')}>查看明细</Button></Space>} style={{marginBottom:16}}><Typography.Paragraph type="secondary">{query.comparisonPolicyId==='procurement-source-completed-v2'?'整体指标仅含来源明确办结的供水、供气诉求':'整体指标采用当前全部业务筛选（未限制业务时含供水、燃气、液化气等）'}；截至 {data.anchorDate}。年度环比按上年同期累计比较。</Typography.Paragraph><Row gutter={[16,16]}>{data.periods.filter(p=>p.key!=='yesterday').map(p=><Col xs={24} sm={12} xl={6} key={p.key}><Statistic title={p.label} value={p.total} suffix="件"/><Space wrap style={{margin:'8px 0'}}>{p.comparisons.map(c=><Typography.Text key={c.kind} title={c.reason??`${c.from} 至 ${c.to}：${c.baselineCount}件`}>{c.kind==='yoy'?'同比':'环比'} {pct(c)}</Typography.Text>)}</Space>{p.demoCount>0&&<div><Tag color="orange">含演示 {p.demoCount} 件</Tag></div>}<div><Button size="small" onClick={()=>open(p.query,'整体 · '+p.label)}>查看明细</Button></div></Col>)}</Row></Card>
   <Tabs activeKey={activeTab} onChange={setTab} items={data.services.map(service=>({
    key:service.businessType,
    label:service.businessType==='gas'?'供气服务':'供水服务',
    children:<ServicePanel data={service} anchorDate={data.anchorDate} detail={open}/>,
   }))}/>
   <Collapse style={{marginTop:16}} items={[{key:'basis',label:'统计口径与数据说明',children:<Typography.Paragraph>采用上海时区；{query.comparisonPolicyId==='procurement-source-completed-v2'?'仅使用来源录入时间，缺失时排除，不回退平台接收时间。':'优先使用来源填报时间，缺少或无效时回退平台接收时间。'}同比及环比采用日历期间口径，基期为零时保留不可比。年季月指标截至所选结束日；本看板年度环比按上年同期累计比较，与年度同比一致。未分类诉求按其实际状态统计。</Typography.Paragraph>}]} />
  </>}
  <StatisticsDetailsModal query={detail?.query??null} title={detail?.title} onClose={()=>setDetail(null)}/>
 </div>;
}
