import type {ComplaintDetail} from '../types/api';
import type {LocationCorrectionOptions} from '../types/locationCorrection';
import type {LocationDraft} from '../components/LocationCorrectionFields';
export interface LocationSuggestion {address:string;districtCode:string|null;adminGridCode:string|null;communityCode:string|null}
/** Only compact place names may leave the browser. Raw complaint prose is never a query. */
export function safePlaceQuery(value:string):string|null {
 const text=value.trim();
 return text.length>=3&&text.length<=60&&!/[\r\n，。！？；,:!?;]|\d{7,}|停水|漏水|投诉|反映|联系|处理|解决|希望|请|电话/.test(text)&&/(小区|社区|村|镇|乡|路|街|巷|号|大厦|花园|广场|苑)$/.test(text)?text:null;
}
export function adoptLocation(draft:LocationDraft,place:LocationSuggestion):LocationDraft{return {...draft,...place,lng:'',lat:'',coordinateSystem:'unknown',coordinateSource:''};}
export function suggestLocations(detail:ComplaintDetail,options:LocationCorrectionOptions){
 const source=(detail.title??'')+'\n'+(detail.content??'');
 const districts=options.districts.filter(d=>source.includes(d.name));
 const candidates:LocationSuggestion[]=[];
 const push=(c:LocationSuggestion)=>{if(!candidates.some(x=>JSON.stringify(x)===JSON.stringify(c)))candidates.push(c);};
 for(const community of options.communities){
  if(!source.includes(community.name))continue;
  const grid=options.adminGrids.find(g=>g.code===community.adminGridCode);if(!grid)continue;
  if(districts.length===1&&districts[0].code!==grid.districtCode)continue;
  push({address:community.name,communityCode:community.code,adminGridCode:grid.code,districtCode:grid.districtCode});
 }
 const structured=[...(detail.addressCandidate?[detail.addressCandidate]:[]),...(detail.locationClues??[])].filter(c=>source.includes(c.value)&&c.evidence&&source.includes(c.evidence));
 for(const c of structured){
  if(!safePlaceQuery(c.value)||!c.districtCode||!options.districts.some(d=>d.code===c.districtCode))continue;
  const samePlace=candidates.filter(existing=>existing.districtCode===c.districtCode&&(c.value.includes(existing.address)||existing.address.includes(c.value)));
  if(samePlace.length===1){
   // A more precise address may extend the same place, but cannot erase another independently evidenced location.
   if(c.value.length>samePlace[0].address.length)samePlace[0].address=c.value;
  }else push({address:c.value,districtCode:c.districtCode,communityCode:null,adminGridCode:null});
 }
 const evidenceDistricts=new Set([...districts.map(d=>d.code),...structured.map(c=>c.districtCode).filter(Boolean)]);
 const conflict=detail.locationConflict||evidenceDistricts.size>1||candidates.some(c=>districts.length===1&&c.districtCode!==districts[0].code);
 return {candidates,conflict,unique:!conflict&&candidates.length===1?candidates[0]:null};
}

/** Resolve only a selected address against authorized dictionaries, never complaint prose. */
export function resolveAddressLocation(address:string,options:LocationCorrectionOptions,placeName='') {
 const text=address.trim(), evidence=text+' '+placeName;
 const districts=options.districts.filter(d=>d.name.length>=2&&evidence.includes(d.name));
 const location:LocationSuggestion={address,districtCode:districts.length===1?districts[0].code:null,adminGridCode:null,communityCode:null};
 // This platform covers Yichang. Keep an explicit foreign/unauthorized county as evidence,
 // rather than treating absence from the scoped dictionary as absence from the address.
 const administrativePrefix=text.replace(/^[^省\s，,]{1,12}省/,'').replace(/^宜昌市/,'');
 const explicitCounty=administrativePrefix.match(/^([^省市区县\s，,]{1,12}?(?:区|县|市))/)?.[1];
 if(explicitCounty&&!/(小区|社区|园区|景区|校区|厂区|库区)$/.test(explicitCounty)&&!options.districts.some(d=>d.name===explicitCounty)){
  return {location:{...location,districtCode:null},township:null,candidates:[],message:'地址中的区县未匹配当前授权名录，无法自动确定归属，请核实地址或权限范围'};
 }
 const tail=districts.length===1&&text.includes(districts[0].name)?text.slice(text.indexOf(districts[0].name)+districts[0].name.length):'';
 const township=tail.match(/^([^省市区县\s，,]{1,12}?(?:街道|乡|镇))/)?.[1]??null;
 if(districts.length>1)return {location,township:null,message:'地址含多个区县，请人工选择归属',candidates:[]};
 const grids=options.adminGrids.filter(g=>(!location.districtCode||g.districtCode===location.districtCode)&&options.districts.some(d=>d.code===g.districtCode));
 const namedGrids=grids.filter(g=>g.name.length>=2&&evidence.includes(g.name));
 const communities=options.communities.filter(c=>c.name.length>=2&&evidence.includes(c.name)&&grids.some(g=>g.code===c.adminGridCode));
 const candidates=communities.map(c=>{const grid=grids.find(g=>g.code===c.adminGridCode)!;return {address,communityCode:c.code,adminGridCode:grid.code,districtCode:grid.districtCode};});
 if(candidates.length===1&&namedGrids.every(g=>g.code===candidates[0].adminGridCode)){
  Object.assign(location,candidates[0]);
  return {location,township,message:'已根据地址匹配村社区／小区，并联动区县和行政网格',candidates};
 }
 if(candidates.length>0)return {location,township,message:'地址匹配到多个地点或网格归属冲突，请人工选择',candidates};
 if(namedGrids.length===1){location.adminGridCode=namedGrids[0].code;location.districtCode=namedGrids[0].districtCode;}
 return {location,township,candidates,message:namedGrids.length>1?'地址匹配到多个行政网格，请人工选择':location.adminGridCode?'已匹配区县和行政网格；未匹配村社区／小区':location.districtCode?'已识别区县；未匹配本地村社区／小区及行政网格，可补选或保留待核实':'未匹配授权范围内的区县或地点，请补充地址或人工选择'};
}
