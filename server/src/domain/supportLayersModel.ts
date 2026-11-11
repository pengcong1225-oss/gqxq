import type { SupportComplaint, SupportEvent, TenderDataset } from '../types/tenderSupport';

function actualCalendarDate(s:string):boolean {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
 const [year,month,day]=s.split('-').map(Number);
 const at=new Date(Date.UTC(year,month-1,day));
 return at.getUTCFullYear()===year&&at.getUTCMonth()===month-1&&at.getUTCDate()===day;
}
/** Dataset timestamps without an explicit offset are Shanghai local time. */
export function supportTimestamp(s:string):number {
 if(!actualCalendarDate(s.slice(0,10)))return NaN;
 if(/^\d{4}-\d{2}-\d{2}$/.test(s))return Date.parse(s+'T00:00:00+08:00');
 const normalized=s.replace(' ','T');
 return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)?normalized:normalized+'+08:00');
}
/** Date-only filters are inclusive Shanghai calendar days on every host. */
export function localDateWindow(from:string,to:string):[number,number] {
 const local=(s:string,end:boolean)=>/^\d{4}-\d{2}-\d{2}$/.test(s) ? actualCalendarDate(s)?Date.parse(s+'T'+(end?'23:59:59.999':'00:00:00')+'+08:00'):NaN : supportTimestamp(s);
 return [local(from,false),local(to,true)];
}
export function inLocalDateRange(at:string,from:string,to:string):boolean {
 const [start,end]=localDateWindow(from,to);const value=supportTimestamp(at);
 return Number.isFinite(value)&&Number.isFinite(start)&&Number.isFinite(end)&&start<=end&&value>=start&&value<=end;
}
export const eventBusiness=(event:SupportEvent):'water'|'gas'=>event.kind.includes('water')?'water':'gas';
export function eventsInRange(events:SupportEvent[],from:string,to:string):SupportEvent[] {
 const [start,end]=localDateWindow(from,to);
 return events.filter(event=>{const a=supportTimestamp(event.startsAt),b=supportTimestamp(event.endsAt);return start<=end&&a<=b&&a<=end&&b>=start;});
}
export function complaintsForEvent(data:TenderDataset,event:SupportEvent,from:string,to:string):SupportComplaint[] {
 const a=supportTimestamp(event.startsAt),b=supportTimestamp(event.endsAt);
 return data.complaints.filter(r=>{const at=supportTimestamp(r.occurredAt);return event.gridIds.includes(r.gridId)&&r.businessType===eventBusiness(event)&&at>=a&&at<=b&&inLocalDateRange(r.occurredAt,from,to);});
}
export function complaintsForCommunity(data:TenderDataset,communityId:string,from:string,to:string):SupportComplaint[] {
 return data.complaints.filter(r=>r.communityId===communityId&&inLocalDateRange(r.occurredAt,from,to));
}
export interface ComparisonCell {gridId:string;records:SupportComplaint[];isMaximum:boolean}
export interface GridComparisonRow {type:string;cells:ComparisonCell[]}
export function buildGridComparison(data:TenderDataset,gridIds:string[],from:string,to:string):GridComparisonRow[] {
 if(gridIds.length<2||gridIds.length>3||new Set(gridIds).size!==gridIds.length||gridIds.some(id=>!data.grids.some(g=>g.id===id)))throw new Error('请选择 2—3 个不同的现有网格');
 const scoped=data.complaints.filter(r=>gridIds.includes(r.gridId)&&inLocalDateRange(r.occurredAt,from,to));
 return [...new Set(scoped.map(r=>r.type))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(type=>{
  const cells=gridIds.map(gridId=>({gridId,records:scoped.filter(r=>r.gridId===gridId&&r.type===type),isMaximum:false}));
  const maximum=Math.max(...cells.map(c=>c.records.length));
  return {type,cells:cells.map(c=>({...c,isMaximum:maximum>0&&c.records.length===maximum}))};
 });
}
