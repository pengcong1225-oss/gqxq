import {evaluateHeat,TENDER_HEAT_POLICY,TENDER_HEAT_POLICY_ID} from '../domain/heatRule';
import {SIMULATED_HEAT_COEFFICIENTS} from '../domain/simulatedYichangGrid';
import {dayCount} from '../domain/statisticsQuery';
import type {buildScreen} from '../domain/screen';
import type {TenderDataset} from '../types/tenderSupport';
import type {ScreenSection,ScreenHeat} from '../types/screen';
export function screenHeat(result:ReturnType<typeof buildScreen>,dataset:TenderDataset|null,permissions:readonly string[]):ScreenSection<ScreenHeat>{
 const empty:ScreenHeat={days:null,thresholds:null,coefficients:null,policyId:null,ruleVersion:null,grids:[]};
 if(!permissions.includes('grid.read')||!permissions.includes('heatmap.read'))return {state:'unavailable',reason:'缺少网格或热力权限',data:empty};
 if(result.mode!=='simulation'||!dataset)return {state:'unavailable',reason:'正式空间资源及发布规则尚未核验',data:empty};
 const days=dayCount(result.window.from,result.window.to),coefficients=[...SIMULATED_HEAT_COEFFICIENTS],version='simulation-only';
 const thresholds=coefficients.map(c=>Number((Number(c)*days).toFixed(2)));
 const grids=dataset.grids.map(g=>{const count=result.details.filter(r=>r.adminGridCode===g.id).length;
  return {code:g.id,count,...evaluateHeat({count,days,rule:{version,coefficients},policy:TENDER_HEAT_POLICY})};});
 return {state:'available',reason:'仅模拟样本，非正式热力',data:{days,thresholds,coefficients,policyId:TENDER_HEAT_POLICY_ID,ruleVersion:version,grids}};
}
