import {createHash} from 'node:crypto';
interface AlertFact {complaintId:string;enterpriseCode:string|null;districtCode:string|null;adminGridCode:string|null}
export function alertCandidates(rule:{ruleId:string;version:number;threshold:number|null},rows:AlertFact[],from:string,to:string){
 const groups=new Map<string,AlertFact[]>();for(const row of new Map(rows.map(r=>[r.complaintId,r])).values()){if(!row.adminGridCode||!row.enterpriseCode||!row.districtCode)continue;const key=JSON.stringify([row.enterpriseCode,row.districtCode,row.adminGridCode]);groups.set(key,[...(groups.get(key)??[]),row]);}
 return [...groups.values()].filter(g=>rule.threshold!==null&&g.length>=rule.threshold).map(g=>{const r=g[0],complaintIds=g.map(r=>r.complaintId).sort();return {alertId:createHash('sha256').update(JSON.stringify([rule.ruleId,rule.version,r.enterpriseCode,r.districtCode,r.adminGridCode,from,to])).digest('hex'),enterpriseCode:r.enterpriseCode!,districtCode:r.districtCode!,adminGridCode:r.adminGridCode!,quantity:complaintIds.length,complaintIds};});
}
