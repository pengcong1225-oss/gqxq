/** Explicit whitelist for the stored 宜接就办 export contract. No free-text inference.
 *
 * v1：综合查询导出（案件类型名/案件主类型名/案件二级类型名/部门名称/区/督办状态/处理结果…）。
 * v2：2025-2026 新版 27 列导出（大类/中类/小类/事项分类/主办单位/事件状态/办理结果…）。
 * 两版键名不同，这里只做**显式键名回退**，不做自由文本猜测；旧键优先，保证存量数据逐字不变。
 */
export interface ComplaintSourceSummary {
 caseType:string|null;majorCategory:string|null;minorCategory:string|null;department:string|null;secondaryDepartment:string|null;
 district:string|null;street:string|null;community:string|null;grid:string|null;supervisionStatus:string|null;
 deadlineRaw:string|null;completedRaw:string|null;result:string|null;satisfaction:string|null;satisfactionCode:string|null;
}
export interface SourceSummaryFallback { districtName?:string|null; address?:string|null; }
const STREET=/([\u4e00-\u9fa5]{2,8}(?:街道|街办|镇|乡))/;
const COMMUNITY=/([\u4e00-\u9fa5]{2,12}(?:小区|社区))/g;
function satisfactionCode(value:string|null):string|null{
 if(!value)return null;
 const map:Record<string,string>={'满意':'satisfied','基本满意':'basically_satisfied','不满意':'unsatisfied','暂无回复结果':'no_reply'};
 return map[value.trim()]??null;
}
function parseStreet(address:string|null):string|null{
 if(!address)return null;
 const m=STREET.exec(address);
 if(!m)return null;
 const name=m[1].replace(/^.*[区县市]/, '');
 return name.length>=2?name:m[1];
}
/** 地址里的小区/社区名：取最后一个命中，并剥掉前面的行政区/道路/门牌噪声。 */
function parseCommunity(address:string|null):string|null{
 if(!address)return null;
 const matches=[...address.matchAll(COMMUNITY)];
 if(matches.length===0)return null;
 const name=matches[matches.length-1][1].replace(/^[号路道街巷村镇乡区县]+/, '');
 return name.length>=3?name:null;
}
export function sourceSummary(payload:Record<string,unknown>|null, fallback:SourceSummaryFallback={}):ComplaintSourceSummary {
 const raw=payload?.metadata;const metadata=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 const text=(...keys:string[])=>{for(const key of keys){const v=metadata[key];if(typeof v==='string'&&v.trim())return v.trim();}return null;};
 const address=text('详细地址') ?? (typeof fallback.address==='string'&&fallback.address.trim()?fallback.address.trim():null);
 const districtName=typeof fallback.districtName==='string'&&fallback.districtName.trim()?fallback.districtName.trim():null;
 const isV2=metadata['大类']!==undefined||metadata['中类']!==undefined||metadata['事件状态']!==undefined||metadata['主办单位']!==undefined;
 if(isV2){
  return {caseType:text('小类','事项分类'),majorCategory:text('大类'),minorCategory:text('中类'),department:text('主办单位'),secondaryDepartment:null,
   district:text('区')??districtName,street:text('街道')??parseStreet(address),community:text('小区','社区')??parseCommunity(address),grid:null,
   supervisionStatus:text('事件状态'),deadlineRaw:null,completedRaw:null,result:text('办理结果','回复市民结果'),
   satisfaction:text('市民回复结果'),satisfactionCode:satisfactionCode(text('市民回复结果'))};
 }
 return {caseType:text('案件类型名'),majorCategory:text('案件主类型名'),minorCategory:text('案件二级类型名'),department:text('部门名称','责任部门'),secondaryDepartment:text('二级单位'),
  district:text('区'),street:text('街道'),community:text('小区','社区'),grid:text('网格'),supervisionStatus:text('督办状态'),deadlineRaw:text('规定完成时间'),completedRaw:text('实际完成时间'),result:text('处理结果'),
  satisfaction:text('市民回复结果'),satisfactionCode:satisfactionCode(text('市民回复结果'))};
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
