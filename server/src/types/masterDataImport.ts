export type MasterDataImportKind='enterprise'|'department_mapping'|'household'|'dictionary_type'|'dictionary_item'|'category'|'admin_grid'|'community'|'service_grid'|'grid_coverage'|'grid_boundary';
export interface ImportFile {name:string;bytes:Buffer}
export interface ImportRow {sheet:string;row:number;values:Record<string,unknown>}
export interface ImportDetail extends ImportRow {key:string;action:'create'|'update'|'unchanged'|'error';before:unknown;after:unknown;errors:{field:string;message:string}[];input:Record<string,unknown>;dependency:unknown}
export interface ImportPreview {batchId:string;templateVersion:string;previewVersion:number;expiresAt:string;counts:{total:number;create:number;update:number;unchanged:number;error:number};canCommit:boolean}
export interface ImportBatchResult {batchId:string;state:'succeeded'|'failed';created:number;updated:number;unchanged:number;failureReason:string|null;completedAt:string}
export type ImportScopeFact={type:'all'}|{type:'enterprise';enterpriseCode:string;districtCode:string|null}|{type:'spatial';districtCode:string|null}|{type:'grid';enterpriseCode:string;districts:(string|null)[]};
export type ImportScopeReference={type:'enterprise'|'admin'|'community'|'grid';code:string}|{type:'mapping';sourceSystem:string;sourceDepartmentCode:string}|{type:'grid_members';enterpriseCode:string;adminCodes:string[];communityCodes:string[]};
export interface ImportScopeProof {version:1;original:ImportScopeFact[];proposed:ImportScopeFact[];references:ImportScopeReference[]}
export interface ImportBatch {id:string;ownerId:string;kind:MasterDataImportKind;hash:string;file:Buffer|null;preview:ImportPreview;details:ImportDetail[];scopeProofs:ImportScopeProof[];requestId:string|null;result:ImportBatchResult|null;accessVersion:number}
