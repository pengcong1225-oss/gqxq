import {spawn} from 'node:child_process';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {AppError} from '../http/errors';
import {preflightXlsx} from './masterDataImportParser';

export const COMPLAINT_IMPORT_LIMITS={bytes:10*1024*1024,rows:2000} as const;
const MAX_COLUMNS=64;
const MAX_OUTPUT_BYTES=30*1024*1024;
const REQUIRED_HEADERS=['案件公文号','诉求类型','来话内容','录入时间','案件主类型名','案件二级类型名'];
const METADATA_HEADERS=['案件类型名','案件主类型名','案件二级类型名','区','街道','社区','网格','接线员','在线办结依据','部门名称','二级单位','处理结果','规定完成时间','实际完成时间','坐席满意度','环境因素','督办状态','诉求类型','定位情况','前台备注'];
const BUSINESS_TYPES:Record<string,string>={'供水服务':'water','供气服务':'gas'};
const COMPLAINT_TYPES:Record<string,string>={'投诉类':'complaint','咨询类':'consult','建议类':'suggest','举报类':'report','求助类':'help','其他类':'other','表扬类':'praise'};

export interface ParsedComplaintRow {
 row:number; sourceId:string; title:string; content:string|null; address:string|null;
 districtName:string|null; businessType:string|null; complaintType:string|null;
 sourceReportedAt:string|null; metadata:Record<string,unknown>; errors:string[];
}

function blank(value:unknown):boolean{return value===null||value===undefined||(typeof value==='string'&&!value.trim());}
function chinaDate(value:unknown):string|null {
 // ExcelJS encodes an Excel serial's wall clock as UTC fields, not a UTC instant.
 if(value instanceof Date){if(!Number.isFinite(value.getTime())||value.getUTCFullYear()<1000||value.getUTCFullYear()>9999)return null;return value.toISOString().slice(0,19)+'+08:00';}
 if(typeof value!=='string')return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\+08:00)?$/.exec(value.trim());
 if(!match||Number(match[1])<1000)return null;
 const canonical=match.slice(1).join('').replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,'$1-$2-$3T$4:$5:$6');
 const time=new Date(canonical+'Z');
 if(!Number.isFinite(time.getTime())||time.toISOString().slice(0,19)!==canonical)return null;
 return canonical+'+08:00';
}

/** The header can follow an export title. Physical worksheet row numbers survive blank rows and duplicates. */
export function normalizeComplaintTable(table:unknown[][]):ParsedComplaintRow[] {
 if(!Array.isArray(table)||table.length>COMPLAINT_IMPORT_LIMITS.rows+5||table.some(row=>!Array.isArray(row)||row.length>MAX_COLUMNS))throw AppError.validation('诉求表行或列资源超限（最多 2000 数据行、64 列）');
 let expandedBytes=0;for(const row of table)for(const value of row)if(typeof value==='string'){expandedBytes+=Buffer.byteLength(value,'utf8');if(expandedBytes>COMPLAINT_IMPORT_LIMITS.bytes)throw AppError.validation('Excel 展开后的文字超过 10 MB，请拆批导入');}
 const headerIndex=table.slice(0,5).findIndex(row=>REQUIRED_HEADERS.every(header=>row.some(value=>typeof value==='string'&&value.trim()===header)));
 if(headerIndex<0)throw AppError.validation('前 5 行未找到综合查询所需表头字段');
 const headers=table[headerIndex].map(value=>blank(value)?'':typeof value==='string'?value.trim():null);
 if(headers.some(value=>value===null))throw AppError.validation('综合查询表头字段必须为文本');
 const named=headers.filter((value):value is string=>!!value);
 if(new Set(named).size!==named.length)throw AppError.validation('综合查询表头字段重复');
 const rows:ParsedComplaintRow[]=[];let normalizedBytes=2;
 for(let i=headerIndex+1;i<table.length;i++){
  const cells=table[i];if(cells.every(blank))continue;
  if(rows.length>=COMPLAINT_IMPORT_LIMITS.rows)throw AppError.validation('每批最多 2000 数据行，请拆批');
  const errors:string[]=[];const row=i+1;
  const error=(field:string,message:string)=>errors.push(`第 ${row} 行${field}${message}`);
  const get=(field:string):unknown=>{const index=headers.indexOf(field);return index<0?null:cells[index];};
  const text=(field:string,max=16000):string=>{
   const value=get(field);if(blank(value))return '';
   let result:string;
   if(typeof value==='string')result=value.trim();
   else if(typeof value==='number'&&Number.isFinite(value))result=String(value);
   else if(value instanceof Date&&chinaDate(value))result=chinaDate(value)!;
   else {error(field,'单元格类型无效');return '';}
   if(result.length>max||Buffer.byteLength(result,'utf8')>65535){error(field,'长度超限');return '';}
   return result;
  };
  if(cells.length>headers.length&&cells.slice(headers.length).some(value=>!blank(value)))error('数据','列数超过表头');
  const sourceId=text('案件公文号',128);
  if(!sourceId)error('案件公文号','不能为空');else if(!/^[A-Za-z0-9_-]+$/.test(sourceId))error('案件公文号','格式无效');
  const content=text('来话内容');const caseType=text('案件类型名');
  const titleBase=content.replace(/^【[^】]*】/,'').trim().split(/[。！？!?\r\n]/,1)[0].trim()||caseType;
  const title=titleBase.replace(/1[3-9]\d{9}/g,'[联系方式已隐去]').slice(0,120);
  if(!title)error('标题','不能为空');
  const address=text('详细地址',500)||null;const districtName=text('区',64)||null;
  const businessLabel=text('案件二级类型名');const businessType=Object.hasOwn(BUSINESS_TYPES,businessLabel)?BUSINESS_TYPES[businessLabel]:null;
  if(!businessType)error('案件二级类型名','无法精确映射业务类型');
  const complaintLabel=text('诉求类型');const complaintType=Object.hasOwn(COMPLAINT_TYPES,complaintLabel)?COMPLAINT_TYPES[complaintLabel]:null;
  if(!complaintType)error('诉求类型','无法映射诉求类型');
  const sourceReportedAt=chinaDate(get('录入时间'));
  if(!sourceReportedAt)error('录入时间','缺失或日期格式无效');
  const metadata:Record<string,unknown>={};
  for(const field of METADATA_HEADERS){if(headers.includes(field))metadata[field]=field==='案件类型名'?caseType:field==='案件二级类型名'?businessLabel:field==='诉求类型'?complaintLabel:field==='详细地址'?address:text(field);}
  const parsed={row,sourceId,title,content:content||null,address,districtName,businessType,complaintType,sourceReportedAt,metadata,errors:[...new Set(errors)]};
  normalizedBytes+=Buffer.byteLength(JSON.stringify(parsed),'utf8')+1;if(normalizedBytes>COMPLAINT_IMPORT_LIMITS.bytes)throw AppError.validation('Excel 展开后的诉求内容超过 10 MB，请拆批导入');rows.push(parsed);
 }
 if(!rows.length)throw AppError.validation('综合查询表没有数据行');
 return rows;
}

/** No shell, no temporary source files, and no workbook data in diagnostic output. */
function readLegacyXls(bytes:Buffer):Promise<unknown[][]>{return new Promise((resolve,reject)=>{
 const python=process.env.COMPLAINT_IMPORT_PYTHON?.trim()||'python';
 const script=path.resolve(__dirname,'../../scripts/parse-complaint-export.py');
 // Ignore PYTHONPATH/PYTHONHOME while retaining installed user-site dependencies.
 const child=spawn(python,['-E','-X','utf8',script],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let settled=false;let size=0;const chunks:Buffer[]=[];
 const finish=(error?:AppError,table?:unknown[][])=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(table!);};
 const timer=setTimeout(()=>finish(AppError.validation('XLS 解析超过 15 秒，请拆批')),15000);
 child.on('error',()=>finish(AppError.validation('Excel 文件解析服务不可用，请联系管理员')));
 child.stdin.on('error',()=>finish(AppError.validation('XLS 解析失败')));
 child.stdout.on('data',(part:Buffer)=>{size+=part.length;if(size>MAX_OUTPUT_BYTES)finish(AppError.validation('XLS 解析输出资源超限'));else chunks.push(part);});
 child.stderr.on('data',()=>{/* Never surface child diagnostics: source content may be included by third-party parsers. */});
 child.on('close',code=>{
  if(settled)return;
  if(code!==0){finish(AppError.validation('文件无法读取，请检查是否损坏、含公式或外部链接；如仍无法导入，请联系管理员'));return;}
  try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!Array.isArray(value)||value.some(row=>!Array.isArray(row)))throw new Error();finish(undefined,value);}catch{finish(AppError.validation('XLS 解析结果无效'));}
 });
 child.stdin.end(bytes);
});}

export async function parseComplaintExport(file:{name:string;bytes:Buffer}):Promise<ParsedComplaintRow[]> {
 if(file.bytes.length>COMPLAINT_IMPORT_LIMITS.bytes)throw AppError.validation('文件超过 10 MiB，请拆批');
 if(!file.bytes.length)throw AppError.validation('文件为空');
 const extension=path.extname(file.name).toLowerCase();
 if(extension==='.xls')return normalizeComplaintTable(await readLegacyXls(file.bytes));
 if(extension!=='.xlsx')throw AppError.validation('综合查询只接受 .xls 或 .xlsx');
 // The export may have up to five title/header rows in addition to data rows.
 await preflightXlsx(file.bytes,COMPLAINT_IMPORT_LIMITS.rows+5);
 const workbook=new ExcelJS.Workbook();try{await workbook.xlsx.load(file.bytes as never);}catch{throw AppError.validation('XLSX 损坏');}
 if(workbook.worksheets.length!==1)throw AppError.validation('综合查询只允许一张数据工作表');
 const sheet=workbook.worksheets[0];
 if(sheet.rowCount>COMPLAINT_IMPORT_LIMITS.rows+5||sheet.columnCount>MAX_COLUMNS)throw AppError.validation('XLSX 行或列资源超限');
 const table:unknown[][]=[];
 for(let r=1;r<=sheet.rowCount;r++){
  const row:unknown[]=[];for(let c=1;c<=sheet.columnCount;c++){const cell=sheet.getCell(r,c);if(cell.type===ExcelJS.ValueType.Formula)throw AppError.validation('禁止公式单元格');row.push(cell.value??'');}table.push(row);
 }
 return normalizeComplaintTable(table);
}
