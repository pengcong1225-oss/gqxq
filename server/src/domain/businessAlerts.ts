import {createHash} from 'node:crypto';
interface AlertFact {complaintId:string;enterpriseCode:string|null;districtCode:string|null;adminGridCode:string|null}
export function alertCandidates(rule:{ruleId:string;version:number;threshold:number|null},rows:AlertFact[],from:string,to:string){
 const groups=new Map<string,AlertFact[]>();for(const row of new Map(rows.map(r=>[r.complaintId,r])).values()){if(!row.adminGridCode||!row.enterpriseCode||!row.districtCode)continue;const key=JSON.stringify([row.enterpriseCode,row.districtCode,row.adminGridCode]);groups.set(key,[...(groups.get(key)??[]),row]);}
 return [...groups.values()].filter(g=>rule.threshold!==null&&g.length>=rule.threshold).map(g=>{const r=g[0],complaintIds=g.map(r=>r.complaintId).sort();return {alertId:createHash('sha256').update(JSON.stringify([rule.ruleId,rule.version,r.enterpriseCode,r.districtCode,r.adminGridCode,from,to])).digest('hex'),enterpriseCode:r.enterpriseCode!,districtCode:r.districtCode!,adminGridCode:r.adminGridCode!,quantity:complaintIds.length,complaintIds};});
}


/** Use only explicitly planned, approved real public-utility applications. Never infer
 * planned nature from a title or join the obsolete shutdown worker tables. */
export function plannedUtilityEvidence(rows:(AlertFact&{businessType:string|null;businessAt:string|null})[],sources:import('./utilityFeed').MappedUtilitySource[]) {
 const evidence:{complaintId:string;eventId:string;sourceApplicationNo:string;sourceRevision:string;eventRevision:number}[]=[];
 for(const mapped of sources){
  const source=mapped.source;
  if(mapped.syncStatus!=='mapped'||source.dataMode!=='real'||source.fields.nature!=='planned')continue;
  for(const event of mapped.events){
   if(event.mode!=='real'||event.kind!=='shutdown'||event.sourceSystem!=='public-utility'||event.approvalStatus!=='approved'||['cancelled','canceled','withdrawn','rejected','90'].includes(String(source.status).toLowerCase())||String(source.approvalStatus).toLowerCase()==='cancelled')continue;
   const start=Date.parse(event.startsAt),end=Date.parse(event.endsAt);
   if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)continue;
   for(const row of rows){
    const at=row.businessAt?Date.parse(row.businessAt):NaN;
    if(row.enterpriseCode!==event.enterpriseId||row.districtCode!==event.districtCode||row.businessType!==event.businessType||!row.adminGridCode||!event.gridIds.includes(row.adminGridCode)||!Number.isFinite(at)||at<start||at>end)continue;
    evidence.push({complaintId:row.complaintId,eventId:event.id,sourceApplicationNo:source.sourceApplicationNo,sourceRevision:source.revision,eventRevision:event.revision});
   }
  }
 }
 return evidence;
}
