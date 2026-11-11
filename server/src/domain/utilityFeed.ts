import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {UtilityEvent,UtilityMode,UtilityOptions} from '../types/utility';
import {validateUtilityEvent} from './utility';
import {utilityGcj02ToWgs84} from './utilityCoordinates';
import {validateGeometry} from '../services/serviceGridService';

export interface UtilityFeedItem {feedId:number;sourceApplicationNo:string;sourceKind:'native'|'legacy';sourceId:string;kind:string;dataMode:UtilityMode;revision:string;status:string;approvalStatus?:string;fields:Record<string,unknown>;approvalTraces:{id?:unknown;action?:unknown;operator?:unknown;opinion?:unknown;time?:unknown}[];changedAt:string|null;coordinateSystem?:string|null;enterprise?:{subjectId?:string|number;organizationCode?:string|number;sourceAppCode?:string;name?:string}}
export interface FeedGrid {id:string;name:string;districtCode:string;geometry?:unknown;coordinateSystem?:string|null;geometrySource?:string|null}
export interface FeedReferences extends UtilityOptions {grids:FeedGrid[];mappings:{sourceDepartmentCode:string;enterpriseCode:string}[]}
export interface MappedUtilitySource {source:UtilityFeedItem;syncStatus:'mapped'|'pending_mapping';issues:string[];events:UtilityEvent[]}
export function decodeFeedValue(value:unknown):any {for(let i=0;i<2&&typeof value==='string';i++){try{value=JSON.parse(value);}catch{break;}}return value;}
const str=(value:unknown)=>typeof value==='string'?value.trim():value==null?'':String(value);
export function feedTime(value:unknown):string|null {
 const s=str(value);if(!s)return null;
 const iso=/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(s)?s.replace(' ','T')+(s.length===16?':00':'')+'+08:00':s;
 return z.string().datetime({offset:true}).safeParse(iso).success&&Number.isFinite(Date.parse(iso))&&/(?:Z|[+-]\d\d:\d\d)$/.test(iso)?new Date(iso).toISOString():null;
}
type Point=number[];
function inRing(p:Point,r:Point[]):boolean {let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
function onRing(p:Point,r:Point[]){return r.some((a,i)=>{if(!i)return false;const b=r[i-1];return Math.abs(cross(a,b,p))<1e-10&&p[0]>=Math.min(a[0],b[0])-1e-10&&p[0]<=Math.max(a[0],b[0])+1e-10&&p[1]>=Math.min(a[1],b[1])-1e-10&&p[1]<=Math.max(a[1],b[1])+1e-10;});}
function inPolygon(p:Point,poly:Point[][]){return !poly.some(r=>onRing(p,r))&&inRing(p,poly[0])&&!poly.slice(1).some(r=>inRing(p,r));}
function cross(a:Point,b:Point,c:Point){return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function properCross(a:Point,b:Point,c:Point,d:Point){return cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0;}
/** Positive interior overlap, respecting holes. Shared boundary alone is insufficient. */
export function utilityPolygonsOverlap(a:Point[][],b:Point[][]){
 if(a[0].some(p=>inPolygon(p,b))||b[0].some(p=>inPolygon(p,a)))return true;
 for(const [own,other] of [[a,b],[b,a]])for(let i=1;i<own[0].length;i++){const p=[(own[0][i-1][0]+own[0][i][0])/2,(own[0][i-1][1]+own[0][i][1])/2];if(inPolygon(p,other))return true;}
 for(let i=1;i<a[0].length;i++)for(let j=1;j<b[0].length;j++)if(properCross(a[0][i-1],a[0][i],b[0][j-1],b[0][j]))return true;
 return JSON.stringify(a)===JSON.stringify(b);
}
export function mapUtilityFeed(source:UtilityFeedItem,mode:UtilityMode,refs:FeedReferences):MappedUtilitySource {
 const issues:string[]=[],events:UtilityEvent[]=[],f=source.fields;
 if(source.dataMode!==mode||!['real','simulation'].includes(source.dataMode))return {source,syncStatus:'pending_mapping',issues:['来源数据分类不一致，已隔离'],events};
 const kind=source.kind==='construction'?'pipeline':'shutdown';
 const businessType=source.kind==='gas-stops'?'gas':source.kind==='water-stops'?'water':f.businessType==='gas'||f.businessType==='water'?f.businessType:f.projectType==='供水工程'?'water':f.projectType==='供气工程'?'gas':null;
 if(!businessType)issues.push('施工记录缺少明确供水／燃气业务分类');
 const organization=str(source.enterprise?.organizationCode),subjectId=str(source.enterprise?.subjectId), explicit=str(f.gqxqEnterpriseCode);
 const mapped=refs.mappings.filter(m=>[organization,subjectId].filter(Boolean).includes(str(m.sourceDepartmentCode))).map(m=>m.enterpriseCode);
 const name=str(mode==='simulation' ? f.companyName||source.enterprise?.name||f.sgdwName : source.enterprise?.name||f.companyName||f.sgdwName);
 const enterpriseCandidates=refs.enterprises.filter(e=>e.businessType===businessType&&(explicit?e.id===explicit:mapped.length?mapped.includes(e.id):e.name===name));
 const enterprise=enterpriseCandidates.length===1?enterpriseCandidates[0]:null;
 if(!enterprise)issues.push('填报单位尚未映射到唯一启用企业');
 const ranges=decodeFeedValue(f.tingshuiRange??f.tingqiRange??f.constructionRange??f.range),rangeList=Array.isArray(ranges)?ranges:[];
 const codes=decodeFeedValue(f.gqxqGridCodes),names=rangeList.map((r:any)=>str(r?.name)).filter(Boolean);
 if(!Array.isArray(codes)&&names.some(n=>refs.grids.filter(g=>g.name===n).length>1))issues.push('影响范围名称对应多个行政网格，需使用几何或明确编码');
 let grids=Array.isArray(codes)?refs.grids.filter(g=>codes.includes(g.id)):refs.grids.filter(g=>names.includes(g.name));
 if(Array.isArray(codes)&&codes.some(c=>typeof c!=='string'||!refs.grids.some(g=>g.id===c)))issues.push('来源显式网格编码不存在');
 if(!grids.length&&['WGS84','GCJ02','GCJ-02'].includes(String(source.coordinateSystem??f.coordinateSystem))){
  const shapes:any[]=[];for(const r of rangeList){try{const points=decodeFeedValue(r?.points);if(Array.isArray(points)&&points.length>=3){const ring=points.map(p=>Array.isArray(p)?p:[p?.longitude,p?.latitude]).map(p=>['GCJ02','GCJ-02'].includes(String(source.coordinateSystem??f.coordinateSystem))?utilityGcj02ToWgs84(p[0],p[1]):p);if(JSON.stringify(ring[0])!==JSON.stringify(ring[ring.length-1]))ring.push(ring[0]);const g=validateGeometry({type:'Polygon',coordinates:[ring]});if(g?.type==='Polygon')shapes.push(g.coordinates);}}catch{/* invalid geometry remains unmapped */}}
  grids=refs.grids.filter(g=>{if(g.coordinateSystem!=='WGS84'||!g.geometrySource)return false;try{const geo=validateGeometry(decodeFeedValue(g.geometry));return !!geo&&shapes.some(p=>(geo.type==='Polygon'?[geo.coordinates]:geo.coordinates).some(q=>utilityPolygonsOverlap(p,q)));}catch{return false;}});
 }
 if(!grids.length)issues.push(rangeList.length&&!['WGS84','GCJ02','GCJ-02'].includes(String(source.coordinateSystem??f.coordinateSystem))?'影响范围无已核实坐标系／网格对应，不能自动关联诉求':'影响范围尚未映射到行政网格');
 const startsAt=feedTime(f.startsAt??f.tingshuiDate??f.tingqiDate??f.kgDate),endsAt=feedTime(f.endsAt??f.fugongDate??f.fuqiDate??f.jhwcDate);
 if(!startsAt||!endsAt)issues.push('来源开始或结束时间缺失／格式无效');
 const rawEngine=str(source.approvalStatus).toUpperCase(),status=source.status;
 const engineStates=['APPROVED','COMPLETED','RETURNED','REJECTED','PENDING','PROCESSING','DRAFT','SUBMITTED','IN_REVIEW','CANCELLED'];
 // Legacy migration status 1/3 has no proven equivalence to the live engine.
 const engine=source.sourceKind==='legacy'&&!engineStates.includes(rawEngine)?'':rawEngine;
 const approvalStatus=engine?['APPROVED','COMPLETED'].includes(engine)?'approved':['RETURNED','REJECTED'].includes(engine)?'rejected':'pending':status==='11'?'approved':status==='90'?'rejected':'pending';
 const trace=[...source.approvalTraces].reverse().find(t=>/APPROV|PASS|通过|同意|REJECT|RETURN|退回|拒绝/i.test(str(t.action)));
 const approvedBy=approvalStatus==='pending'?'':str(trace?.operator),approvedAt=approvalStatus==='pending'?null:feedTime(trace?.time);
 if(approvalStatus!=='pending'&&(!approvedBy||!approvedAt))issues.push('来源审批缺少审批人或时间证据');
 if(issues.length)return {source,syncStatus:'pending_mapping',issues,events};
 const related=decodeFeedValue(f.relatedTypes),relatedTypes=Array.isArray(related)&&related.every(t=>typeof t==='string')?related:businessType==='water'?['水压问题','计划性停供']:['气压问题','计划性停供'];
 const revision=parseInt(createHash('sha256').update(source.revision+JSON.stringify([enterprise!.id,grids.map(g=>g.id),relatedTypes])).digest('hex').slice(0,12),16);
 for(const districtCode of [...new Set(grids.map(g=>g.districtCode))]){
  const raw={id:'PU-'+source.sourceKind+'-'+source.sourceId+'-'+districtCode,kind,title:str(f.projectName||f.title)||(businessType==='water'?'停水':'停气')+'申请 '+source.sourceApplicationNo,businessType,enterpriseId:enterprise!.id,gridIds:grids.filter(g=>g.districtCode===districtCode).map(g=>g.id),districtCode,startsAt:startsAt!,endsAt:endsAt!,restoredAt:kind==='shutdown'?feedTime(f.restoredAt??f.fugongDate??f.fuqiDate):null,households:Number(f.households??f.effectResidentTotal??0)+Number(f.effectNotResidentTotal??0),workers:Number(f.workers??0),reason:str(f.reason??f.tingshuiDescribe??f.tingqiDescribe??f.shigongDescribe),area:names.join('、')||grids.map(g=>g.name).join('、'),plan:str(f.plan??f.annualPlanKey??f.constructionReportKey),housing:str(f.housing),sourceApplicationNo:source.sourceApplicationNo,approvalStatus,approvalNote:str(trace?.opinion),approvedBy,approvedAt,relatedTypes,mode,revision,updatedAt:feedTime(source.changedAt)??new Date(0).toISOString()};
  try{const parsed=validateUtilityEvent(raw,mode,refs);events.push({...parsed,id:raw.id,mode,revision,updatedAt:raw.updatedAt,sourceSystem:'public-utility',sourceRevision:source.revision,sourceStatus:source.status,approvalTraces:source.approvalTraces});}catch(e){issues.push(e instanceof Error?e.message:'来源数据校验失败');}
 }
 return {source,syncStatus:issues.length?'pending_mapping':'mapped',issues,events:issues.length?[]:events};
}
