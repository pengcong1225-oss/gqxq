import snapshot from '../data/yichangTownships.snapshot.json';
import {isRejectedLocationContext} from '../services/rules/locationContext';
export interface LocationCandidate {name:string;level:'小区'|'道路'|'乡镇';districtCode:string|null;districtName:string|null}
export function locationCandidates(row:Record<string,unknown>):LocationCandidate[]{
 const result:LocationCandidate[]=[];
 const states=parseFieldState(row.effective_field_state);
 const protectedAddress=states.address&&(['confirmed','no_correction'].includes(states.address.resolution)||Boolean(states.address.correctionId));
 if(!row.address&&protectedAddress)return [];
 const region=snapshot.counties.find(c=>c.code===row.district_code);
 if(row.district_code&&!region||region&&row.district_name&&region.name!==row.district_name)return [];
 const safeCandidate=row.parent_match==='conflict'||protectedAddress?null:row.candidate_text;
 for(const text of [row.address,safeCandidate,row.title,row.content].filter(Boolean).map(String)){
  const counties=snapshot.counties.filter(c=>text.includes(c.name));
  const county=snapshot.counties.find(c=>c.code===row.district_code)??(counties.length===1?counties[0]:undefined);
  const add=(name:string,level:LocationCandidate['level'],parent=county)=>{if(!result.some(r=>r.name===name&&r.districtCode===(parent?.code??null)))result.push({name,level,districtCode:parent?.code??null,districtName:parent?.name??null});};
  for(const c of snapshot.counties)for(const t of c.townships){const start=text.indexOf(t.name);if(start>=0&&!isRejectedLocationContext(text,start)&&(!county||county.code===c.code))add(t.name,'乡镇',c);}
  // Reduce prose to bounded place tokens locally. Only extracted public place names are queried.
  for(const match of text.matchAll(/[\u4e00-\u9fff·]{2,40}?(?:小区|花园|家园|公寓|家属院|社区|大厦|广场|苑|道路|路|街|巷)/g)){
   let name=match[0];const start=match.index!;
   if(isRejectedLocationContext(text,start)||/以前|原来|曾经|不是|并非|搬离/.test(name))continue;
   name=name.replace(/^伍家区/,'伍家岗区');
   name=name.split(/(?:本人是|本人家住|本人住在|本人|服务对象反映其是|服务对象反映|其购买的|购买的|现住在|现在住在|住在|家住|位于|地址是|反映|投诉|关于|我是|其是|的)/).pop()??'';
   for(const c of snapshot.counties){name=name.replace(c.name,'');for(const t of c.townships)name=name.replace(t.name,'');}
   name=name.replace(/^湖北省|^宜昌市/g,'').replace(/^.*(?:路|街|巷)(?=.{2,}(?:小区|花园|家园|苑|公寓|社区)$)/,'');
   name=name.replace(/^号/,'');
   if(/^(?:现在|目前|今天|最近|原因是|尽快解决|对于我们|我们|整个|本小区|该小区)/.test(name))continue;
   if(snapshot.counties.some(c=>c.townships.some(t=>t.name===name+'街道'))&&text.slice(start+match[0].length).startsWith('街道'))continue;
   if(name.length<3||name.length>24||/投诉|公司|联系|电话|希望|处理|业主|问题|居民|供水|停水|燃气|小区业/.test(name))continue;
   add(name,/(?:路|街|巷)$/.test(name)?'道路':'小区');
  }
 }
 return result.sort((a,b)=>['小区','道路','乡镇'].indexOf(a.level)-['小区','道路','乡镇'].indexOf(b.level)).slice(0,8);
}
import {parseFieldState} from './effectiveFieldPolicy';
import {mayInitialize} from './locationInitialization';
import type {InitialPoint} from './locationFallback';
export function mayRefineLocation(row:Record<string,unknown>):boolean {
 if(mayInitialize(row))return true;
 const states=parseFieldState(row.effective_field_state);
 return String(row.location_coordinate_source??'').startsWith('待纠偏：')&&/区县代表点|实际精度道路|实际精度乡镇街道|实际精度社区村落|高德近似地址定位|小区主数据匹配/.test(String(row.location_coordinate_source))&&['location_lng','location_lat','location_coordinate_system','location_coordinate_source'].every(k=>states[k]?.resolution==='unresolved');
}


export function shouldImproveLocation(row:Record<string,unknown>,point:Pick<InitialPoint,'longitude'|'latitude'|'level'|'score'>&{providerLevel?:string}):boolean {
 if(row.location_lng==null||row.location_lat==null)return true;
 const source=String(row.location_coordinate_source??'');
 const oldRank=/区县代表点|实际精度区县/.test(source)?5:/实际精度乡镇街道/.test(source)?4:/实际精度道路/.test(source)?3:/实际精度社区村落|小区主数据匹配/.test(source)?2:/高德近似地址定位/.test(source)?5:1;
 const ranks:Record<string,number>={'区县代表点':5,'区县':5,'乡镇':4,'乡镇街道':4,'道路':3,'社区村落':2,'小区':2,'住宅区':1,'兴趣点':1,'门牌号':1,'门址':1,'建筑物':1,'门牌':1};
 const newRank=ranks[point.providerLevel||point.level];
 if(newRank==null)return false;
 if(newRank!==oldRank)return newRank<oldRank;
 return false;
}
