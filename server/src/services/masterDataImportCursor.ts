import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {env} from '../config/env';
import {AppError} from '../http/errors';
import type {ImportBatchPosition} from '../repositories/masterDataImportRepo';

// Reuse the configured server secret with a domain-specific derived key. AES-GCM
// conceals skipped batch IDs and authenticates owner/kind/size on every request.
const key=createHash('sha256').update('master-import-continuation-v1\0').update(env.jwtSecret).digest();
export function encodeImportCursor(position:ImportBatchPosition,owner:string,kind:string,size:number):string{
 const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.from(JSON.stringify({version:1,owner,kind,size,position}));
 const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');
}
export function decodeImportCursor(value:string,owner:string,kind:string,size:number):ImportBatchPosition{
 try{
  if(value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
  const bytes=Buffer.from(value,'base64url');if(bytes.length<29)throw Error();
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
  const data=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  if(data.version!==1||data.owner!==owner||data.kind!==kind||data.size!==size||typeof data.position?.id!=='string'||typeof data.position?.createdAt!=='string'||!Number.isFinite(Date.parse(data.position.createdAt)))throw Error();
  return data.position;
 }catch{throw AppError.validation('批次续页参数无效，请刷新列表');}
}
