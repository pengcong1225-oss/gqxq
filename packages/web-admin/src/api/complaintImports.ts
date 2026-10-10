import request from './request';
export interface ComplaintImportPreview {batchId:string;name:string;expiresAt:string;counts:{total:number;unique:number;duplicates:number;create:number;skip:number;error:number};canCommit:boolean}
export interface ComplaintImportResult {batchId:string;state:'succeeded';created:number;skipped:number;completedAt:string}
export interface ComplaintImportDetail {row:number;sourceId:string;title:string;businessType:string|null;complaintType:string|null;districtName:string|null;action:'create'|'skip'|'duplicate'|'error';errors:string[]}
export interface ComplaintImportBatch {preview:ComplaintImportPreview;result:ComplaintImportResult|null;expired:boolean;details:ComplaintImportDetail[]}
export type ComplaintImportSummary=Omit<ComplaintImportBatch,'details'>;
export async function previewComplaintImport(file:File,expectedToken:string,isCurrent:()=>boolean):Promise<ComplaintImportPreview>{const bytes=await file.arrayBuffer();if(!isCurrent())throw Error('登录身份或权限已改变，请重新选择文件');return request.post('/complaint-imports/preview',bytes,{params:{name:file.name},headers:{'Content-Type':'application/octet-stream',Authorization:`Bearer ${expectedToken}`},timeout:60000}) as unknown as Promise<ComplaintImportPreview>;}
export const getComplaintImport=(id:string)=>request.get('/complaint-imports/'+encodeURIComponent(id)) as unknown as Promise<ComplaintImportBatch>;
export const listComplaintImports=()=>request.get('/complaint-imports') as unknown as Promise<ComplaintImportSummary[]>;
export const commitComplaintImport=(id:string,requestId:string)=>request.post('/complaint-imports/'+encodeURIComponent(id)+'/commit',{requestId},{timeout:120000}) as unknown as Promise<ComplaintImportResult>;
