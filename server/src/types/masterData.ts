import type { OperatorContext } from '../services/dispatchService';
import type { AccessContext } from '../auth/accessScope';
export interface MasterDataContext extends OperatorContext { permissionCodes: readonly string[]; access: AccessContext }
export interface CategoryRef { majorCode: string; minorCode: string | null; dictionaryVersion: string }
export interface DictionaryType { code: string; name: string; status: 'enabled'|'disabled'; version: number; published: boolean; readOnly: boolean; fixedCodes: boolean }
export interface DictionaryItem { itemId: string; typeCode: string; code: string; label: string; parentCode: string|null; sort: number; status: 'enabled'|'disabled'; version: number; published: boolean }
export interface SaveTypeInput { code: string; name: string; expectedVersion: number; status?: 'enabled'|'disabled'; published?: boolean; cascadeDisable?: boolean }
export interface SaveItemInput { typeCode: string; code: string; label: string; parentCode?: string|null; sort?: number; status?: 'enabled'|'disabled'; published?: boolean; expectedVersion: number; expectedTypeVersion?: number; cascadeDisable?: boolean }
export interface DictionaryChange<T> { key: string; changed: boolean; version: number; dictionaryVersion: number; value: T }
