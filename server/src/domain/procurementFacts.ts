import {statisticsIso} from './statisticsFacts';

export const PROCUREMENT_POLICY_ID='procurement-source-completed-v2' as const;
export function procurementExclusion(f:{sourceSystem?:string|null;sourceEventStatus?:string|null;sourceSyncedAt?:string|null;businessType:string|null;sourceReportedAt:string|null}):string|null {
 if(f.sourceSystem!=='宜接就办')return '非宜接就办来源或缺来源证据';
 if(!['water','gas'].includes(f.businessType??''))return '非供水供气案件';
 if(f.sourceEventStatus!=='completed')return '来源未明确办结（关闭不等于办结）';
 if(!statisticsIso(f.sourceSyncedAt))return '来源办结缺同步证据';
 if(!statisticsIso(f.sourceReportedAt))return '来源录入时间缺失或无效';
 return null;
}
export interface FollowupFact {bindingTrusted?:boolean;binding?:unknown;eventId:string;sourceId:string;sourceObjectId:string;sourceVersion:number;sourceUpdatedAt:string;payload:{complaintId:string;occurredAt:string|null;contacted:boolean|null;evaluation:string|null}}
export interface SatisfactionEvidence {complaintId:string;eventId:string;sourceId:string;sourceObjectId:string;sourceVersion:number;sourceUpdatedAt:string;occurredAt:string;evaluation:string}
export interface SatisfactionResult {value:number|null;reason:string;policyId:string;satisfiedCount:number;validCount:number;considered:FollowupFact[];evidence:SatisfactionEvidence[];excluded:{complaintId:string;reason:string}[]}
/** Current heads only. A correction invalidates its former evaluation; no source priority is invented. */
export function calculateSourceSatisfaction(ids:string[],heads:FollowupFact[]):SatisfactionResult {
 const evidence:SatisfactionEvidence[]=[],excluded:SatisfactionResult['excluded']=[];
 const selectedIds=new Set(ids);const considered:FollowupFact[]=heads.filter(h=>selectedIds.has(h.payload.complaintId)).map(h=>({bindingTrusted:h.bindingTrusted===true,binding:JSON.parse(JSON.stringify(h.binding??null)),eventId:h.eventId,sourceId:h.sourceId,sourceObjectId:h.sourceObjectId,sourceVersion:h.sourceVersion,sourceUpdatedAt:h.sourceUpdatedAt,payload:{complaintId:h.payload.complaintId,occurredAt:h.payload.occurredAt,contacted:h.payload.contacted,evaluation:h.payload.evaluation}}));
 const grouped=new Map<string,FollowupFact[]>();for(const head of considered){const group=grouped.get(head.payload.complaintId)??[];group.push(head);grouped.set(head.payload.complaintId,group);}
 for(const complaintId of [...new Set(ids)].sort()){
  const all=grouped.get(complaintId)??[];const rows=all.filter(h=>h.bindingTrusted===true);
  let reason:string|null=null;
  if(!rows.length)reason=all.length?'回访未建立可信来源绑定':'无外部回访记录';
  else if(rows.some(r=>!statisticsIso(r.payload.occurredAt)))reason='回访时间缺失，无法确定末次';
  const lastTime=rows.reduce((latest,r)=>Math.max(latest,Date.parse(r.payload.occurredAt!)),-Infinity);
  const latest=reason?[]:rows.filter(r=>Date.parse(r.payload.occurredAt!)===lastTime);
  if(!reason&&latest.length!==1)reason='末次同时间多记录，来源优先规则待确认';
  const selected=latest[0];
  if(!reason&&(selected.payload.contacted!==true||!['satisfied','dissatisfied'].includes(selected.payload.evaluation??'')))reason='末次回访无有效接通评价';
  if(reason){excluded.push({complaintId,reason});continue;}
  evidence.push({complaintId,eventId:selected.eventId,sourceId:selected.sourceId,sourceObjectId:selected.sourceObjectId,sourceVersion:selected.sourceVersion,sourceUpdatedAt:selected.sourceUpdatedAt,occurredAt:statisticsIso(selected.payload.occurredAt)!,evaluation:selected.payload.evaluation!});
 }
 const satisfiedCount=evidence.filter(e=>e.evaluation==='satisfied').length,validCount=evidence.length;
 return {value:validCount?Math.round(satisfiedCount/validCount*10000)/100:null,reason:'外部当前版本：每诉求末次唯一、有时间且已接通的有效评价；同时间多记录排除。来源优先与末次规则待业务确认。',policyId:'external-latest-unambiguous-v1',satisfiedCount,validCount,considered,evidence,excluded};
}
