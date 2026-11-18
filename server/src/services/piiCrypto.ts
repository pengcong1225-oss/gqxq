import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {env} from '../config/env';

// 诉求人姓名/电话使用独立域密钥，避免与 JWT/批次游标共用同一密钥材料。
const key=createHash('sha256').update('complaint-citizen-pii-v1\0').update(env.jwtSecret).digest();

export function encryptPii(value:string):string{
 const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);
 const ct=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),ct]).toString('base64url');
}
export function decryptPii(value:string|null|undefined):string|null{
 if(!value)return null;
 try{
  const bytes=Buffer.from(value,'base64url');if(bytes.length<29)return null;
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
 }catch{return null;}
}
export function maskName(value:string):string{
 const v=value.trim();if(!v)return '';
 return v.length<=1?v:v[0]+'*'.repeat(Math.max(1,Math.min(v.length-1,4)));
}
export function maskPhone(value:string):string{
 const v=value.replace(/\s+/g,'');if(v.length<7)return '***';
 return v.slice(0,3)+'****'+v.slice(-4);
}
