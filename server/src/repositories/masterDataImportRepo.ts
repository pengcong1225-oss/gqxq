import type {SqlExecutor} from './userRepo';
import type {ImportBatch} from '../types/masterDataImport';
import {rowsIn} from './serviceGridRepo';
const json=(v:unknown)=>typeof v==='string'?JSON.parse(v):v;
function view(r:Record<string,unknown>):ImportBatch{return {id:String(r.batch_id),ownerId:String(r.owner_id),kind:r.kind as ImportBatch['kind'],hash:String(r.file_hash),file:r.file_bytes as Buffer|null,preview:json(r.preview),details:json(r.details),scopeProofs:json(r.scope_proofs),requestId:r.request_id==null?null:String(r.request_id),result:json(r.result)??null,accessVersion:Number(r.access_version)};}
export async function readBatch(db:SqlExecutor,id:string,lock=false):Promise<ImportBatch|null>{const r=(await rowsIn(db,'select * from master_data_import_batch where batch_id=?'+(lock?' for update':''),[id]))[0];return r?view(r):null;}
export async function insertBatch(db:SqlExecutor,b:ImportBatch){await db.query('insert into master_data_import_batch(batch_id,owner_id,kind,file_hash,file_bytes,preview,details,scope_proofs,request_id,result,access_version,expires_at,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)',[b.id,b.ownerId,b.kind,b.hash,b.file,JSON.stringify(b.preview),JSON.stringify(b.details),JSON.stringify(b.scopeProofs),null,null,b.accessVersion,new Date(b.preview.expiresAt),new Date()]);}
export async function finishBatch(db:SqlExecutor,b:ImportBatch){await db.query('update master_data_import_batch set request_id=?,result=? where batch_id=?',[b.requestId,JSON.stringify(b.result),b.id]);}
export async function expireBatchResources(db:SqlExecutor){await db.query('update master_data_import_batch set file_bytes=null,details=JSON_ARRAY() where expires_at<=? and file_bytes is not null',[new Date()]);}
export interface ImportBatchPosition {id:string;createdAt:string}
export async function batchIds(db:SqlExecutor,owner:string,kind:string,size:number,after?:ImportBatchPosition):Promise<ImportBatchPosition[]>{
 const where=after?' and (created_at<? or (created_at=? and batch_id<?))':'';
 const date=after?new Date(after.createdAt):null;
 return (await rowsIn(db,'select batch_id,created_at from master_data_import_batch where owner_id=? and kind=?'+where+' order by created_at desc,batch_id desc limit ?',[owner,kind,...(after?[date,date,after.id]:[]),size])).map(r=>({id:String(r.batch_id),createdAt:(r.created_at as Date).toISOString()}));
}
