import type {Tx} from '../db/tx';
import {AppError} from '../http/errors';
import {eventRows} from '../repositories/sourceBusinessRepo';
import {resolveAuthorizationFrom} from '../repositories/roleRepo';
import {readUserScope} from '../repositories/userScopeRepo';
import type {BusinessEventContext} from '../types/businessEvents';
export function featurePermission(ctx:BusinessEventContext,permission:string,whole=false){if(!ctx.permissionCodes.includes(permission)||whole&&!ctx.access.rules.some(r=>r.kind==='all'))throw AppError.forbidden();}
export async function currentFeatureActor(tx:Tx,ctx:BusinessEventContext,permission:string,whole=false):Promise<BusinessEventContext>{
 await tx.query('select version from platform_authorization_state where id=1 for share');
 const user=(await eventRows(tx,'select status from app_user where user_id=? for share',[ctx.userId]))[0];if(!user||Number(user.status)!==1)throw AppError.forbidden();
 const auth=await resolveAuthorizationFrom(tx,ctx.userId),scope=await readUserScope(tx,ctx.userId);
 if(auth.roleCodes.includes('readonly'))throw AppError.forbidden();
 const current={...ctx,permissionCodes:auth.permissionCodes,access:{...ctx.access,roles:auth.roleCodes,...scope}};featurePermission(current,permission,whole);return current;
}
