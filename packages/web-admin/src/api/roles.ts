import request from './request';
export interface PlatformRole {roleCode:string;name:string;description:string;enabled:boolean;builtIn:boolean;version:number;permissionCodes:string[]}
export interface PermissionItem {code:string;name:string;protected:boolean}
export interface RoleWrite {name:string;description?:string;enabled?:boolean;permissionCodes?:string[];expectedVersion:number;copyFrom?:string}
export function listRoles(){return request.get<never,PlatformRole[]>('/roles');}
export function getPermissions(){return request.get<never,PermissionItem[]>('/permissions');}
export function saveRole(roleCode:string,body:RoleWrite,creating:boolean){
 return creating ? request.post<never,PlatformRole>('/roles',{roleCode,...body}) : request.patch<never,PlatformRole>('/roles/'+encodeURIComponent(roleCode),body);
}
