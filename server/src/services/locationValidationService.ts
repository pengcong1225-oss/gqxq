import {z} from 'zod';
import {AppError} from '../http/errors';
import {validateGeometry} from './serviceGridService';
import type {BoundaryGeometry, GridCoverage} from '../types/serviceGrid';
import type {LocationCorrectionInput,LocationFacts,LocationValidationResult} from '../types/locationCorrection';
export type LocationClock=()=>Date;
const code=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).nullable();
const schema=z.object({
 complaintId:z.string().trim().min(1).max(64),expectedVersion:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
 districtCode:code,address:z.string().trim().min(1).max(500).nullable(),
 longitude:z.number().finite().min(-180).max(180).nullable(),latitude:z.number().finite().min(-90).max(90).nullable(),
 adminGridCode:code,communityCode:code,coordinateSystem:z.enum(['WGS84','unknown']).nullable(),
 coordinateSource:z.string().trim().min(1).max(500).nullable(),basis:z.string().trim().min(1).max(500),
}).strict().superRefine((v,ctx)=>{
 if((v.longitude===null)!==(v.latitude===null))ctx.addIssue({code:'custom',path:['latitude'],message:'经纬度必须成对填写或清空'});
 const hasPoint=v.longitude!==null&&v.latitude!==null;
 if(hasPoint? !v.coordinateSystem||!v.coordinateSource : v.coordinateSystem!==null||v.coordinateSource!==null)ctx.addIssue({code:'custom',path:['coordinateSystem'],message:'坐标必须记录坐标系状态及来源；无坐标时来源与坐标系为空'});
});
export function parseLocationCorrectionInput(raw:unknown):LocationCorrectionInput {
 const result=schema.safeParse(raw);if(!result.success)throw AppError.validation('位置组参数无效',result.error.issues.map(e=>({field:e.path.join('.'),message:e.message})));return result.data;
}
export function locationValidationDate(clock:LocationClock=()=>new Date()):string {
 return clock().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
}
function onSegment(p:number[],a:number[],b:number[]):boolean {
 const cross=(p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]);
 return Math.abs(cross)<1e-10&&p[0]>=Math.min(a[0],b[0])-1e-10&&p[0]<=Math.max(a[0],b[0])+1e-10&&p[1]>=Math.min(a[1],b[1])-1e-10&&p[1]<=Math.max(a[1],b[1])+1e-10;
}
function ringContains(p:number[],ring:number[][]):'inside'|'edge'|'outside' {
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[j],b=ring[i];if(onSegment(p,a,b))return 'edge';
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
 }
 return inside?'inside':'outside';
}
function polygonContains(p:number[],rings:number[][][]):boolean {
 if(ringContains(p,rings[0])==='outside')return false;
 return rings.slice(1).every(r=>ringContains(p,r)!=='inside');
}
function contains(p:number[],geometry:BoundaryGeometry):boolean {
 return geometry.type==='Polygon'?polygonContains(p,geometry.coordinates):geometry.coordinates.some(r=>polygonContains(p,r));
}
function usableGeometry(coverage:GridCoverage):boolean {
 if(coverage.coordinateSystem!=='WGS84'||!coverage.geometrySources?.length||!coverage.geometry?.features?.length)return false;
 try{return coverage.adminGridCodes.every(code=>coverage.geometry!.features.some(f=>f.properties.adminGridCode===code&&validateGeometry(f.geometry)!==null));}catch{return false;}
}
/** Shared geometry evaluation; callers choose/authorize their actual effective date. */
export function coverageContainsWgs84Point(coverage:GridCoverage,point:number[]):boolean {
 return point.length===2&&point.every(Number.isFinite)&&usableGeometry(coverage)&&coverage.geometry!.features.some(f=>contains(point,f.geometry));
}
/** Current-date evidence only. Unknown/incomplete evidence never becomes a negative spatial finding. */
export function evaluateLocationEvidence(input:LocationCorrectionInput,facts:LocationFacts,validationDate:string):LocationValidationResult {
 const admin=input.adminGridCode?facts.admins.find(a=>a.code===input.adminGridCode):null;
 const community=input.communityCode?facts.communities.find(c=>c.code===input.communityCode):null;
 if(input.adminGridCode&&(!admin||admin.districtCode!==input.districtCode))throw AppError.validation('行政网格与所选区划不一致');
 if(input.communityCode&&(!community||!admin||community.adminGridCode!==admin.code))throw AppError.validation('小区与所选行政网格不一致');
 const effective=facts.coverages.filter(c=>c.coverageState==='maintained'&&c.validFrom!==null&&c.validFrom<=validationDate&&(c.validTo===null||c.validTo>validationDate));
 const known=effective.filter(usableGeometry);
 const point=input.longitude!==null&&input.latitude!==null?[input.longitude,input.latitude]:null;
 const matches=point&&input.coordinateSystem==='WGS84'?known.flatMap(c=>c.geometry!.features.filter(f=>contains(point,f.geometry)).map(f=>({coverage:c,code:f.properties.adminGridCode}))):[];
 const candidates=[...new Set(matches.map(m=>m.code))].sort().flatMap(code=>{
  const a=facts.admins.find(a=>a.code===code);if(!a)return [];
  return [{adminGridCode:code,adminGridName:a.name,districtCode:a.districtCode,communityCodes:facts.communities.filter(c=>c.adminGridCode===code&&matches.some(m=>m.code===code&&m.coverage.communityCodes.includes(c.code))).map(c=>c.code).sort()}];
 });
 let spatialReason=!point?'尚无成对坐标，无法空间复核':input.coordinateSystem!=='WGS84'?'坐标系未核实，无法与 WGS84 边界比较':!admin?'未人工选择行政网格，保留多个候选供核对':'该日期缺少完整可核实覆盖边界，无法空间复核';
 let used:GridCoverage[]=[];
 if(point&&input.coordinateSystem==='WGS84'&&admin){
  const relevant=effective.filter(c=>c.adminGridCodes.includes(admin.code));
  const selected=matches.filter(m=>m.code===admin.code).map(m=>m.coverage);
  if(relevant.length&&relevant.every(usableGeometry)&&!selected.length)throw AppError.validation('声明的 WGS84 坐标不在所选行政网格的有效覆盖边界内');
  if(selected.length){used=[...new Map(selected.map(c=>[c.code,c])).values()];spatialReason='依据操作者声明的 WGS84 坐标及当日有效授权边界复核；不代表已认证地图来源或诉求发生时关系';}
 }
 return {validationDate,spatialStatus:used.length?'verified':'unknown',spatialReason,candidates,coverageEvidence:used.map(c=>({code:c.code,version:c.version,validFrom:c.validFrom!,validTo:c.validTo,sources:c.geometrySources}))};
}
