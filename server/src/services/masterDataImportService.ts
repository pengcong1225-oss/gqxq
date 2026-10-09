import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {pool} from '../db/pool';
import {withTransaction,type Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {resolveAuthorizationFrom} from '../repositories/roleRepo';
import {readUserScope} from '../repositories/userScopeRepo';
import {insertAudit} from '../repositories/auditLogRepo';
import {readBatch,insertBatch,finishBatch,batchIds,expireBatchResources} from '../repositories/masterDataImportRepo';
import {readAdminIn,readCommunityIn,readGridIn,readCoverageIn,rowsIn} from '../repositories/serviceGridRepo';
import {dictionaryService,readDictionaryType,readDictionaryItems,validateDictionaryItemState} from './dictService';
import {enterpriseService,readEnterpriseIn,validateHouseholdPeriod,type HouseholdVersion,type EnterpriseWriteInput,type HouseholdWriteInput,type DepartmentMappingInput} from './enterpriseService';
import {serviceGridService,type ServiceGridInput,type AdminGridInput,type CommunityInput,type GridRegistrationInput} from './serviceGridService';
import {parseImportFile,IMPORT_LIMITS,TEMPLATE_VERSION,safeCsvCell} from './masterDataImportParser';
import {canAccessEnterprise} from '../auth/enterpriseScope';
import {canAccessSpatialMaster,canAccessGridCoverage} from '../auth/gridScope';
import type {MasterDataContext,DictionaryItem,SaveItemInput,SaveTypeInput} from '../types/masterData';
import type {ImportFile,ImportRow,ImportDetail,ImportPreview,ImportBatch,ImportBatchResult,MasterDataImportKind} from '../types/masterDataImport';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function importPermission(kind:MasterDataImportKind):string {return ['dictionary_type','dictionary_item','category'].includes(kind)?'system.dict.manage':['enterprise','department_mapping','household'].includes(kind)?'enterprise.manage':'grid.manage';}
export function assertImportPermission(kind:MasterDataImportKind,ctx:MasterDataContext){if(!ctx.userId||!ctx.permissionCodes.includes('masterdata.import')||!ctx.permissionCodes.includes(importPermission(kind)))throw AppError.forbidden('导入需 masterdata.import 与目标维护权限');}
async function freshContext(tx:Tx,ctx:MasterDataContext):Promise<MasterDataContext>{
 // A5 grant writers take this singleton exclusively; hold it until this operation ends.
 await tx.query('select version from platform_authorization_state where id=1 for share');
 await expireBatchResources(tx);
 const auth=await resolveAuthorizationFrom(tx,ctx.userId!);const scope=await readUserScope(tx,ctx.userId!);
 return {...ctx,permissionCodes:auth.permissionCodes,access:{...ctx.access,userId:ctx.userId!,roles:auth.roleCodes,scopeVersion:scope.scopeVersion,rules:scope.rules}};
}
function bool(v:unknown){if(v==='true')return true;if(v==='false')return false;throw AppError.validation('布尔值必须为 true/false');}
function integer(v:unknown){if(typeof v!=='string'||!/^[-]?\d+$/.test(v)||!Number.isSafeInteger(Number(v)))throw AppError.validation('必须填写整数');return Number(v);}
function nullable(v:unknown){return v===''?null:v;}
const sameFields=(a:unknown,b:unknown,fields:string[])=>!!a&&fields.every(k=>isDeepStrictEqual((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
function errorDetail(row:ImportRow,key:string,e:unknown):ImportDetail {
 const app=e instanceof AppError?e:AppError.validation('该行无法校验');
 // Out-of-scope rows never include fetched values or existence clues.
 const message=app.status===404?'对象或引用不存在或不在授权范围内':app.message;
 return {...row,key,action:'error',before:null,after:null,errors:app.status!==404&&app.fieldErrors?.length?app.fieldErrors:[{field:'row',message}],input:{},dependency:null};
}
function orderedRows(rows:ImportRow[],kind:MasterDataImportKind):ImportRow[]{
 if(kind==='household')return [...rows].sort((a,b)=>String(a.values.enterpriseCode).localeCompare(String(b.values.enterpriseCode))||String(a.values.validFrom).localeCompare(String(b.values.validFrom))||a.row-b.row);
 if(!['category','dictionary_item'].includes(kind))return rows;
 const pending=[...rows],ordered:ImportRow[]=[];const keys=new Set(rows.map(r=>String(r.values.typeCode??'complaint_category')+':'+r.values.code));
 while(pending.length){const eligible=pending.filter(r=>!r.values.parentCode||!keys.has(String(r.values.typeCode??'complaint_category')+':'+r.values.parentCode)||ordered.some(p=>p.values.code===r.values.parentCode&&(p.values.typeCode??'complaint_category')===(r.values.typeCode??'complaint_category'))).sort((a,b)=>a.row-b.row);if(!eligible.length)return [...ordered,...pending];for(const r of eligible){ordered.push(r);pending.splice(pending.indexOf(r),1);}}
 return ordered;
}
/** Locks precede every validator: business/district/other types, enterprise,
 * admin, community, service-grid. A5 singleton is always acquired first. */
async function prelock(tx:Tx,rows:ImportRow[],kind:MasterDataImportKind){
 const dict=new Set<string>();const ent=new Set<string>();const admins=new Set<string>();const communities=new Set<string>();const grids=new Set<string>();
 for(const {values:v} of rows){
  if(kind==='dictionary_type')dict.add(String(v.code));if(kind==='dictionary_item'||kind==='category')dict.add(String(v.typeCode??'complaint_category'));
  if(kind==='enterprise'||kind==='service_grid'||kind==='grid_coverage')dict.add('business_type');if(kind==='enterprise'&&v.districtCode||kind==='admin_grid'||kind==='grid_boundary')dict.add('district');
  if(v.enterpriseCode)ent.add(String(v.enterpriseCode));if(kind==='admin_grid'||kind==='grid_boundary')admins.add(String(v.code));if(v.adminGridCode)admins.add(String(v.adminGridCode));if(kind==='community')communities.add(String(v.code));
  if(kind==='service_grid'||kind==='grid_coverage'){grids.add(String(v.code));const existing=await readGridIn(tx,String(v.code));if(existing){ent.add(existing.enterprise_code);const coverage=await readCoverageIn(tx,existing);coverage?.adminGridCodes.forEach(c=>admins.add(c));coverage?.communityCodes.forEach(c=>communities.add(c));}}
  if(kind==='grid_coverage'){if(v.relationKind==='admin_grid')admins.add(String(v.relationCode));if(v.relationKind==='community')communities.add(String(v.relationCode));}
 }
 for(const c of [...communities].sort()){const prior=await readCommunityIn(tx,c);if(prior)admins.add(prior.adminGridCode);}
 const sortType=(a:string,b:string)=>(a==='business_type'?0:a==='district'?1:2)-(b==='business_type'?0:b==='district'?1:2)||a.localeCompare(b);
 for(const code of [...dict].sort(sortType)){await readDictionaryType(tx,code,true);await readDictionaryItems(tx,code,true);}
 for(const code of [...ent].filter(Boolean).sort())await readEnterpriseIn(tx,code,true);
 for(const code of [...admins].sort())await readAdminIn(tx,code,true);
 for(const code of [...communities].sort())await readCommunityIn(tx,code,true);
 for(const code of [...grids].sort())await readGridIn(tx,code,true);
}
async function plan(tx:Tx,rawRows:ImportRow[],kind:MasterDataImportKind,ctx:MasterDataContext):Promise<ImportDetail[]>{
 assertImportPermission(kind,ctx);await prelock(tx,rawRows,kind);let rows=orderedRows(rawRows,kind);
 if(kind==='grid_coverage'){
  const groups=new Map<string,ImportRow[]>();for(const r of rows){const key=String(r.values.code);groups.set(key,[...(groups.get(key)??[]),r]);}
  rows=[...groups.values()].map(group=>({...group[0],values:{...group[0].values,relations:group.map(r=>({kind:r.values.relationKind,code:r.values.relationCode,from:r.values.validFrom,to:r.values.validTo,row:r.row}))}}));
 }
 const details:ImportDetail[]=[];const seen=new Set<string>();const stagedItems=new Map<string,DictionaryItem[]>();const stagedPeriods=new Map<string,HouseholdVersion[]>();
 for(const row of rows){const v=row.values;let key=String(v.code??v.enterpriseCode??'');if(kind==='department_mapping')key=String(v.sourceSystem)+':'+v.sourceDepartmentCode;if(kind==='dictionary_item'||kind==='category')key=String(v.typeCode??'complaint_category')+':'+v.code;if(kind==='household')key=String(v.enterpriseCode)+':'+v.validFrom;
  try{
   if(seen.has(key))throw AppError.validation('文件内稳定键重复');seen.add(key);
   let input:Record<string,unknown>={},before:unknown=null,after:unknown=null,dependency:unknown=null,unchanged=false;
   if(kind==='dictionary_type'){
    const old=await readDictionaryType(tx,String(v.code),true);if(!old&&(await rowsIn(tx,'select item_code from dictionary_code_registry where type_code=? and item_code=? for share',[v.code,''])).length)throw AppError.conflict('类型编码曾使用，不能复用');input={code:v.code,name:v.name,status:v.status,published:bool(v.published),cascadeDisable:bool(v.cascadeDisable),expectedVersion:old?.version??0};const result=await dictionaryService.validateTypeInTx(tx,input as unknown as SaveTypeInput,ctx);before=result.before;after=result.type;dependency=result.dependency;unchanged=sameFields(before,after,['name','status','published']);
   }else if(kind==='dictionary_item'||kind==='category'){
    const typeCode=String(v.typeCode??'complaint_category');const type=await readDictionaryType(tx,typeCode,true);if(!type)throw AppError.validation('字典类型未登记');const actual=await readDictionaryItems(tx,typeCode,true);const items=stagedItems.get(typeCode)??actual;const old=actual.find(i=>i.code===v.code);
    const registry=await rowsIn(tx,'select item_code from dictionary_code_registry where type_code=? and item_code=? for share',[typeCode,v.code]);if(!old&&registry.length)throw AppError.conflict('编码曾使用，不能复用');
    input={typeCode,code:v.code,label:v.label,parentCode:nullable(v.parentCode),sort:integer(v.sort),status:v.status,published:bool(v.published),cascadeDisable:bool(v.cascadeDisable),expectedVersion:old?.version??0,expectedTypeVersion:type.version};
    const result=validateDictionaryItemState(input as unknown as SaveItemInput,type,items,ctx);before=old??null;after=result.item;dependency=result.dependency;unchanged=sameFields(before,after,['label','parentCode','sort','status','published']);
    const next=items.filter(i=>i.code!==result.item.code);next.push(result.item);if(result.item.status==='disabled'&&input.cascadeDisable)for(const item of next)if(item.parentCode===result.item.code)item.status='disabled';stagedItems.set(typeCode,next);
   }else if(kind==='enterprise'){
    const old=await readEnterpriseIn(tx,String(v.enterpriseCode),true);input={...v,expectedVersion:old?.version??0};for(const f of ['districtCode','uscc','legalPerson','contactPerson','contactPhone','serviceArea','address'])if(f in v)input[f]=nullable(v[f]);if(v.disableReason==='')delete input.disableReason;
    const business=await readDictionaryType(tx,'business_type',true);const district=v.districtCode?await readDictionaryType(tx,'district',true):null;if(business)input.expectedBusinessTypeVersion=business.version;if(district)input.expectedDistrictVersion=district.version;
    const result=await enterpriseService.validateInTx(tx,input as unknown as EnterpriseWriteInput,ctx);before=result.before;after=result.value;dependency=result.dependency;unchanged=sameFields(before,after,['enterpriseName','businessType','status','districtCode','uscc','legalPerson','contactPerson','contactPhone','serviceArea','address']);
   }else if(kind==='household'){
    const enterprise=await readEnterpriseIn(tx,String(v.enterpriseCode),true);input={...v,households:v.households===''?null:integer(v.households),validTo:nullable(v.validTo),expectedVersion:enterprise?.version??0};
    const result=await enterpriseService.validateHouseholdsInTx(tx,input as unknown as HouseholdWriteInput,ctx);const history=stagedPeriods.get(String(v.enterpriseCode))??result.history.map(h=>({...h}));const period=validateHouseholdPeriod(result.input,history);before=period.same??null;after={enterpriseCode:v.enterpriseCode,households:input.households,validFrom:v.validFrom,validTo:input.validTo};dependency={...result.dependency,history:result.history};unchanged=!!period.same;
    if(!period.same){if(period.closing)period.closing.validTo=String(v.validFrom);history.push({...(after as Omit<HouseholdVersion,'version'>),version:'staged'});}stagedPeriods.set(String(v.enterpriseCode),history);
   }else if(kind==='department_mapping'){
    const enterprise=await readEnterpriseIn(tx,String(v.enterpriseCode),true);const old=(await rowsIn(tx,'select version from enterprise_department_mapping where source_system=? and source_department_code=? for update',[v.sourceSystem,v.sourceDepartmentCode]))[0];let aliases:unknown;try{aliases=JSON.parse(String(v.aliases));}catch{throw AppError.validation('aliases 必须为 JSON 字符串数组');}
    input={...v,aliases,verified:bool(v.verified),expectedVersion:Number(old?.version??0),expectedEnterpriseVersion:enterprise?.version??0};const result=await enterpriseService.validateMappingInTx(tx,input as unknown as DepartmentMappingInput,ctx);before=result.before;after=result.input;dependency=result.dependency;const oldAliases=result.before?typeof result.before.aliases==='string'?JSON.parse(result.before.aliases):result.before.aliases:null;unchanged=!!result.before&&result.before.source_department_name===input.sourceDepartmentName&&Boolean(Number(result.before.verified))===input.verified&&isDeepStrictEqual(oldAliases,[...new Set(aliases as string[])].sort());
   }else if(kind==='admin_grid'||kind==='grid_boundary'){
    const old=await readAdminIn(tx,String(v.code),true);if(kind==='grid_boundary'&&!old)throw AppError.validation('边界只能绑定已登记行政网格');input=kind==='grid_boundary'?{code:v.code,name:old!.name,districtCode:old!.districtCode,geometry:v.geometry,coordinateSystem:v.coordinateSystem,geometrySource:v.geometrySource,expectedVersion:old!.version}:{...v,geometry:old?.geometry??null,coordinateSystem:old?.coordinateSystem??null,geometrySource:old?.geometrySource??null,expectedVersion:old?.version??0};
    const district=await readDictionaryType(tx,'district',true);if(district)input.expectedDistrictVersion=district.version;const result=await serviceGridService.validateAdminInTx(tx,input as unknown as AdminGridInput,ctx);before=result.before;after=result.value;dependency=result.dependency;unchanged=isDeepStrictEqual(before,after);
   }else if(kind==='community'){
    const old=await readCommunityIn(tx,String(v.code),true);const parent=await readAdminIn(tx,String(v.adminGridCode),true);input={...v,expectedVersion:old?.version??0,expectedAdminVersion:parent?.version??0};const result=await serviceGridService.validateCommunityInTx(tx,input as unknown as CommunityInput,ctx);before=result.before;after=result.value;dependency=result.dependency;unchanged=isDeepStrictEqual(before,after);
   }else if(kind==='service_grid'){
    const old=await readGridIn(tx,String(v.code),true);input={...v,expectedVersion:old?.version??0};const result=await serviceGridService.validateRegistrationInTx(tx,input as unknown as GridRegistrationInput,ctx);Object.assign(input,{expectedEnterpriseVersion:result.dependency.enterpriseVersion,expectedBusinessTypeVersion:result.dependency.businessTypeVersion});before=result.before;after=result.value;dependency=result.dependency;unchanged=!!before;
   }else {
    const old=await readGridIn(tx,String(v.code),true);const current=old?await readCoverageIn(tx,old):null;let adminGridCodes:string[],communityCodes:string[];
    if(kind==='grid_coverage'){
     if(!old||!current||!old.enterprise_code)throw AppError.validation('覆盖关系需先导入登记服务网格');const relations=v.relations as {kind:string;code:string;from:string;to:string;row:number}[];const signatures=relations.map(r=>r.kind+':'+r.code);if(new Set(signatures).size!==signatures.length||relations.some(r=>!['admin_grid','community'].includes(r.kind)||r.from!==v.validFrom||r.to!==v.validTo))throw AppError.validation('覆盖关系重复、类型无效或同网格有效期不一致');adminGridCodes=relations.filter(r=>r.kind==='admin_grid').map(r=>r.code).sort();communityCodes=relations.filter(r=>r.kind==='community').map(r=>r.code).sort();
    }else {adminGridCodes=[String(v.adminGridCode)];communityCodes=[];}
    input={code:v.code,enterpriseCode:kind==='grid_coverage'?old!.enterprise_code:v.enterpriseCode,businessType:kind==='grid_coverage'?old!.business_type:v.businessType,validFrom:v.validFrom,validTo:nullable(v.validTo),adminGridCodes,communityCodes,expectedVersion:old?.version??0};
    const result=await serviceGridService.validateInTx(tx,input as unknown as ServiceGridInput,ctx);Object.assign(input,{expectedEnterpriseVersion:result.dependency.enterpriseVersion,expectedBusinessTypeVersion:result.dependency.businessTypeVersion,expectedAdminVersions:result.dependency.adminVersions,expectedCommunityVersions:result.dependency.communityVersions});before=current;after=result.value;dependency=result.dependency;unchanged=result.same;
   }
   // Display uses canonical safe master fields only; internal expected versions stay private.
   details.push({...row,key,action:unchanged?'unchanged':before?'update':'create',before,after,errors:[],input,dependency});
  }catch(e){if(e instanceof AppError&&e.status===403)throw e;details.push(errorDetail(row,key,e));}
 }
 return details;
}
function counts(details:ImportDetail[]):ImportPreview['counts'] {return {total:details.length,create:details.filter(d=>d.action==='create').length,update:details.filter(d=>d.action==='update').length,unchanged:details.filter(d=>d.action==='unchanged').length,error:details.filter(d=>d.action==='error').length};}
async function authorizeBatch(tx:Tx,b:ImportBatch,ctx:MasterDataContext){assertImportPermission(b.kind,ctx);if(b.ownerId!==ctx.userId)throw AppError.notFound('批次不存在或无权访问');
 for(const d of b.scopeProofs){const v=d.values;let allowed=false;
  if(['dictionary_type','dictionary_item','category'].includes(b.kind))allowed=true;
  else if(['enterprise','household','department_mapping'].includes(b.kind)){const current=await readEnterpriseIn(tx,String(v.enterpriseCode));allowed=canAccessEnterprise(ctx.access,{enterpriseCode:String(v.enterpriseCode),districtCode:current?.districtCode??(v.districtCode?String(v.districtCode):null)})&&canAccessEnterprise(ctx.access,{enterpriseCode:String(v.enterpriseCode),districtCode:v.districtCode===undefined?current?.districtCode??null:v.districtCode?String(v.districtCode):null});}
  else if(b.kind==='admin_grid'||b.kind==='grid_boundary'){const current=await readAdminIn(tx,String(v.code));allowed=canAccessSpatialMaster(ctx.access,current?.districtCode??String(v.districtCode??''))&&canAccessSpatialMaster(ctx.access,String(v.districtCode??current?.districtCode??''));}
  else if(b.kind==='community'){const current=await readCommunityIn(tx,String(v.code));const target=await readAdminIn(tx,String(v.adminGridCode));const old=current?await readAdminIn(tx,current.adminGridCode):target;allowed=ctx.access.rules.some(r=>r.kind==='all')||!!target&&!!old&&canAccessSpatialMaster(ctx.access,target.districtCode)&&canAccessSpatialMaster(ctx.access,old.districtCode);}
  else {const current=await readGridIn(tx,String(v.code));const coverage=current?await readCoverageIn(tx,current):null;const proposed=d.input.adminGridCodes as string[]|undefined;const districts:(string|null)[]=[];for(const code of [...new Set([...(coverage?.adminGridCodes??[]),...(proposed??[])])])districts.push((await readAdminIn(tx,code))?.districtCode??null);allowed=current?.import_state==='draft'||!current&&b.kind==='service_grid'?ctx.access.rules.some(r=>r.kind==='all'):canAccessGridCoverage(ctx.access,String(current?.enterprise_code??v.enterpriseCode??''),districts);}
  if(!allowed)throw AppError.notFound('批次对象不在当前授权范围内');
 }
}
function publicDetail(d:ImportDetail){const {input,dependency,...publicValue}=d;return publicValue;}
function scopeProofs(details:ImportDetail[]):ImportBatch['scopeProofs']{return details.map(d=>({values:Object.fromEntries(['code','enterpriseCode','districtCode','adminGridCode'].filter(k=>k in d.values).map(k=>[k,d.values[k]])),input:{adminGridCodes:d.input.adminGridCodes??[]}}));}
async function summaryAudit(tx:Tx,b:ImportBatch,ctx:MasterDataContext,action:'MASTER_IMPORT_COMMIT'|'MASTER_IMPORT_FAILED'|'MASTER_IMPORT_ERRORS_DOWNLOAD'){
 await insertAudit(tx,{userId:ctx.userId,appCode:'gqxq',resourceCode:'masterdata.import',bizType:'master_import',bizId:b.id,action,result:action==='MASTER_IMPORT_FAILED'?'failed':'success',clientIp:ctx.clientIp,createdAt:new Date(),detail:{batchId:b.id,kind:b.kind,templateVersion:b.preview.templateVersion,previewVersion:b.preview.previewVersion,created:b.result?.created??0,updated:b.result?.updated??0,unchanged:b.result?.unchanged??0,state:b.result?.state??'preview'}});
}
export class MasterDataImportService {
 async previewImport(file:ImportFile,kind:MasterDataImportKind,ctx:MasterDataContext):Promise<ImportPreview>{assertImportPermission(kind,ctx);const parsed=await parseImportFile(file,kind);return withTransaction(async tx=>{const current=await freshContext(tx,ctx);assertImportPermission(kind,current);await expireBatchResources(tx);const details=await plan(tx,parsed.rows,kind,current);const preview:ImportPreview={batchId:'IMP-'+randomUUID(),templateVersion:TEMPLATE_VERSION,previewVersion:1,expiresAt:new Date(Date.now()+IMPORT_LIMITS.expiresHours*3600000).toISOString(),counts:counts(details),canCommit:details.every(d=>!d.errors.length)};await insertBatch(tx,{id:preview.batchId,ownerId:ctx.userId!,kind,hash:hash(file.bytes),file:file.bytes,preview,details,scopeProofs:scopeProofs(details),requestId:null,result:null,accessVersion:current.access.scopeVersion});return preview;});}
 async getBatch(id:string,ctx:MasterDataContext,page=1,size=50){return withTransaction(async tx=>{const current=await freshContext(tx,ctx);const b=await readBatch(tx,id);if(!b)throw AppError.notFound('批次不存在');await authorizeBatch(tx,b,current);const expired=Date.now()>=Date.parse(b.preview.expiresAt);return {kind:b.kind,preview:{...b.preview,canCommit:b.preview.canCommit&&!expired&&!b.result},result:b.result,expired,details:expired?[]:b.details.slice((page-1)*size,page*size).map(publicDetail),total:b.details.length,page,size};});}
 async list(kind:MasterDataImportKind,ctx:MasterDataContext,page=1,size=20){return withTransaction(async tx=>{const current=await freshContext(tx,ctx);assertImportPermission(kind,current);const ids=await batchIds(tx,ctx.userId!,kind,page,size);const content=[];for(const id of ids){const b=(await readBatch(tx,id))!;try{await authorizeBatch(tx,b,current);content.push({kind:b.kind,preview:b.preview,result:b.result});}catch(e){if(!(e instanceof AppError&&e.status===404))throw e;}}return {content,page,size};});}
 async errors(id:string,ctx:MasterDataContext):Promise<string>{return withTransaction(async tx=>{const current=await freshContext(tx,ctx);const b=await readBatch(tx,id);if(!b)throw AppError.notFound('批次不存在');await authorizeBatch(tx,b,current);if(Date.now()>=Date.parse(b.preview.expiresAt))throw AppError.conflict('错误明细已过保留期，请重新上传');await summaryAudit(tx,b,current,'MASTER_IMPORT_ERRORS_DOWNLOAD');return '\uFEFF'+[['工作表','行号','业务键','字段','错误'],...b.details.flatMap(d=>d.errors.map(e=>[d.sheet,d.row,d.key,e.field,e.message]))].map(row=>row.map(safeCsvCell).join(',')).join('\r\n');});}
 async commitImport(args:{batchId:string;previewVersion:number;requestId:string},ctx:MasterDataContext):Promise<ImportBatchResult>{
  if(!Number.isSafeInteger(args.previewVersion)||args.previewVersion<1||!/^[-A-Za-z0-9_.:]{1,128}$/.test(args.requestId))throw AppError.validation('确认版本或幂等键无效');let attempted=false;
  try{return await withTransaction(async tx=>{const current=await freshContext(tx,ctx);const b=await readBatch(tx,args.batchId,true);if(!b)throw AppError.notFound('批次不存在');await authorizeBatch(tx,b,current);
   if(b.preview.previewVersion!==args.previewVersion)throw AppError.conflict('预览版本已变化');if(b.requestId&&b.requestId!==args.requestId)throw AppError.conflict('批次已由不同请求确认');if(b.result)return b.result;
   if(!b.preview.canCommit||!b.file||Date.now()>=Date.parse(b.preview.expiresAt)||b.accessVersion!==current.access.scopeVersion)throw AppError.conflict('预览失效，请重新上传核对');if(hash(b.file)!==b.hash)throw AppError.conflict('文件哈希变化，请重新上传');
   const replayRows=b.kind==='grid_coverage'?b.details.flatMap(d=>(d.values.relations as {kind:string;code:string;from:string;to:string;row:number}[]).map(r=>({sheet:d.sheet,row:r.row,values:{code:d.values.code,validFrom:r.from,validTo:r.to,relationKind:r.kind,relationCode:r.code}}))):b.details.map(d=>({sheet:d.sheet,row:d.row,values:d.values}));
   const details=await plan(tx,replayRows,b.kind,current);
   const fingerprint=(items:ImportDetail[])=>items.map(d=>({key:d.key,action:d.action,before:d.before,input:d.input,dependency:d.dependency,errors:d.errors}));
   if(!isDeepStrictEqual(fingerprint(details),fingerprint(b.details)))throw AppError.conflict('主数据或依赖版本已变化，请重新预览');
   attempted=true;let created=0,updated=0,unchanged=0;const touchedTypes=new Map<string,number>();const touchedEnterprises=new Map<string,number>();
   for(const d of details){const input={...d.input};if(touchedTypes.has(String(input.typeCode))){input.expectedTypeVersion=touchedTypes.get(String(input.typeCode));input.expectedVersion=(await readDictionaryItems(tx,String(input.typeCode),true)).find(i=>i.code===input.code)?.version??0;}if(b.kind==='household'&&touchedEnterprises.has(String(input.enterpriseCode)))input.expectedVersion=touchedEnterprises.get(String(input.enterpriseCode));
    let result:{changed:boolean;version:number;dictionaryVersion?:number};
    if(b.kind==='dictionary_type')result=await dictionaryService.saveTypeInTx(tx,input as unknown as SaveTypeInput,current);
    else if(b.kind==='dictionary_item'||b.kind==='category'){result=await dictionaryService.saveItemInTx(tx,input as unknown as SaveItemInput,current);touchedTypes.set(String(input.typeCode),result.dictionaryVersion!);}
    else if(b.kind==='enterprise')result=await enterpriseService.saveInTx(tx,input as unknown as EnterpriseWriteInput,current);
    else if(b.kind==='household'){result=await enterpriseService.saveHouseholdsInTx(tx,input as unknown as HouseholdWriteInput,current);touchedEnterprises.set(String(input.enterpriseCode),result.version);}
    else if(b.kind==='department_mapping')result=await enterpriseService.saveMappingInTx(tx,input as unknown as DepartmentMappingInput,current);
    else if(b.kind==='admin_grid'||b.kind==='grid_boundary')result=await serviceGridService.saveAdminInTx(tx,input as unknown as AdminGridInput,current);
    else if(b.kind==='community')result=await serviceGridService.saveCommunityInTx(tx,input as unknown as CommunityInput,current);
    else if(b.kind==='service_grid')result=await serviceGridService.registerInTx(tx,input as unknown as GridRegistrationInput,current);
    else result=await serviceGridService.saveInTx(tx,input as unknown as ServiceGridInput,current);
    if(!result.changed)unchanged++;else if(d.action==='create')created++;else updated++;
   }
   b.requestId=args.requestId;b.result={batchId:b.id,state:'succeeded',created,updated,unchanged,failureReason:null,completedAt:new Date().toISOString()};await finishBatch(tx,b);if(b.result.created+b.result.updated>0)await summaryAudit(tx,b,current,'MASTER_IMPORT_COMMIT');return b.result;
  });}catch(e){if(!attempted)throw e;
   // The mutation transaction has rolled back before this independent result write.
   return withTransaction(async tx=>{const current=await freshContext(tx,ctx);const b=await readBatch(tx,args.batchId,true);if(!b)throw e;await authorizeBatch(tx,b,current);if(b.requestId&&b.requestId!==args.requestId)throw AppError.conflict('批次已由不同请求确认');if(b.result)return b.result;b.requestId=args.requestId;b.result={batchId:b.id,state:'failed',created:0,updated:0,unchanged:0,failureReason:e instanceof AppError?e.message:'执行失败，整批主数据已回滚',completedAt:new Date().toISOString()};await finishBatch(tx,b);await summaryAudit(tx,b,current,'MASTER_IMPORT_FAILED');return b.result;});
  }
 }
}
export const masterDataImportService=new MasterDataImportService();
/** Server-owned retention erasure only: no reads returned, master writes,
 * source ingress, inherited user authority or trusted-system scope bypass. */
export async function pruneExpiredImports(){return withTransaction(tx=>expireBatchResources(tx));}
