import {pool} from '../db/pool';
import {AppError} from '../http/errors';
import {assertAllScope} from '../auth/accessScope';
import {insertAudit} from '../repositories/auditLogRepo';
import {shanghaiToday} from '../domain/statisticsQuery';
import {simulatedSupportData,defaultSupportWarnings} from '../domain/tenderSupportData';
import {scopeSupportDataset,validateSupportDataset,validateSupportWarnings} from '../domain/tenderSupportValidation';
import type {MasterDataContext} from '../types/masterData';
import type {TenderDataset,SupportWarningConfig} from '../types/tenderSupport';
export function supportMode(raw:unknown):'real'|'simulation'{if(raw!=='real'&&raw!=='simulation')throw AppError.validation('请选择模拟或真实数据');return raw;}
const decoded=(v:any)=>typeof v==='string'?JSON.parse(v):v;
function requireRead(ctx:MasterDataContext){if(!ctx.permissionCodes.includes('statistics.read')||!ctx.permissionCodes.includes('complaint.read'))throw AppError.forbidden('专题明细需要统计和诉求查询权限');}
function requireWrite(ctx:MasterDataContext,permission:string){requireRead(ctx);if(!ctx.userId||!ctx.permissionCodes.includes(permission)||ctx.access.roles.includes('readonly'))throw AppError.forbidden();assertAllScope(ctx.access);}
export async function readSupportStore(key:string){const [rows]=await pool.query<any[]>('select revision,content from gqxq_tender_support_store where store_key=?',[key]);return rows[0]?{revision:Number(rows[0].revision),content:decoded(rows[0].content)}:null;}
export async function supportDataset(mode:'simulation'|'real',ctx:MasterDataContext):Promise<TenderDataset>{
 requireRead(ctx);const today=shanghaiToday(()=>new Date());
 const real=mode==='real'?await readSupportStore('dataset-real'):null;
 const data=mode==='simulation'?simulatedSupportData(today):real?{...real.content,revision:real.revision}: {schemaVersion:1,mode:'real',revision:0,sourceLabel:'尚未接入真实专题数据',updatedAt:today+'T00:00:00+08:00',grids:[],communities:[],enterprises:[],complaints:[],events:[],pipelines:[]};
 return scopeSupportDataset(data,ctx.access);
}
export async function supportWarnings(mode:'simulation'|'real',ctx:MasterDataContext):Promise<SupportWarningConfig>{requireRead(ctx);const r=await readSupportStore('warnings-'+mode);return r?{...r.content,revision:r.revision}:{...defaultSupportWarnings,rules:defaultSupportWarnings.rules.map(r=>({...r,enabled:mode==='simulation'}))};}
export async function saveSupportStore(key:string,value:unknown,expected:number,ctx:MasterDataContext){
 if(!Number.isSafeInteger(expected)||expected<0)throw AppError.validation('缺少有效数据版本，请重新预览');
 const db=await pool.getConnection();try{await db.beginTransaction();
  await db.execute("insert ignore into gqxq_tender_support_store(store_key,revision,content,updated_by,updated_at) values(?,0,JSON_OBJECT(),?,NOW())",[key,ctx.userId]);
  const [rows]=await db.query<any[]>('select revision from gqxq_tender_support_store where store_key=? for update',[key]);
  if(Number(rows[0].revision)!==expected)throw AppError.conflict('数据已更新，请刷新后重新预览');
  const revision=expected+1,content=JSON.stringify(value);
  await db.execute('insert into gqxq_tender_support_history(store_key,revision,content,updated_by,updated_at) values(?,?,?,?,NOW())',[key,revision,content,ctx.userId]);
  await db.execute('update gqxq_tender_support_store set revision=?,content=?,updated_by=?,updated_at=NOW() where store_key=?',[revision,content,ctx.userId,key]);
  await insertAudit(db,{userId:ctx.userId,appCode:'gqxq',resourceCode:'tender_support',action:'TENDER_SUPPORT_SAVE',bizType:'tender_support',bizId:key,result:'success',clientIp:ctx.clientIp,createdAt:new Date(),detail:{key,revision}});
  await db.commit();return revision;
 }catch(e){await db.rollback();throw e;}finally{db.release();}
}
export async function previewSupportImport(raw:unknown,ctx:MasterDataContext){requireWrite(ctx,'masterdata.import');const d=validateSupportDataset(raw,true),current=await readSupportStore('dataset-real');return {expectedRevision:current?.revision??0,sourceLabel:d.sourceLabel,counts:{grids:d.grids.length,communities:d.communities.length,enterprises:d.enterprises.length,complaints:d.complaints.length,events:d.events.length,pipelines:d.pipelines?.length??0}};}
export async function importSupportData(raw:any,ctx:MasterDataContext){requireWrite(ctx,'masterdata.import');const d=validateSupportDataset(raw?.dataset,true);return {revision:await saveSupportStore('dataset-real',{...d,updatedAt:new Date().toISOString()},raw.expectedRevision,ctx)};}
export async function updateSupportWarnings(mode:'simulation'|'real',raw:unknown,ctx:MasterDataContext){requireWrite(ctx,'heatmap.manage');const d=validateSupportWarnings(raw);return {...d,revision:await saveSupportStore('warnings-'+mode,d,d.revision,ctx)};}
