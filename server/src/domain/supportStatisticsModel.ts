import type {SupportComplaint,TenderDataset} from '../types/tenderSupport';

export type SupportBusinessFilter='all'|'water'|'gas';
export type DurationBandKey='le24'|'24to48'|'48to72'|'gt72';
const hour=3600000;
// An explicit offset is required: browser-local parsing must never alter a reporting day.
function timestamp(value:string|null):number|null{
 if(!value||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return null;
 const datePart=value.slice(0,10);if(!validDay(datePart))return null;
 const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}
function validDay(value:string):boolean{return /^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export function shanghaiDay(value:string):string|null{const time=timestamp(value);return time===null?null:new Date(time+8*hour).toISOString().slice(0,10);}
export function durationBand(row:SupportComplaint):DurationBandKey|null{
 const start=timestamp(row.occurredAt),end=timestamp(row.completedAt);if(start===null||end===null||end<start)return null;
 const elapsed=(end-start)/hour;return elapsed<=24?'le24':elapsed<=48?'24to48':elapsed<=72?'48to72':'gt72';
}
export function supportEvaluation(rows:SupportComplaint[]){
 const satisfiedRows=rows.filter(r=>r.evaluation==='satisfied'),unsatisfiedRows=rows.filter(r=>r.evaluation==='unsatisfied');
 const missingRows=rows.filter(r=>r.evaluation!=='satisfied'&&r.evaluation!=='unsatisfied');
 const evaluatedCount=satisfiedRows.length+unsatisfiedRows.length;
 return {satisfiedRows,unsatisfiedRows,missingRows,evaluatedCount,satisfiedCount:satisfiedRows.length,unsatisfiedCount:unsatisfiedRows.length,missingCount:missingRows.length,satisfiedPercent:evaluatedCount?satisfiedRows.length/evaluatedCount*100:null,unsatisfiedPercent:evaluatedCount?unsatisfiedRows.length/evaluatedCount*100:null};
}
export function buildSupportStatistics(data:TenderDataset,from:string,to:string,business:SupportBusinessFilter='all'){
 const rangeValid=validDay(from)&&validDay(to)&&from<=to;
 const businessRows=data.complaints.filter(r=>business==='all'||r.businessType===business);
 const invalidTimeRows=businessRows.filter(r=>shanghaiDay(r.occurredAt)===null);
 const rows=rangeValid?businessRows.filter(r=>{const day=shanghaiDay(r.occurredAt);return day!==null&&day>=from&&day<=to;}):[];
 const evaluation=supportEvaluation(rows);
 const unsatisfiedBusiness=(['water','gas'] as const).filter(b=>business==='all'||business===b).map(b=>{const selected=evaluation.unsatisfiedRows.filter(r=>r.businessType===b);return {businessType:b,name:b==='water'?'供水':'供气',count:selected.length,percent:evaluation.unsatisfiedCount?selected.length/evaluation.unsatisfiedCount*100:null,rows:selected};});
 const duration=([{key:'le24',name:'≤24小时'},{key:'24to48',name:'>24至48小时'},{key:'48to72',name:'>48至72小时'},{key:'gt72',name:'>72小时'}] as const).map(b=>{const selected=rows.filter(r=>durationBand(r)===b.key);return {...b,rows:selected,count:selected.length,evaluation:supportEvaluation(selected)};});
 const openRows=rows.filter(r=>r.completedAt===null||r.completedAt==='');
 const invalidDurationRows=rows.filter(r=>r.completedAt!==null&&r.completedAt!==''&&durationBand(r)===null);
 const communities=data.communities.map(c=>{const selected=rows.filter(r=>r.communityId===c.id);return {id:c.id,name:c.name,count:selected.length,rows:selected};}).filter(c=>c.count>0).sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)).map((c,index)=>({...c,rank:index+1}));
 const communityIds=new Set(data.communities.map(c=>c.id));
 const unknownCommunityRows=rows.filter(r=>!communityIds.has(r.communityId));
 const enterprises=data.enterprises.filter(e=>business==='all'||e.businessType===business);
 const enterpriseRates=enterprises.map(e=>{const selected=rows.filter(r=>r.enterpriseId===e.id&&r.businessType===e.businessType);const validHouseholds=Number.isFinite(e.households)&&e.households>0;return {id:e.id,name:e.name,businessType:e.businessType,households:validHouseholds?e.households:null,count:selected.length,per10k:validHouseholds?selected.length/e.households*10000:null,rows:selected};}).sort((a,b)=>(b.per10k??-1)-(a.per10k??-1)||a.id.localeCompare(b.id));
 const enterpriseKeys=new Set(enterprises.map(e=>e.id+'|'+e.businessType));
 const unknownEnterpriseRows=rows.filter(r=>!enterpriseKeys.has(r.enterpriseId+'|'+r.businessType));
 return {rangeValid,rows,evaluation,unsatisfiedBusiness,duration,openRows,invalidDurationRows,invalidTimeRows,communities,unknownCommunityRows,enterpriseRates,unknownEnterpriseRows};
}
