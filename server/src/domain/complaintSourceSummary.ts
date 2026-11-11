/** Explicit whitelist for the stored 宜接就办 export contract. No free-text inference. */
export interface ComplaintSourceSummary {
 caseType:string|null;majorCategory:string|null;minorCategory:string|null;department:string|null;secondaryDepartment:string|null;
 district:string|null;street:string|null;community:string|null;grid:string|null;supervisionStatus:string|null;
 deadlineRaw:string|null;completedRaw:string|null;result:string|null;
}
export function sourceSummary(payload:Record<string,unknown>|null):ComplaintSourceSummary {
 const raw=payload?.metadata;const metadata=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 const text=(...keys:string[])=>{for(const key of keys){const v=metadata[key];if(typeof v==='string'&&v.trim())return v.trim();}return null;};
 return {caseType:text('案件类型名'),majorCategory:text('案件主类型名'),minorCategory:text('案件二级类型名'),department:text('部门名称','责任部门'),secondaryDepartment:text('二级单位'),
 district:text('区'),street:text('街道'),community:text('小区','社区'),grid:text('网格'),supervisionStatus:text('督办状态'),deadlineRaw:text('规定完成时间'),completedRaw:text('实际完成时间'),result:text('处理结果')};
}
/** Export dates without an offset are China wall time; reject calendar rollovers. */
export function sourceExportTime(raw:string|null):string|null {
 if(!raw)return null;
 const value=raw.trim();const m=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
 if(!m||Number(m[1])<1000)return null;
 const clock=m[1]+'-'+m[2]+'-'+m[3]+'T'+m[4]+':'+m[5]+':'+(m[6]??'00');
 const check=new Date(clock+'Z');if(!Number.isFinite(check.getTime())||check.toISOString().slice(0,19)!==clock)return null;
 const date=new Date(clock+(m[7]?'.'+m[7]:'')+(m[8]??'+08:00'));return Number.isFinite(date.getTime())?date.toISOString():null;
}
