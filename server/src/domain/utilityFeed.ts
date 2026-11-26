import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {UtilityEvent,UtilityMode,UtilityOptions} from '../types/utility';
import {validateUtilityEvent} from './utility';
import {utilityGcj02ToWgs84} from './utilityCoordinates';
import {parseFeedRings,ringToGridCodes} from './rangeToGrid';
import {validateGeometry} from '../services/serviceGridService';

/**
 * 「来源未提供时间」的哨兵值。
 *
 * 为什么不直接用 null：`UtilityEvent.startsAt/endsAt` 是全系统共享的 `string` 类型，
 * 为少数缺时间的来源把它放宽成 `string|null` 会波及时间轴、超时匹配、关联诉求等所有下游，
 * 风险远大于收益。这里用一个**不可能与真实数据冲突**的远未来时间戳做哨兵，
 * 并通过 `gridUnresolved` 标记让前端知道「这是待入库事件、时间未知，不要当真展示」。
 */
export const UNKNOWN_TIME_SENTINEL='9999-12-31T23:59:59.000Z';
export interface UtilityFeedItem {feedId:number;sourceApplicationNo:string;sourceKind:'native'|'legacy';sourceId:string;kind:string;dataMode:UtilityMode;revision:string;status:string;approvalStatus?:string;fields:Record<string,unknown>;approvalTraces:{id?:unknown;action?:unknown;operator?:unknown;opinion?:unknown;time?:unknown}[];changedAt:string|null;coordinateSystem?:string|null;enterprise?:{subjectId?:string|number;organizationCode?:string|number;sourceAppCode?:string;name?:string}}
export interface FeedGrid {id:string;name:string;districtCode:string;geometry?:unknown;coordinateSystem?:string|null;geometrySource?:string|null}
export interface FeedReferences extends UtilityOptions {
 grids:FeedGrid[];
 mappings:{sourceDepartmentCode:string;enterpriseCode:string}[];
 /**
  * 小区点位（含所属 admin_grid_code），用于「影响范围多边形 → 网格」反推。
  *
  * 必要性：admin_grid.geometry 全为 null，无法用网格面相交判定；改为取多边形内的小区
  * 所属网格。这是真实上报多边形 + 真实已定位小区，不虚构几何。
  */
 communityPoints?:{lng:number;lat:number;gridCode:string}[];
}
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
 return a[0].every(p=>onRing(p,b[0]))&&b[0].every(p=>onRing(p,a[0]));
}
function spatialGridMatches(fields:UtilityFeedItem['fields'],coordinateSystem:string,refs:FeedReferences):FeedGrid[]{
 if(!['WGS84','GCJ02','GCJ-02'].includes(coordinateSystem))return [];
 const shapes=parseFeedRings(fields).flatMap(ring=>{
  try{
   const coordinates=coordinateSystem==='WGS84'?ring:ring.map(([lng,lat])=>utilityGcj02ToWgs84(lng,lat));
   const geometry=validateGeometry({type:'Polygon',coordinates:[coordinates]});
   return geometry?.type==='Polygon'?[geometry.coordinates]:[];
  }catch{return [];}
 });
 if(!shapes.length)return [];
 const gridCodes=new Set(shapes.flatMap(shape=>ringToGridCodes(shape[0],refs.communityPoints??[])));
 return refs.grids.filter(grid=>{
  if(grid.coordinateSystem==='WGS84'&&grid.geometrySource&&grid.geometry){
   try{
    const geo=validateGeometry(decodeFeedValue(grid.geometry));
    if(geo){const polygons=geo.type==='Polygon'?[geo.coordinates]:geo.coordinates;return shapes.some(s=>polygons.some(p=>utilityPolygonsOverlap(s,p)));}
   }catch{/* A grid with invalid geometry cannot supply a spatial match. */}
   return false;
  }
  return gridCodes.has(grid.id);
 });
}
function traceOutcome(action:unknown):'approved'|'rejected'|null{
 const value=str(action).toUpperCase();
 if(['APPROVE','APPROVED','PASS','通过','同意','审批通过','审核通过'].includes(value))return 'approved';
 if(['RETURN','RETURNED','REJECT','REJECTED','退回','拒绝','驳回','审批退回','审核退回'].includes(value))return 'rejected';
 return null;
}
export function mapUtilityFeed(source:UtilityFeedItem,mode:UtilityMode,refs:FeedReferences):MappedUtilitySource {
 const issues:string[]=[],events:UtilityEvent[]=[],f=source.fields;
 if(source.dataMode!==mode||!['real','simulation'].includes(source.dataMode))return {source,syncStatus:'pending_mapping',issues:['来源数据分类不一致，已隔离'],events};
 if(!['water-stops','gas-stops','construction'].includes(source.kind))return {source,syncStatus:'pending_mapping',issues:['未知来源申请类型'],events};
 const kind=source.kind==='construction'?'pipeline':'shutdown';
 const businessType=source.kind==='gas-stops'?'gas':source.kind==='water-stops'?'water':f.businessType==='gas'||f.businessType==='water'?f.businessType:f.projectType==='供水工程'?'water':f.projectType==='供气工程'?'gas':null;
 if(!businessType)issues.push('施工记录缺少明确供水／燃气业务分类');
 const organization=str(source.enterprise?.organizationCode),subjectId=str(source.enterprise?.subjectId), explicit=str(f.gqxqEnterpriseCode);
 const mapped=refs.mappings.filter(m=>[organization,subjectId].filter(Boolean).includes(str(m.sourceDepartmentCode))).map(m=>m.enterpriseCode);
 /** 审批轨迹里的"发起人"= 来源系统自报的填报单位（实测企业名在此，见下方注释） */
  const traceOperator=(()=>{
    const traces=Array.isArray(source.approvalTraces)?source.approvalTraces:[];
    const byAction=traces.find(t=>String(t?.action??'')==='3'&&str(t?.operator));
    if(byAction)return str(byAction.operator);
    const byOpinion=traces.find(t=>/发起人/.test(String(t?.opinion??''))&&str(t?.operator));
    return byOpinion?str(byOpinion.operator):'';
  })();
  /**
   * 填报单位取值链。
   *
   * 实测 `utility-feed-real` rev=2 的 467 条：`source.enterprise.name` **全为 null**，
   * `organizationCode`/`subjectId`/`f.gqxqEnterpriseCode` 也全空，所以按编码查
   * `enterprise_department_mapping` 一次都命中不了。真实填报单位在**审批轨迹 operator**里。
   *
   * 另实测：467 条中 **260 条**把发起人写成 `action='1'`+`opinion='发起人'`（正确应为 `action='3'`），
   * 是上游历史数据缺陷。只认 action='3' 只得 139 条，兼容 opinion 后得 **330 条**。
   * 两种都是来源自报值，非推断。
   */
  // 施工单位（sgdwName）可能是承包方。施工申请按报备企业认领。
  const name=kind==='pipeline'
    ?str(mode==='simulation'?f.companyName||f.reportCompany||source.enterprise?.name:source.enterprise?.name||f.companyName||f.reportCompany||traceOperator)
    :str(mode==='simulation'?f.companyName||source.enterprise?.name||f.sgdwName:source.enterprise?.name||f.companyName||f.sgdwName||traceOperator);
 const enterpriseCandidates=refs.enterprises.filter(e=>e.businessType===businessType&&(explicit?e.id===explicit:mapped.length?mapped.includes(e.id):e.name===name));
 const enterprise=enterpriseCandidates.length===1?enterpriseCandidates[0]:null;
 if(!enterprise)issues.push('填报单位尚未映射到唯一启用企业');
 const ranges=decodeFeedValue(f.tingshuiRange??f.tingqiRange??f.constructionRange??f.range),rangeList=Array.isArray(ranges)?ranges:[];
 const codes=decodeFeedValue(f.gqxqGridCodes),names=rangeList.map((r:any)=>str(r?.name)).filter(Boolean);
 const ambiguousNames=names.some(n=>refs.grids.filter(g=>g.name===n).length>1);
 if(!Array.isArray(codes)&&ambiguousNames)issues.push('影响范围名称对应多个行政网格，需使用几何或明确编码');
 const invalidCodes=codes!=null&&(!Array.isArray(codes)||codes.some(c=>typeof c!=='string'||!refs.grids.some(g=>g.id===c)));
 if(invalidCodes)issues.push('来源显式网格编码无效或不存在');
 let grids=invalidCodes?[]:Array.isArray(codes)?refs.grids.filter(g=>codes.includes(g.id)):ambiguousNames?[]:refs.grids.filter(g=>names.includes(g.name));
 const coordinateSystem=str(source.coordinateSystem??f.coordinateSystem).toUpperCase();
 if(!grids.length&&!invalidCodes&&!Array.isArray(codes))grids=spatialGridMatches(f,coordinateSystem,refs);
 if(!grids.length)issues.push(rangeList.length&&!['WGS84','GCJ02','GCJ-02'].includes(coordinateSystem)
  ?'影响范围坐标系未经确认，无法关联行政网格'
  :'影响范围尚未映射到行政网格');
 grids.sort((a,b)=>a.id.localeCompare(b.id));
 const startsAt=feedTime(f.startsAt??f.tingshuiDate??f.tingqiDate??f.kgDate),endsAt=feedTime(f.endsAt??f.fugongDate??f.fuqiDate??f.jhwcDate);
 if(!startsAt||!endsAt)issues.push('来源开始或结束时间缺失／格式无效');
 const rawEngine=str(source.approvalStatus).toUpperCase(),status=source.status;
 const engineStates=['APPROVED','COMPLETED','RETURNED','REJECTED','PENDING','PROCESSING','DRAFT','SUBMITTED','IN_REVIEW','WITHDRAWN','CANCELLED'];
 // Legacy migration status 1/3 has no proven equivalence to the live engine.
 const engine=source.sourceKind==='legacy'&&!engineStates.includes(rawEngine)?'':rawEngine;
 const approvalStatus=engine?['APPROVED','COMPLETED'].includes(engine)?'approved':['RETURNED','REJECTED'].includes(engine)?'rejected':'pending':status==='11'?'approved':status==='90'?'rejected':'pending';
 // Feed exports engine history and report history in separate blocks.
 const latestDecision=source.approvalTraces.flatMap(trace=>{
  const outcome=traceOutcome(trace?.action),at=feedTime(trace?.time);
  return outcome&&at?[{trace,outcome,at}]:[];
 }).sort((a,b)=>b.at.localeCompare(a.at))[0];
 const matchingDecision=latestDecision?.outcome===approvalStatus?latestDecision:null;
 const approvedBy=str(matchingDecision?.trace.operator),approvedAt=matchingDecision?.at??null;
 if(approvalStatus!=='pending'&&(!approvedBy||!approvedAt)){
  issues.push('来源审批缺少相符的审批动作、审批人或时间证据');
  return {source,syncStatus:'pending_mapping',issues,events};
 }
 if(!enterprise)return {source,syncStatus:'pending_mapping',issues,events};
 const gridUnresolved=grids.length===0;
 const related=decodeFeedValue(f.relatedTypes);
 const defaultRelatedTypes=mode==='simulation'
  ?businessType==='water'?['水压问题','计划性停供']:['气压问题','计划性停供']
  :businessType==='water'?['w01','w04']:['g06','g08'];
 const relatedTypes=Array.isArray(related)&&related.every(t=>typeof t==='string')&&related.length?related:defaultRelatedTypes;
 const revision=parseInt(createHash('sha256').update(source.revision+JSON.stringify([enterprise.id,grids.map(g=>g.id),relatedTypes])).digest('hex').slice(0,12),16);
 // 无网格时仍要生成事件：用空 districtCode 走一次循环
 const districtList=[...new Set(grids.map(g=>g.districtCode))];
 if(!districtList.length)districtList.push('');
 for(const districtCode of districtList){
  const raw={id:'PU-'+source.sourceKind+'-'+source.sourceId+'-'+districtCode,kind,title:str(f.projectName||f.title)||(businessType==='water'?'停水':'停气')+'申请 '+source.sourceApplicationNo,businessType,enterpriseId:enterprise.id,gridIds:grids.filter(g=>g.districtCode===districtCode).map(g=>g.id),districtCode,startsAt:startsAt??UNKNOWN_TIME_SENTINEL,endsAt:endsAt??UNKNOWN_TIME_SENTINEL,restoredAt:kind==='shutdown'?feedTime(f.restoredAt??f.fugongDate??f.fuqiDate):null,households:Number(f.households??f.effectResidentTotal??0)+Number(f.effectNotResidentTotal??0),workers:Number(f.workers??0),reason:str(f.reason??f.tingshuiDescribe??f.tingqiDescribe??f.shigongDescribe),area:names.join('、')||grids.map(g=>g.name).join('、'),plan:str(f.plan??f.annualPlanKey??f.constructionReportKey),housing:str(f.housing),sourceApplicationNo:source.sourceApplicationNo,approvalStatus,approvalNote:str(matchingDecision?.trace.opinion),approvedBy,approvedAt,relatedTypes,mode,revision,updatedAt:feedTime(source.changedAt)??new Date(0).toISOString()};
  try{
    const parsed=validateUtilityEvent(raw,mode,refs,{allowUnlocated:gridUnresolved});
    events.push({
      ...parsed,
      id:raw.id,
      mode,
      revision,
      updatedAt:raw.updatedAt,
      sourceSystem:'public-utility',
      sourceRevision:source.revision,
      sourceStatus:source.status,
      approvalTraces:source.approvalTraces,
      hasVerifiedGrid:!gridUnresolved,
      // 无网格定位时打标记，前端据此如实展示「该事件未定位到网格」，不假装有位置
      ...(gridUnresolved?{gridUnresolved:true}:{}),
    });
  }catch(e){
    issues.push(e instanceof Error?e.message:'来源数据校验失败');
    return {source,syncStatus:'pending_mapping',issues,events:[]};
  }
 }
 return {source,syncStatus:gridUnresolved||!startsAt||!endsAt?'pending_mapping':'mapped',issues,events};
}
