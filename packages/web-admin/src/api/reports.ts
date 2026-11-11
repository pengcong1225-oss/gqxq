import request from './request';
import type {ReportCreateInput,ReportArtifact,ReportPage} from '../types/report';
const path=(id:string)=>'/reports/'+encodeURIComponent(id);
export const createReport=(input:ReportCreateInput)=>request.post<never,ReportArtifact>('/reports',input);
export const listReports=(continuation?:string)=>request.get<never,ReportPage>('/reports',{params:{size:20,continuation}});
export const getReport=(id:string)=>request.get<never,ReportArtifact>(path(id));
export const retryReport=(id:string)=>request.post<never,ReportArtifact>(path(id)+'/retry',{});
export async function downloadReport(id:string,format:'docx'|'xlsx'):Promise<Blob>{
 try{
  const bytes=await request.get<never,Blob>(path(id)+'/download',{responseType:'blob'});
  const mime=format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if(!(bytes instanceof Blob)||bytes.type!==mime||bytes.size===0||bytes.size>16*1024*1024)throw Error('报告下载内容不可核验');return bytes;
 }catch(e){
  const blob=(e as any)?.response?.data;
  if(blob instanceof Blob&&blob.type.includes('json')&&blob.size<=65536){let message:string|undefined;try{message=JSON.parse(await blob.text()).message;}catch{}if(message)throw Error(message);}
  throw e;
 }
}
