import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ScopeRule} from '../auth/accessScope';
import type {StatisticsCapture} from '../services/statisticsService';
import type {captureHeatIn} from '../services/heatRuleService';
import type {ReportCreateInput} from '../types/report';
import {AppError} from '../http/errors';
export const REPORT_LIMITS=Object.freeze({objects:20000,snapshot:16*1024*1024,artifact:16*1024*1024,string:8192,proofs:100000});
export const RENDER_PLAN='statistics-draft-v1/docx9.9.0-exceljs4.4.0/2';
const input=z.object({requestId:z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),templateCode:z.literal('statistics-draft'),templateVersion:z.literal('v1'),format:z.enum(['docx','xlsx']),query:z.record(z.unknown()),includeHeat:z.boolean().default(false),todoIds:z.array(z.string().min(1).max(64)).max(20000).default([])}).strict();
export function parseReportInput(raw:unknown):ReportCreateInput {const r=input.safeParse(raw);if(!r.success)throw AppError.validation('报告请求参数不合法');return {...r.data,todoIds:[...new Set(r.data.todoIds)].sort()} as unknown as ReportCreateInput;}
export function canonical(value:unknown):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value as object).sort().filter(k=>(value as any)[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical((value as any)[k])).join(',')+'}';}
export const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function normalizedRules(rules:ScopeRule[]):ScopeRule[] {
 if(rules.some(r=>r.kind==='all'))return [{kind:'all'}];
 if(rules.length>100)throw AppError.validation('报告授权规则超出工程限额');
 return rules.filter(r=>r.kind==='restricted'&&(r.enterpriseCodes.length||r.districtCodes.length)).map(r=>{if(r.kind!=='restricted')throw Error('rule');if(r.enterpriseCodes.length>200||r.districtCodes.length>200)throw AppError.validation('报告授权规则超出工程限额');return {kind:'restricted' as const,enterpriseCodes:[...new Set(r.enterpriseCodes)].sort(),districtCodes:[...new Set(r.districtCodes)].sort()};});
}
export interface ReportSnapshot {
 version:1;renderPlan:typeof RENDER_PLAN;input:ReportCreateInput;statistics:StatisticsCapture;
 domain:{rules:ScopeRule[];ranges:{kind:string;from:string;to:string}[]};requiredPermissions:string[];
 heat:null|Awaited<ReturnType<typeof captureHeatIn>>;
 todoLinks:{todoId:string;analysisId:string;complaintId:string}[];
}
function checkValues(v:unknown):void {if(typeof v==='string'&&Buffer.byteLength(v)>REPORT_LIMITS.string)throw AppError.validation('报告单字段超过工程限额，请缩小选择');if(typeof v==='number'&&!Number.isFinite(v))throw AppError.validation('报告含非法数值');if(v&&typeof v==='object')for(const x of Object.values(v))checkValues(x);}
export function assertSnapshotLimits(snapshot:ReportSnapshot):void {
 const ids=new Set(snapshot.statistics.scopeFacts.map(s=>s.complaintId));
 for(const p of snapshot.statistics.periodFacts)for(const r of [...p.rows,...p.excludedRows.map(e=>e.row)])ids.add(r.complaintId);
 if(ids.size>REPORT_LIMITS.objects)throw AppError.validation('报告超过20000对象工程限额，请缩小选择');
 checkValues(snapshot);if(Buffer.byteLength(canonical(snapshot))>REPORT_LIMITS.snapshot)throw AppError.validation('报告快照超过16MiB工程限额，请缩小选择');
}
export function freezeReportSnapshot(input:ReportCreateInput,capture:StatisticsCapture,rules:ScopeRule[],heat:ReportSnapshot['heat']=null,todoLinks:ReportSnapshot['todoLinks']=[]):ReportSnapshot {
 const requiredPermissions=['statistics.read','complaint.read',input.query.dataset==='ledger'?'dashboard.read':'analysis.read'];
 if(capture.masterScopeFacts.length)requiredPermissions.push('enterprise.read');if(capture.coverageEvidence.length)requiredPermissions.push('grid.read');if(input.includeHeat)requiredPermissions.push('heatmap.read');
 const snapshot:ReportSnapshot={version:1,renderPlan:RENDER_PLAN,input,statistics:capture,domain:{rules:normalizedRules(rules),ranges:capture.periodFacts.map(p=>({kind:p.kind,from:p.from,to:p.to}))},requiredPermissions,heat:heat?{...heat,data:{...heat.data,points:[]}}:null,todoLinks};
 // Refuse the stricter D3 resource bounds BEFORE allocating a cloned capture.
 assertSnapshotLimits(snapshot);return JSON.parse(canonical(snapshot));
}
/** Private storage, validated by stored digest; never used as a public DTO. */
export function parseStoredSnapshot(text:string,hash:string):ReportSnapshot {
 if(Buffer.byteLength(text)>REPORT_LIMITS.snapshot||digest(text)!==hash)throw AppError.notFound('报告不存在或快照不可核验');
 let s:ReportSnapshot;try{s=JSON.parse(text);}catch{throw AppError.notFound('报告不存在或快照不可核验');}
 if(s.version!==1||!Array.isArray(s.domain?.rules)||!Array.isArray(s.domain?.ranges)||!s.statistics?.periodFacts||!s.statistics.masterScopeFacts||!s.requiredPermissions||!s.todoLinks)throw AppError.notFound('报告不存在或快照不可核验');
 assertSnapshotLimits(s);return s;
}
