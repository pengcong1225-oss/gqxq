import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Checkbox,Col,Empty,Input,Row,Select,Space,Statistic,Table,Tag,Typography} from 'antd';
import {Link} from 'react-router-dom';
import {useAppStore} from '../stores/appStore';
import {useStatisticsOptions,initialStatisticsDraft,statisticsDateError,statisticsToday,type StatisticsDraft} from '../components/StatisticsFilters';
import {getAdministrativeHeat,type AdministrativeHeatData} from '../api/administrativeHeat';
import AdministrativeHeatMap,{heatColors} from '../components/AdministrativeHeatMap';
import StatisticsDetailsModal from '../components/StatisticsDetailsModal';
import type {StatisticsQuery,StatisticsDataset} from '../types/statistics';
const colors=['green','blue','yellow','orange','red'] as const;
const names=['绿色','蓝色','黄色','橙色','红色'];
export default function HeatmapView(){
 const user=useAppStore(s=>s.userInfo),token=useAppStore(s=>s.token),options=useStatisticsOptions();
 const allowed:StatisticsDataset[]=(['ledger','analysis'] as const).filter(d=>user?.permissions.includes(d==='ledger'?'dashboard.read':'analysis.read'));
 const can=!!user&&!user.mustChangePassword&&user.permissions.includes('heatmap.read')&&user.permissions.includes('statistics.read')&&allowed.length>0;
 const manage=user?.permissions.includes('heatmap.manage'),canDetail=user?.permissions.includes('complaint.read');
 const [draft,setDraft]=useState<StatisticsDraft>(()=>({...initialStatisticsDraft(allowed[0]??'ledger'),from:statisticsToday().slice(0,4)+'-01-01'}));
 const [query,setQuery]=useState<StatisticsQuery|null>(()=>({...initialStatisticsDraft(allowed[0]??'ledger'),projection:'current',from:statisticsToday().slice(0,4)+'-01-01'})),[state,setState]=useState<{key:string;data?:AdministrativeHeatData;error?:string}>();
 const [simulation,setSimulation]=useState(true);
 const [refresh,setRefresh]=useState(0),[demo,setDemo]=useState(false),[points,setPoints]=useState(false),[detail,setDetail]=useState<{query:StatisticsQuery;code:string;name:string;simulation:boolean}|null>(null);
 const authKey=JSON.stringify([token,user?.userId,user?.authorizationVersion,user?.permissions,user?.mustChangePassword]),key=JSON.stringify([authKey,query,refresh,simulation]);
 const seq=useRef(0),current=state?.key===key?state:undefined,data=current?.data;
 useEffect(()=>{setDetail(null);const n=++seq.current;if(!query||!can)return;void getAdministrativeHeat(query,simulation).then(data=>{if(n===seq.current)setState({key,data});}).catch(e=>{if(n===seq.current)setState({key,error:e instanceof Error?e.message:'加载失败'});});return()=>{seq.current++;};},[key,can]);
 const major=options.categories.filter(c=>!c.parentCode),minor=options.categories.filter(c=>c.parentCode===draft.majorCode);
 const dateError=statisticsDateError(draft);
 const visible=data?{...data,grids:data.grids.filter(g=>data.simulation||demo||!g.code.startsWith('DEMO-')),points:data.points.filter(p=>demo||!p.complaintId.startsWith('DEMO-'))}:null;
 const realGridCount=data?.grids.filter(g=>!g.code.startsWith('DEMO-')).length??0;
 const open=(g:AdministrativeHeatData['grids'][number])=>{if(data&&canDetail)setDetail({query:data.query,code:g.code,name:g.name,simulation:!!data.simulation});};
 const threshold=(c:string)=>Number((Number(c)*(data?.days??1)).toFixed(2));
 return <div><Space style={{display:'flex',justifyContent:'space-between'}}><Typography.Title level={3}>热力效果预览</Typography.Title>{manage&&<Link to="/heat-rules"><Button>配置热力规则</Button></Link>}</Space>
 <Alert type="info" showIcon style={{marginBottom:16}} message="后台预览：检查五档规则、网格匹配及诉求明细" description="正式热力展示归属可视化大屏；此页面用于配置后的效果核验。模拟网格会单独标识。"/>
 <Typography.Paragraph><Link to="/tender-support?tab=layers">核验小区、停供施工、管线与网格关联</Link></Typography.Paragraph>
 <Typography.Paragraph>按网格展示所选类别的诉求数量。颜色由“统计天数 × 五色系数”确定；颜色越接近红色，诉求数量越集中。</Typography.Paragraph>
 {!can?<Alert type="warning" message="当前账号无热力图查询权限"/>:<>
 <Checkbox checked={simulation} onChange={e=>setSimulation(e.target.checked)} style={{marginBottom:12}}>使用宜昌模拟网格（真实图层接入后可关闭）</Checkbox>
 <Card size="small" style={{marginBottom:16}}><Space wrap align="end">
 <label>统计范围<Select aria-label="热力统计范围" style={{display:'block',width:180}} value={draft.dataset} onChange={dataset=>setDraft({...draft,dataset,projection:'current'})} options={allowed.map(v=>({value:v,label:v==='ledger'?'全部诉求':'已入分析库诉求'}))}/></label>
 <label>业务类型<Select aria-label="热力业务类型" style={{display:'block',width:140}} allowClear placeholder="全部" value={draft.businessType} onChange={businessType=>setDraft({...draft,businessType})} options={[{value:'water',label:'供水'},{value:'gas',label:'燃气'},{value:'lpg',label:'液化气'}]}/></label>
 <label>诉求大类<Select aria-label="热力诉求大类" style={{display:'block',width:180}} allowClear placeholder="全部类别" loading={options.loading} value={draft.majorCode} onChange={majorCode=>setDraft({...draft,majorCode,minorCode:undefined})} options={major.map(c=>({value:c.code,label:c.label}))}/></label>
 <label>诉求小类<Select aria-label="热力诉求小类" style={{display:'block',width:180}} allowClear disabled={!draft.majorCode} placeholder="大类全部" value={draft.minorCode} onChange={minorCode=>setDraft({...draft,minorCode})} options={minor.map(c=>({value:c.code,label:c.label}))}/></label>
 <label>开始日期<Input aria-label="热力开始日期" type="date" value={draft.from} max={statisticsToday()} onChange={e=>setDraft({...draft,from:e.target.value})}/></label>
 <label>结束日期<Input aria-label="热力结束日期" type="date" value={draft.to} max={statisticsToday()} onChange={e=>setDraft({...draft,to:e.target.value})}/></label>
 <Button type="primary" disabled={(!simulation&&!draft.majorCode)||!!dateError} loading={!!query&&!current} onClick={()=>{setQuery({...draft,projection:'current',periodKind:'custom'});setRefresh(n=>n+1);}}>查看热力图</Button>
 </Space>{dateError&&<Alert type="error" message={dateError}/>} {options.errors.length>0&&<Alert type="warning" message={options.errors.join(' ')} action={<Button onClick={options.retry}>重试选项</Button>}/>}</Card>
 {!query&&<Alert type="info" showIcon message="先选诉求大类和时间，再查看热力图" description="例如选择“费用问题”，查询30天，黄色系数10、橙色系数20时，301至600件的网格显示橙色。"/>}
 {current?.error&&<Alert type="error" message="热力数据加载失败" description={current.error} action={<Button onClick={()=>setRefresh(n=>n+1)}>重试</Button>}/>}
 {data&&visible&&<>
 {data.simulation&&<Alert type="info" showIcon style={{marginBottom:12}} message="宜昌模拟网格 · 非真实行政边界" description={<>以约2公里方格汇总已有WGS84坐标（其他坐标系、缺坐标或范围外暂不计入），数量来自当前筛选，不生成新诉求、不修改正式归属。含演示诉求 {data.demoCount??0} 件；已落网格中待纠偏坐标 {data.approximateCount??0} 件。{data.simulationCoefficients?'当前使用模拟系数 0.03 / 0.10 / 0.30 / 1.00 / 3.00，仅供预览，未写入正式规则。':'当前颜色使用所选类别已发布系数。'}</>}/>}

 <Row gutter={16} style={{marginBottom:16}}><Col span={8}><Card><Statistic title="所选类别诉求" value={data.total} suffix="件"/></Card></Col><Col span={8}><Card><Statistic title={data.simulation?'已落入模拟网格':'已关联行政网格'} value={data.coveredCount} suffix="件"/></Card></Col><Col span={8}><Card><Statistic title={data.simulation?'暂不能落入模拟网格':'尚未关联行政网格'} value={data.unlocatedCount} suffix="件"/></Card></Col></Row>
 <Typography.Paragraph>{data.query.from} 至 {data.query.to}，共 {data.days} 天。统计总量包含当前筛选中的演示诉求；模拟模式按全部筛选结果计数，参考点开关不改变数量。图表与明细使用相同筛选条件；同一诉求跨网格时，网格数量不能直接相加。</Typography.Paragraph>
 {!data.coefficients?<Alert type="warning" showIcon message="所选类别尚无生效的五色系数" description={manage?<Link to="/heat-rules">设置该类别系数后即可按五色显示；当前网格仍可查看数量与明细。</Link>:'请联系管理员设置该类别系数，当前网格仍可查看数量与明细。'}/>:<Card size="small" title="颜色对应的诉求量" style={{marginBottom:16}}><Space wrap>{colors.map((c,i)=><Tag key={c} color={heatColors[c]}>{names[i]}：{i===0?'0':String(threshold(data.coefficients![i-1]))+'＜'}{i===0?'至':''}{i===0?threshold(data.coefficients![i]):'件数≤'+threshold(data.coefficients![i])}{i===0?'件':''}{i===4?'；超过此值仍为红色':''}</Tag>)}</Space><div style={{marginTop:8}}>阈值＝系数 × {data.days} 天；等于阈值时归入该颜色，0件为绿色。</div></Card>}
 {!data.simulation&&!realGridCount&&<Alert type="warning" showIcon style={{marginBottom:12}} message="当前没有可用的真实行政网格边界，暂不能形成真实网格热力分布" description="已有诉求坐标仍保留。需接入社区/行政网格边界并建立归属后，才能按标书给真实网格着色；演示区域不能代表真实热点。"/>}
 <Space wrap style={{margin:'12px 0'}}>{!data.simulation&&<Checkbox checked={demo} onChange={e=>setDemo(e.target.checked)}>显示演示网格与演示点位</Checkbox>}<Checkbox checked={points} onChange={e=>setPoints(e.target.checked)}>叠加脱敏诉求点</Checkbox>{demo&&<Tag color="orange">演示数据，非真实行政边界</Tag>}</Space>
 {points&&<Typography.Paragraph type="secondary">已生成脱敏坐标的诉求以参考点显示。热力等级按网格诉求量计算。</Typography.Paragraph>}
 <AdministrativeHeatMap data={visible} showPoints={points} onGrid={open}/>
 <Card title={data.simulation?'宜昌模拟网格诉求数量':'行政网格诉求数量'} style={{marginTop:16}}><Table rowKey="code" dataSource={visible.grids} pagination={{pageSize:10}} columns={[{title:'行政网格',dataIndex:'name'},{title:'社区 / 小区',render:(_,g)=>g.communities.join('、')||'未登记'},{title:'诉求量',dataIndex:'count'},{title:'热力颜色',render:(_,g)=>g.level?<Tag color={heatColors[g.level]}>{names[colors.indexOf(g.level)]}</Tag>:'未设置系数'},...(canDetail?[{title:'操作',render:(_:unknown,g:AdministrativeHeatData['grids'][number])=><Button onClick={()=>open(g)}>查看明细</Button>}]:[])]}/></Card>
 </>}
 </>}
 <StatisticsDetailsModal query={detail?.query??null} adminGridCode={detail?.code} simulation={detail?.simulation} title={(detail?.name??'网格')+' · 诉求明细'} onClose={()=>setDetail(null)}/>
 </div>;
}
