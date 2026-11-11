import React,{useEffect,useMemo,useState} from 'react';
import {Alert,Button,Card,Col,Empty,Modal,Row,Segmented,Space,Statistic,Table,Tag,Typography} from 'antd';
import ReactECharts from 'echarts-for-react';
import type {EChartsOption} from 'echarts';
import {buildSupportStatistics,type SupportBusinessFilter} from './statisticsModel';
import type {SupportComplaint,TenderDataset} from './types';

export interface SupportStatisticsProps {data:TenderDataset;from:string;to:string;onComplaint:(row:SupportComplaint)=>void}
const percent=(value:number|null)=>value===null?'—':value.toFixed(2)+'%';
const service=(value:string)=>value==='water'?'供水':'供气';
const evaluationName=(value:string)=>value==='satisfied'?'满意':value==='unsatisfied'?'不满意':'未评价';
const localTime=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
function Chart({label,option,onClick}:{label:string;option:EChartsOption;onClick:(index:number,series?:number)=>void}){return <div role="img" aria-label={label}><ReactECharts option={option} notMerge style={{height:285}} onEvents={{click:(event:{dataIndex:number;seriesIndex?:number})=>onClick(event.dataIndex,event.seriesIndex)}}/></div>;}
function pie(name:string,points:{name:string;count:number}[]):EChartsOption{return {animationDuration:200,aria:{enabled:true},color:['#3277ed','#e97657','#a5b2c4'],tooltip:{trigger:'item',formatter:'{b}：{c}件（{d}%）'},legend:{bottom:0},series:[{name,type:'pie',radius:['42%','66%'],center:['50%','43%'],label:{formatter:'{b}\n{c}件'},data:points.map(p=>({name:p.name,value:p.count}))}]};}
function bars(names:string[],values:(number|null)[],unit:string):EChartsOption{return {animationDuration:200,aria:{enabled:true},color:['#3277ed'],tooltip:{trigger:'axis'},grid:{top:32,left:24,right:20,bottom:names.length>6?72:38,containLabel:true},xAxis:{type:'category',data:names,axisLabel:{interval:0,rotate:names.length>6?25:0,hideOverlap:true}},yAxis:{type:'value',name:unit,minInterval:unit==='件'?1:undefined},dataZoom:names.length>10?[{type:'inside'},{type:'slider',height:16,bottom:0}]:[],series:[{type:'bar',barMaxWidth:44,data:values.map(v=>v===null?'-':Math.round(v*100)/100)}]};}

export default function SupportStatistics({data,from,to,onComplaint}:SupportStatisticsProps){
 const [business,setBusiness]=useState<SupportBusinessFilter>('all');
 const [detail,setDetail]=useState<{title:string;rows:SupportComplaint[]}|null>(null);
 const stats=useMemo(()=>buildSupportStatistics(data,from,to,business),[data,from,to,business]);
 useEffect(()=>setDetail(null),[data,from,to,business]);
 const open=(title:string,rows:SupportComplaint[])=>setDetail({title,rows});
 const detailButton=(title:string,rows:SupportComplaint[]) => <Button size="small" onClick={()=>open(title,rows)}>查看明细（{rows.length}）</Button>;
 const companyName=(id:string)=>data.enterprises.find(e=>e.id===id)?.name??`未匹配企业（${id||'空'}）`;
 const communityName=(id:string)=>data.communities.find(c=>c.id===id)?.name??`未关联小区（${id||'空'}）`;
 const evaluationPoints=[{name:'满意',count:stats.evaluation.satisfiedCount,rows:stats.evaluation.satisfiedRows},{name:'不满意',count:stats.evaluation.unsatisfiedCount,rows:stats.evaluation.unsatisfiedRows}];
 const durationOption:EChartsOption={...bars(stats.duration.map(b=>b.name),stats.duration.map(b=>b.count),'件'),color:['#3277ed','#e97657','#a5b2c4'],legend:{top:0},series:[{name:'满意',type:'bar',stack:'duration',barMaxWidth:44,data:stats.duration.map(b=>b.evaluation.satisfiedCount)},{name:'不满意',type:'bar',stack:'duration',data:stats.duration.map(b=>b.evaluation.unsatisfiedCount)},{name:'未评价',type:'bar',stack:'duration',data:stats.duration.map(b=>b.evaluation.missingCount)}]};
 return <Space direction="vertical" size={16} style={{width:'100%'}}>
  <Alert type={data.mode==='simulation'?'warning':'info'} showIcon message={data.mode==='simulation'?'模拟数据 · 满意度与办理时长补充统计':'真实导入数据 · 满意度与办理时长补充统计'} description={`${data.sourceLabel}；版本 ${data.revision}。${data.mode==='simulation'?'以下图表和明细全部为演示样本，不代表实际业务结果；可通过本模块数据导入入口替换真实数据。':'本页仅使用当前已导入数据及其企业、小区主数据。'}`}/>
  <Space wrap><Typography.Text strong>统计业务</Typography.Text><Segmented value={business} options={[{label:'全部',value:'all'},{label:'供水',value:'water'},{label:'供气',value:'gas'}]} onChange={v=>setBusiness(v as SupportBusinessFilter)}/><Tag>{from} 至 {to}（北京时间）</Tag>{detailButton('选定期间全部诉求',stats.rows)}</Space>
  {!stats.rangeValid&&<Alert type="error" message="日期区间无效，请选择有效的起止日期；当前不计算统计。"/>}
  {stats.invalidTimeRows.length>0&&<Alert type="warning" showIcon message={`当前业务有 ${stats.invalidTimeRows.length} 件诉求时间缺失或无效，无法判断是否属于所选期间，未计入统计。`} action={detailButton('日期无法定位的诉求（不计入所选期间）',stats.invalidTimeRows)}/>}
  <Row gutter={[16,16]}>
   <Col xs={24} sm={12} xl={6}><Card><Statistic title="选定期间诉求量" value={stats.rows.length} suffix="件"/>{detailButton('选定期间全部诉求',stats.rows)}</Card></Col>
   <Col xs={24} sm={12} xl={6}><Card><Statistic title={`满意占比 · ${stats.evaluation.satisfiedCount}件`} value={percent(stats.evaluation.satisfiedPercent)}/>{detailButton('已评价 · 满意诉求',stats.evaluation.satisfiedRows)}</Card></Col>
   <Col xs={24} sm={12} xl={6}><Card><Statistic title={`不满意占比 · ${stats.evaluation.unsatisfiedCount}件`} value={percent(stats.evaluation.unsatisfiedPercent)}/>{detailButton('已评价 · 不满意诉求',stats.evaluation.unsatisfiedRows)}</Card></Col>
   <Col xs={24} sm={12} xl={6}><Card><Statistic title="未评价／评价缺失" value={stats.evaluation.missingCount} suffix="件"/>{detailButton('未评价／评价缺失诉求',stats.evaluation.missingRows)}</Card></Col>
  </Row>
  <Typography.Paragraph type="secondary" style={{margin:0}}>满意、不满意占比的分母为已评价 {stats.evaluation.evaluatedCount} 件，排除未评价／缺失 {stats.evaluation.missingCount} 件。无有效分母显示“—”。所有图表和排名可点击查看同口径明细。</Typography.Paragraph>
  <Row gutter={[16,16]}>
   <Col xs={24} xl={12}><Card title="满意与不满意占比" extra={detailButton('已评价诉求',[...stats.evaluation.satisfiedRows,...stats.evaluation.unsatisfiedRows])}>{stats.evaluation.evaluatedCount?<Chart label="已评价诉求满意度占比" option={pie('评价结果',evaluationPoints)} onClick={i=>{const item=evaluationPoints[i];if(item)open(item.name+'诉求',item.rows);}}/>:<Empty description="暂无已评价样本，比例不可计算"/>}</Card></Col>
   <Col xs={24} xl={12}><Card title="不满意诉求的供水／供气构成"><Typography.Paragraph type="secondary">分母为当前业务筛选内全部不满意诉求 {stats.evaluation.unsatisfiedCount} 件。</Typography.Paragraph>{stats.evaluation.unsatisfiedCount?<Chart label="不满意诉求供水供气构成" option={pie('不满意业务构成',stats.unsatisfiedBusiness)} onClick={i=>{const item=stats.unsatisfiedBusiness[i];if(item)open(item.name+'不满意诉求',item.rows);}}/>:<Empty description="暂无不满意诉求"/>}<Table size="small" rowKey="businessType" pagination={false} dataSource={stats.unsatisfiedBusiness} columns={[{title:'业务',dataIndex:'name'},{title:'不满意数',dataIndex:'count'},{title:'占全部不满意',dataIndex:'percent',render:percent},{title:'明细',render:(_,r)=>detailButton(r.name+'不满意诉求',r.rows)}]}/></Card></Col>
  </Row>
  <Card title="办理时长与满意度分布（招标 1.2.2 / 1.2.3）">
   <Typography.Paragraph type="secondary">办理时长 = 办结时间 − 诉求发生时间，以连续小时计算。四档互斥：≤24小时、&gt;24至48小时、&gt;48至72小时、&gt;72小时。每档满意／不满意占比均以该档已评价件数为分母。</Typography.Paragraph>
   <Chart label="各办理时长档满意、不满意及未评价件数" option={durationOption} onClick={(i,series)=>{const band=stats.duration[i];if(band){const rows=series===0?band.evaluation.satisfiedRows:series===1?band.evaluation.unsatisfiedRows:band.evaluation.missingRows;open(band.name+' · '+(series===0?'满意':series===1?'不满意':'未评价'),rows);}}}/>
   <Table size="small" rowKey="key" pagination={false} scroll={{x:850}} dataSource={stats.duration} columns={[{title:'办理时长',dataIndex:'name',render:(name:string,r)=><Button type="link" onClick={()=>open(name,r.rows)}>{name}</Button>},{title:'诉求数',dataIndex:'count'},{title:'已评价数',render:(_,r)=>r.evaluation.evaluatedCount},{title:'满意数／占比',render:(_,r)=><Button type="link" onClick={()=>open(r.name+' · 满意',r.evaluation.satisfiedRows)}>{r.evaluation.satisfiedCount} / {percent(r.evaluation.satisfiedPercent)}</Button>},{title:'不满意数／占比',render:(_,r)=><Button type="link" onClick={()=>open(r.name+' · 不满意',r.evaluation.unsatisfiedRows)}>{r.evaluation.unsatisfiedCount} / {percent(r.evaluation.unsatisfiedPercent)}</Button>},{title:'未评价数',render:(_,r)=><Button type="link" onClick={()=>open(r.name+' · 未评价',r.evaluation.missingRows)}>{r.evaluation.missingCount}</Button>},{title:'明细',render:(_,r)=>detailButton(r.name,r.rows)}]}/>
   <Space wrap style={{marginTop:16}}><Tag>未办结／缺少办结时间 {stats.openRows.length} 件</Tag>{detailButton('未办结／缺少办结时间',stats.openRows)}<Tag>办结时间无效或早于发生时间 {stats.invalidDurationRows.length} 件</Tag>{detailButton('办理时长无效的诉求',stats.invalidDurationRows)}</Space>
   <Typography.Paragraph type="secondary" style={{marginTop:8,marginBottom:0}}>上述未办结和无效时长样本不进入任何时长档；其有效评价仍计入总体满意度。</Typography.Paragraph>
  </Card>
  <Row gutter={[16,16]}>
   <Col xs={24} xl={12}><Card title="高频诉求小区排名"><Typography.Paragraph type="secondary">按主数据小区编码精确匹配、按诉求数量降序排名。未关联／编码未知 {stats.unknownCommunityRows.length} 件。</Typography.Paragraph>{stats.communities.length?<Chart label="高频诉求小区数量排名" option={bars(stats.communities.map(c=>c.name),stats.communities.map(c=>c.count),'件')} onClick={i=>{const c=stats.communities[i];if(c)open(c.name+'诉求',c.rows);}}/>:<Empty description="暂无已关联小区诉求"/>}<Table size="small" rowKey="id" pagination={{pageSize:8}} dataSource={stats.communities} columns={[{title:'排名',dataIndex:'rank'},{title:'小区',dataIndex:'name',render:(name:string,r)=><Button type="link" onClick={()=>open(name+'诉求',r.rows)}>{name}</Button>},{title:'诉求数',dataIndex:'count'},{title:'明细',render:(_,r)=>detailButton(r.name+'诉求',r.rows)}]}/>{detailButton('未关联／编码未知的小区诉求',stats.unknownCommunityRows)}</Card></Col>
   <Col xs={24} xl={12}><Card title="企业每万户诉求率"><Typography.Paragraph type="secondary">同期间、同业务、同企业诉求数 ÷ 企业主数据服务户数 × 10000。户数非正或缺失时不可计算，显示“—”。</Typography.Paragraph>{stats.enterpriseRates.some(e=>e.per10k!==null)?<Chart label="企业每万户诉求率" option={bars(stats.enterpriseRates.map(e=>e.name),stats.enterpriseRates.map(e=>e.per10k),'件／万户')} onClick={i=>{const e=stats.enterpriseRates[i];if(e)open(e.name+'诉求',e.rows);}}/>:<Empty description="暂无有效的企业户数分母"/>}<Table size="small" rowKey="id" pagination={{pageSize:8}} scroll={{x:560}} dataSource={stats.enterpriseRates} columns={[{title:'企业',dataIndex:'name',render:(name:string,r)=><Button type="link" onClick={()=>open(name+'诉求',r.rows)}>{name}</Button>},{title:'业务',dataIndex:'businessType',render:service},{title:'诉求数',dataIndex:'count'},{title:'服务户数',dataIndex:'households',render:(v:number|null)=>v??'—'},{title:'件／万户',dataIndex:'per10k',render:(v:number|null)=>v===null?'—':v.toFixed(2)},{title:'明细',render:(_,r)=>detailButton(r.name+'诉求',r.rows)}]}/><Space wrap><Typography.Text type="secondary">未匹配企业或业务不一致 {stats.unknownEnterpriseRows.length} 件。</Typography.Text>{detailButton('未匹配企业或企业业务不一致',stats.unknownEnterpriseRows)}</Space></Card></Col>
  </Row>
  <Modal open={!!detail} width={1150} title={<Space wrap>{detail?.title}<Tag color={data.mode==='simulation'?'orange':'blue'}>{data.mode==='simulation'?'模拟数据':'真实导入数据'}</Tag></Space>} footer={null} onCancel={()=>setDetail(null)} destroyOnClose>
   <Typography.Paragraph type="secondary">当前业务：{business==='all'?'全部':service(business)}；统计期间：{from} 至 {to}（北京时间）。日期无法定位的异常列表不属于期间统计。点击“查看诉求”打开该记录详情。</Typography.Paragraph>
   <Table size="small" rowKey="id" pagination={{pageSize:10,showSizeChanger:true,showTotal:n=>`共 ${n} 件`}} scroll={{x:1050}} dataSource={detail?.rows??[]} columns={[{title:'编号',dataIndex:'id'},{title:'标题',dataIndex:'title',ellipsis:true},{title:'业务',dataIndex:'businessType',render:service},{title:'企业',dataIndex:'enterpriseId',render:companyName},{title:'小区',dataIndex:'communityId',render:communityName},{title:'发生时间',dataIndex:'occurredAt',render:localTime},{title:'办结时间',dataIndex:'completedAt',render:localTime},{title:'评价',dataIndex:'evaluation',render:evaluationName},{title:'操作',fixed:'right',width:100,render:(_,r)=><Button type="link" onClick={()=>onComplaint(r)}>查看诉求</Button>}]}/>
  </Modal>
 </Space>;
}
