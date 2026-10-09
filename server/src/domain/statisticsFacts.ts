import {z} from 'zod';
import type {StatisticsFacts,StatisticsComplaint} from '../types/statistics';
const text=z.string().max(500).nullable();const key=z.string().max(64).nullable();
const instant=z.string().datetime({offset:true}).nullable();
const factsSchema=z.object({complaintId:z.string().min(1).max(64),complaintNo:z.string().max(64),title:text,businessType:key,complaintType:key,majorCode:key,minorCode:key,dictionaryVersion:key,districtCode:key,districtName:text,enterpriseCode:key,enterpriseName:text,longitude:z.number().finite().min(-180).max(180).nullable(),latitude:z.number().finite().min(-90).max(90).nullable(),coordinateSystem:z.enum(['WGS84','unknown']).nullable(),coordinateSource:text,adminGridCode:key,communityCode:key,sourceReportedAt:instant,receivedAt:instant,editVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),enteredAt:instant}).strict();
export function statisticsIso(value:unknown):string|null {
 if(value===null||value===undefined)return null;
 if(value instanceof Date)return Number.isFinite(value.valueOf())?value.toISOString():null;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
 const d=new Date(value);if(!Number.isFinite(d.valueOf()))return null;
 const prefix=value.slice(0,10);const day=new Date(prefix+'T00:00:00Z');if(!Number.isFinite(day.valueOf())||day.toISOString().slice(0,10)!==prefix)return null;
 return d.toISOString();
}
const str=(v:unknown)=>v===null||v===undefined?null:String(v);
const num=(v:unknown)=>v===null||v===undefined?null:Number.isFinite(Number(v))?Number(v):null;
/** Whitelist from the actual locked/persisted complaint row; never source JSON. */
export function snapshotFactsFromComplaint(row:Record<string,unknown>,enteredAt:Date|null=null):StatisticsFacts {
 return factsSchema.parse({complaintId:String(row.complaint_id),complaintNo:String(row.complaint_no??''),title:str(row.title),businessType:str(row.business_type),complaintType:str(row.complaint_type),majorCode:str(row.major_category_code),minorCode:str(row.minor_category_code),dictionaryVersion:str(row.category_dictionary_version),districtCode:str(row.district_code),districtName:str(row.district_name),enterpriseCode:str(row.enterprise_code),enterpriseName:str(row.enterprise_name),longitude:num(row.location_lng),latitude:num(row.location_lat),coordinateSystem:row.location_coordinate_system==='WGS84'?'WGS84':row.location_lng==null||row.location_lat==null?null:'unknown',coordinateSource:str(row.location_coordinate_source),adminGridCode:str(row.admin_grid_code),communityCode:str(row.community_code),sourceReportedAt:statisticsIso(row.source_reported_at),receivedAt:statisticsIso(row.received_at),editVersion:Number(row.edit_version??0),enteredAt:statisticsIso(enteredAt)});
}
export function readStatisticsSnapshot(version:unknown,value:unknown):StatisticsFacts|null {
 if(Number(version)!==1)return null;let parsed=value;if(typeof parsed==='string'){try{parsed=JSON.parse(parsed);}catch{return null;}}
 const result=factsSchema.safeParse(parsed);return result.success?result.data:null;
}
export function resolveBusinessTime(facts:{sourceReportedAt:string|null;receivedAt:string|null}):Pick<StatisticsComplaint,'businessAt'|'businessDay'|'timeSource'|'timeReason'> {
 const source=statisticsIso(facts.sourceReportedAt),receipt=statisticsIso(facts.receivedAt);const businessAt=source??receipt;
 return {businessAt,businessDay:businessAt?new Date(businessAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):null,timeSource:source?'source_reported_at':receipt?'received_fallback':'unavailable',timeReason:source?null:receipt?facts.sourceReportedAt?'来源填报时间无效，回落平台接收时间':'来源填报时间缺失，回落平台接收时间':'业务时间与接收时间均不可用'};
}
