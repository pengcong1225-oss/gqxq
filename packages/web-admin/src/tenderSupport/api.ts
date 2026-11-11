import request from '../api/request';
import type {TenderDataset,SupportWarningConfig} from './types';
export const getSupportData=(mode:string)=>request.get<never,TenderDataset>('/tender-support/dataset',{params:{mode}});
export const getSupportWarnings=(mode:string)=>request.get<never,SupportWarningConfig>('/tender-support/warning-rules',{params:{mode}});
export const putSupportWarnings=(mode:string,data:SupportWarningConfig)=>request.put<never,SupportWarningConfig>('/tender-support/warning-rules',data,{params:{mode}});
export interface ImportPreview {expectedRevision:number;sourceLabel:string;counts:Record<string,number>}
export const previewSupport=(data:unknown)=>request.post<never,ImportPreview>('/tender-support/dataset/preview',data);
export const importSupport=(dataset:unknown,expectedRevision:number)=>request.put('/tender-support/dataset',{dataset,expectedRevision});
export const downloadSupportReport=(mode:string,from:string,to:string,format:'docx'|'xlsx')=>request.get<never,Blob>('/tender-support/report',{params:{mode,from,to,format},responseType:'blob',timeout:60000});
