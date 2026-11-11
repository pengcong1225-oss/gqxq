import type {StatisticsQuery} from './statistics';
export interface ReportCreateInput {requestId:string;templateCode:'statistics-draft';templateVersion:'v1';query:StatisticsQuery;format:'docx'|'xlsx';includeHeat:boolean;todoIds:string[]}
export interface ReportArtifact {reportId:string;snapshotId:string;templateCode:string;templateVersion:string;format:'docx'|'xlsx';state:'pending'|'generating'|'succeeded'|'failed';contentHash:string|null;byteLength:number|null;failureReason:string|null;createdAt:string;dataCutoffAt:string}
export interface ReportPage {content:ReportArtifact[];hasMore:boolean;continuation:string|null}
