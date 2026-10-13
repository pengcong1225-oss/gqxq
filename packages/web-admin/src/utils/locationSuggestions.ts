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
