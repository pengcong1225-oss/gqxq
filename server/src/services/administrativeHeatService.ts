import {pool} from '../db/pool';
import {AppError} from '../http/errors';
import {normalizeStatisticsQuery} from '../domain/statisticsQuery';
import {captureHeatIn} from './heatRuleService';
import {assertStatisticsPermission,type StatisticsCapture} from './statisticsService';
import {createCoveragePointMatcher} from './locationValidationService';
import {evaluateHeat,validateConfirmation,TENDER_HEAT_POLICY} from '../domain/heatRule';
import {simulatedYichangMembers,SIMULATED_HEAT_COEFFICIENTS} from '../domain/simulatedYichangGrid';
import type {MasterDataContext} from '../types/masterData';
import type {StatisticsComplaint} from '../types/statistics';
/** Administrative grid counts are a union of complaint IDs, never a sum of overlapping enterprise grids. */
export function administrativeMembers(capture:StatisticsCapture){
 const result=new Map<string,{code:string;rows:Map<string,StatisticsComplaint>;communityCodes:Set<string>;coverages:StatisticsCapture['coverageEvidence'][number]['coverage'][]}>();
 let checks=0;
 for(const e of capture.coverageEvidence){
  const days=new Set(e.selectedBusinessDays.filter(d=>d>=capture.summary.query.from&&d<=capture.summary.query.to));
  if(!days.size)continue;
  for(const feature of e.coverage.geometry?.features??[]){
   const code=feature.properties.adminGridCode;
   if(!code||e.coverage.coordinateSystem!=='WGS84')continue;
   const coverage={...e.coverage,adminGridCodes:[code],geometry:{type:'FeatureCollection' as const,features:[feature]}};
   const match=createCoveragePointMatcher(coverage);
   const item:NonNullable<ReturnType<typeof result.get>>=result.get(code)??{code,rows:new Map<string,StatisticsComplaint>(),communityCodes:new Set<string>(),coverages:[]};
   if(!item.coverages.some(c=>JSON.stringify(c.geometry)===JSON.stringify(coverage.geometry)))item.coverages.push(coverage);
   for(const c of e.coverage.communityCodes)item.communityCodes.add(c);
   for(const r of capture.rows){
    if(++checks>2000000)throw AppError.validation('网格统计计算量过大，请缩短统计范围');
    if(!r.businessDay||!days.has(r.businessDay)||!r.grids.includes(e.coverage.code))continue;
    // Only an explicit administrative membership or verified WGS84 polygon match assigns a record.
    if(r.adminGridCode===code||(!r.coordinateSource?.includes('待纠偏')&&r.coordinateSystem==='WGS84'&&r.longitude!==null&&r.latitude!==null&&match([r.longitude,r.latitude])))item.rows.set(r.complaintId,r);
   }
   result.set(code,item);
  }
 }
 return result;
}
export async function administrativeHeat(raw:Record<string,unknown>,ctx:MasterDataContext,detail=false){
 const {adminGridCode,page:rp,size:rs,simulation,...query}=raw;
 if(simulation!==undefined&&!['true','false',true,false].includes(simulation as any))throw AppError.validation('模拟网格参数无效');
 const simulated=simulation===true||simulation==='true';
 const q=normalizeStatisticsQuery(query,ctx.access);assertStatisticsPermission(q,ctx.permissionCodes,detail);
 if(!ctx.permissionCodes.includes('heatmap.read'))throw AppError.forbidden();
 const page=Number(rp??1),size=Number(rs??10);
 if(detail&&(typeof adminGridCode!=='string'||!adminGridCode||!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(size)||size<1||size>100))throw AppError.validation('明细分页或网格参数无效');
 const db=await pool.getConnection();
 try{
  await db.query('set transaction isolation level repeatable read');await db.query('start transaction with consistent snapshot, read only');
  const capture=await captureHeatIn(db,q,ctx);
  if(simulated){
   const cells=simulatedYichangMembers(capture.statistics.rows);
   if(detail){const rows=[...(cells.get(String(adminGridCode))?.rows.values()??[])];return {query:q,content:rows.slice((page-1)*size,page*size),total:rows.length,page,size,totalPages:Math.ceil(rows.length/size),partial:capture.data.partial,dateFilterUnavailableCount:capture.statistics.summary.dateFilterUnavailableCount,dataCutoffAt:capture.data.dataCutoffAt};}
   const rule=capture.rules.find(r=>validateConfirmation(r.confirmation,r.rule.policyVersion,r.policy));
   const coefficients=rule?.rule.coefficients??SIMULATED_HEAT_COEFFICIENTS;
   const coveredRows=[...cells.values()].flatMap(c=>[...c.rows.values()]);
   return {...capture.data,administrative:true,simulation:true,simulationCoefficients:!rule,coefficients,
    coveredCount:coveredRows.length,unlocatedCount:capture.data.total-coveredRows.length,
    approximateCount:coveredRows.filter(r=>r.coordinateSource?.includes('待纠偏')).length,
    demoCount:capture.statistics.rows.filter(r=>r.complaintId.startsWith('DEMO-')).length,
    grids:[...cells.values()].sort((a,b)=>b.rows.size-a.rows.size||a.code.localeCompare(b.code)).map(c=>({code:c.code,name:c.name,communities:[],count:c.rows.size,
     ...evaluateHeat({count:c.rows.size,days:capture.data.days,rule:rule?.rule??{version:'simulation-only',coefficients},policy:rule?.policy??TENDER_HEAT_POLICY}),
     policyId:rule?.rule.policyId??null,policyVersion:rule?.rule.policyVersion??null,
     coverages:[{version:0,coordinateSystem:'WGS84',geometrySources:['模拟方格，非真实行政边界'],validFrom:q.from,validTo:q.to,selectedBusinessDays:[],geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:c.code},geometry:{type:'Polygon',coordinates:[c.ring]}}]}}]
    }))};
  }
  const members=administrativeMembers(capture.statistics);
  if(detail){const rows=[...(members.get(String(adminGridCode))?.rows.values()??[])];return {query:q,content:rows.slice((page-1)*size,page*size),total:rows.length,page,size,totalPages:Math.ceil(rows.length/size),partial:capture.data.partial,dateFilterUnavailableCount:capture.statistics.summary.dateFilterUnavailableCount,dataCutoffAt:capture.data.dataCutoffAt};}
  const names=new Map<string,string>(),communityNames=new Map<string,{name:string;admin:string}>();
  const codes=[...members.keys()],communities=[...new Set([...members.values()].flatMap(m=>[...m.communityCodes]))];
  if(codes.length){const [r]=await db.query<any[]>('select code,name from admin_grid where code in ('+codes.map(()=>'?').join(',')+')',codes);for(const x of r)names.set(x.code,x.name);}
  if(communities.length){const [r]=await db.query<any[]>('select code,name,admin_grid_code from community where code in ('+communities.map(()=>'?').join(',')+')',communities);for(const x of r)communityNames.set(x.code,{name:x.name,admin:x.admin_grid_code});}
  const category=capture.data.category;
  const rule=category?(capture.rules.find(r=>r.rule.category.majorCode===category.majorCode&&r.rule.category.minorCode===category.minorCode)??capture.rules.find(r=>r.rule.category.majorCode===category.majorCode&&r.rule.category.minorCode===null&&r.policy.classFallback==='minor_then_major')):undefined;
  const available=rule&&validateConfirmation(rule.confirmation,rule.rule.policyVersion,rule.policy)?rule:undefined;
  const covered=new Set<string>();for(const m of members.values())for(const id of m.rows.keys())covered.add(id);
  return {...capture.data,administrative:true,coveredCount:covered.size,unlocatedCount:capture.data.total-covered.size,coefficients:available?.rule.coefficients??null,
   grids:[...members.values()].map(m=>({code:m.code,name:names.get(m.code)??m.code,communities:[...m.communityCodes].flatMap(c=>communityNames.get(c)?.admin===m.code?[communityNames.get(c)!.name]:[]),count:m.rows.size,
    ...evaluateHeat({count:m.rows.size,days:capture.data.days,rule:available?.rule??null,policy:available?.policy}),
    policyId:available?.rule.policyId??null,policyVersion:available?.rule.policyVersion??null,
    coverages:m.coverages.map(c=>({version:c.version,geometry:c.geometry,coordinateSystem:c.coordinateSystem,geometrySources:c.geometrySources,validFrom:c.validFrom,validTo:c.validTo,selectedBusinessDays:[]}))
   }))};
 }finally{try{await db.rollback();}finally{db.release();}}
}
