export type MasterDataImportKind='enterprise'|'department_mapping'|'household'|'dictionary_type'|'dictionary_item'|'category'|'admin_grid'|'community'|'service_grid'|'grid_coverage'|'grid_boundary';
export interface ImportFile {name:string;bytes:Buffer}
export interface ImportRow {sheet:string;row:number;values:Record<string,unknown>}
export interface ImportDetail extends ImportRow {key:string;action:'create'|'update'|'unchanged'|'error';before:unknown;after:unknown;errors:{field:string;message:string}[];input:Record<string,unknown>;dependency:unknown}
export interface ImportPreview {batchId:string;templateVersion:string;previewVersion:number;expiresAt:string;counts:{total:number;create:number;update:number;unchanged:number;error:number};canCommit:boolean}
export interface ImportBatchResult {batchId:string;state:'succeeded'|'failed';created:number;updated:number;unchanged:number;failureReason:string|null;completedAt:string}
export interface ImportBatch {id:string;ownerId:string;kind:MasterDataImportKind;hash:string;file:Buffer|null;preview:ImportPreview;details:ImportDetail[];scopeProofs:{values:Record<string,unknown>;input:Record<string,unknown>}[];requestId:string|null;result:ImportBatchResult|null;accessVersion:number}
