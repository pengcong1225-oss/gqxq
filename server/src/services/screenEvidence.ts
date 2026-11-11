import {randomUUID} from 'node:crypto';
import type {ScreenSections} from '../types/screen';
import type {SupportComplaint} from '../types/tenderSupport';
import type {buildScreen} from '../domain/screen';

export type ScreenEvidenceItem=ReturnType<typeof buildScreen>['details'][number];
export interface ScreenEvidenceRecord {
 state:'available'|'partial'|'unavailable';reason:string|null;
 window:{from:string;to:string;coverageThrough?:string}|null;
 ruleVersion:string|null;items:ScreenEvidenceItem[]|null;requiresSpatial:boolean;
}
const sample=(row:SupportComplaint):ScreenEvidenceItem=>({
 id:row.id,businessType:row.businessType,districtCode:row.districtCode,enterpriseCode:row.enterpriseId,
 adminGridCode:row.gridId,communityCode:row.communityId,categoryCode:row.type,
 title:'诉求 '+row.id,status:null,occurredDay:new Date(Date.parse(row.occurredAt)+28800000).toISOString().slice(0,10)
});
export function attachScreenEvidence(sections:ScreenSections,result:ReturnType<typeof buildScreen>):Record<string,ScreenEvidenceRecord>{
 const records:Record<string,ScreenEvidenceRecord>=Object.create(null);
 const put=(rows:ScreenEvidenceItem[]|null,window:ScreenEvidenceRecord['window'],ruleVersion:string|null,requiresSpatial=false,reason:string|null=null)=>{
  const key=randomUUID();records[key]={state:rows===null?'unavailable':result.mode==='real'?'partial':'available',reason,window,ruleVersion,items:rows,requiresSpatial};return key;
 };
 const research=result.researchEvidence;
 for(const item of sections.warnings.data.items){
  const source=research?.warnings.find(w=>w.rule.scenario===item.scenario);
  item.evidenceKey=put(source?source.rows.map(sample):null,source?{from:source.from,to:source.to}:null,source?'simulation-warning-v1':null,false,source?null:'正式预警规则及分类未确认');
 }
 for(const item of sections.top3.data.items){
  const source=research?.priorTop3.find(x=>x.name===item.code);
  const rows=research?source?.rows.map(sample)??[]:result.priorEvidence.filter(r=>r.categoryCode===item.code);
  item.evidenceKey=put(rows,{from:result.priorTop3.from,to:result.priorTop3.to},research?'simulation-prior-v1':'ledger-prior-unverified',false,research?null:'历史覆盖未确认');
 }
 for(const season of sections.research.data.seasons){
  const source=season.kind==='winter'?research?.winter:research?.summer;if(!source)continue;
  for(const year of season.years){const matched=source.years.find(y=>y.year===year.year)!;year.evidenceKey=put(matched.rows.map(sample),{from:matched.from,to:matched.to},'simulation-season-v1');}
  for(const month of season.months){const matched=source.months.find(m=>m.month===month.month)!;
   month.currentEvidenceKey=put(matched.currentRows.map(sample),{...matched.currentRange,coverageThrough:source.current.to},'simulation-season-v1');
   month.previousEvidenceKey=put(matched.previousRows.map(sample),{...matched.previousRange,coverageThrough:source.previous.to},'simulation-season-v1');
  }
  for(const grid of season.topGrids){const matched=source.topGrids.find(g=>g.id===grid.id)!;
   grid.currentEvidenceKey=put(matched.rows.map(sample),{from:source.current.from,to:source.current.to},'simulation-season-v1',true);
   grid.previousEvidenceKey=put(matched.previousRows.map(sample),{from:source.previous.from,to:source.previous.to},'simulation-season-v1',true);
  }
 }
 return records;
}
