import type {TenderDataset,SupportComplaint,SupportEvent,SupportWarningConfig} from '../types/tenderSupport';
export const defaultSupportWarnings:SupportWarningConfig={revision:0,rules:[{scenario:'winter',name:'冬季保供',threshold:5,days:30,enabled:true},{scenario:'summer',name:'夏季保畅',threshold:5,days:30,enabled:true},{scenario:'planned',name:'计划性停水停气',threshold:3,days:30,enabled:true},{scenario:'installation',name:'燃气三件套安装',threshold:3,days:30,enabled:true}]};
export function simulatedSupportData(today:string):TenderDataset{
 const year=Number(today.slice(0,4));
 const d:TenderDataset={schemaVersion:1,mode:'simulation',revision:1,sourceLabel:'宜昌专题模拟数据（独立样本，非真实诉求）',updatedAt:today+'T00:00:00+08:00',grids:[],communities:[],enterprises:[],complaints:[],events:[],pipelines:[]};
 const areas=[['420502','西陵区',111.28,30.71],['420503','伍家岗区',111.35,30.65],['420504','点军区',111.25,30.66],['420505','猇亭区',111.44,30.54],['420506','夷陵区',111.32,30.77],['420571','高新区',111.34,30.72]] as const;
 for(const businessType of ['water','gas'] as const)for(let i=0;i<2;i++)d.enterprises.push({id:`SIM-${businessType}-${i}`,name:`模拟${businessType==='water'?'供水':'燃气'}企业${i+1}`,businessType,households:20000+i*15000});
 areas.forEach(([districtCode,districtName,lng,lat],a)=>{for(let j=0;j<3;j++){
  const id=`SIM-G-${a}-${j}`,x=Number((lng+(j-1)*.018).toFixed(4)),y=Number((lat+(j%2)*.014).toFixed(4));
  d.grids.push({id,name:`${districtName}模拟网格${j+1}`,districtCode,districtName,longitude:x,latitude:y,ring:[[x-.007,y-.006],[x+.007,y-.006],[x+.007,y+.006],[x-.007,y+.006],[x-.007,y-.006]]});
  for(let k=0;k<2;k++)d.communities.push({id:`${id}-C${k}`,name:`${districtName}模拟小区${j*2+k+1}`,gridId:id,longitude:x+k*.004,latitude:y+k*.003,households:300+j*100+k*150});
 }});
 d.grids.forEach((g,i)=>{for(let y=year-4;y<=year;y++)for(let m=1;m<=12;m++)for(let n=0;n<4+(i+m+y)%7;n++){
  const day=1+(n*3+i)%27,date=`${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;if(date>today)continue;
  const businessType=(i+n)%2?'water':'gas',pressure=n%3===0;
  const scenario:SupportComplaint['scenario']=n%7===1&&businessType==='gas'?'installation':n%5===2?'planned':pressure&&businessType==='gas'&&[11,12,1,2,3].includes(m)?'winter':pressure&&businessType==='water'&&[6,7,8,9].includes(m)?'summer':'other';
  const type=pressure?(businessType==='water'?'水压问题':'气压问题'):scenario==='installation'?'燃气三件套安装':scenario==='planned'?'计划性停供':'费用咨询';
  const occurredAt=`${date}T${String(8+n%12).padStart(2,'0')}:00:00+08:00`,hours=[8,24,36,48,60,72,96][(n+i)%7];
  const completed=new Date(Date.parse(occurredAt)+hours*3600000).toISOString();
  const completedAt=n%9===0||new Date(Date.parse(completed)+8*3600000).toISOString().slice(0,10)>today?null:completed;
  d.complaints.push({id:`SIM-C-${y}-${m}-${i}-${n}`,title:`【模拟】${g.districtName}${type}`,businessType,type,enterpriseId:`SIM-${businessType}-${i%2}`,districtCode:g.districtCode,gridId:g.id,communityId:`${g.id}-C${n%2}`,occurredAt,completedAt,evaluation:!completedAt||n%5===0?'unevaluated':n%3===0?'unsatisfied':'satisfied',longitude:g.longitude+(n%2)*.004,latitude:g.latitude+(n%2)*.003,scenario});
 }});
 for(let i=0;i<18;i++)for(const month of [2,7,10,11]){
  const kinds:SupportEvent['kind'][]=['planned-water','planned-gas','emergency-water','emergency-gas','water-project','gas-project'];const kind=kinds[i%6],businessType=kind.includes('water')?'water':'gas';
  const startsAt=`${year}-${String(month).padStart(2,'0')}-01T00:00:00+08:00`;if(startsAt.slice(0,10)>today)continue;
  const gridIds=[d.grids[i].id,d.grids[(i+1)%18].id],name=kind.includes('project')?'管道改造':'停水停气';
  d.events.push({id:`SIM-E-${i}-${month}`,kind,title:`【模拟】${d.grids[i].districtName}${name}事件`,enterpriseId:`SIM-${businessType}-${i%2}`,gridIds,startsAt,endsAt:`${year}-${String(month).padStart(2,'0')}-28T23:59:59+08:00`,households:500+i*50,workers:10+i,reason:'模拟检修及设施升级',area:gridIds.map(id=>d.grids.find(g=>g.id===id)!.name).join('、'),plan:'【模拟】提前通知、设置警戒、备用供给、完成后复检恢复。',housing:'【模拟】涉及住宅楼8栋，以真实上报房屋清单替换。'});
 }
 for(let i=0;i<d.grids.length;i++){const g=d.grids[i];for(const businessType of ['water','gas'] as const)d.pipelines!.push({id:`SIM-P-${businessType}-${i}`,name:`${g.name}模拟${businessType==='water'?'供水':'燃气'}管线`,businessType,enterpriseId:`SIM-${businessType}-${i%2}`,gridIds:[g.id],path:[[g.longitude-.008,g.latitude-.004],[g.longitude,g.latitude],[g.longitude+.008,g.latitude+.004]]});}
 return d;
}
