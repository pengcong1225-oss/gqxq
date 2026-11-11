import {AppError} from '../http/errors';
import type {BusinessSourceConfig} from '../types/businessEvents';
export interface FollowupBinding {sourceId:string;keyId:string;complaintId:string;sourceSystem:string;sourceObjectId:string;enterpriseCode:string|null}
/** Authority comes from operator configuration and the locked target, never payload ownership. */
export function bindFollowupTarget(config:BusinessSourceConfig,target:Record<string,unknown>):FollowupBinding {
 const grants=Array.isArray(config.complaintTargets)?config.complaintTargets:[];
 const grant=grants.find(g=>g&&g.sourceSystem===target.source_system&&(g.allEnterprises===true||typeof target.enterprise_code==='string'&&Array.isArray(g.enterpriseCodes)&&g.enterpriseCodes.includes(target.enterprise_code)));
 if(!grant||!target.source_id)throw AppError.forbidden('该签名来源未获目标诉求范围授权');
 return {sourceId:config.sourceId,keyId:config.keyId,complaintId:String(target.complaint_id),sourceSystem:String(target.source_system),sourceObjectId:String(target.source_id),enterpriseCode:target.enterprise_code==null?null:String(target.enterprise_code)};
}
