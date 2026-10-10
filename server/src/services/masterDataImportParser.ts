import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import {parse} from 'csv-parse/sync';
import {AppError} from '../http/errors';
import {validateGeometry} from './serviceGridService';
import type {ImportFile,ImportRow,MasterDataImportKind} from '../types/masterDataImport';
export const TEMPLATE_VERSION='b4-v1';
export const IMPORT_KINDS:MasterDataImportKind[]=['enterprise','department_mapping','household','dictionary_type','dictionary_item','category','admin_grid','community','service_grid','grid_coverage','grid_boundary'];
export const IMPORT_LIMITS={bytes:10*1024*1024,rows:2000,inflatedBytes:40*1024*1024,zipEntries:100,sheets:2,cells:100000,cellBytes:4096,vertices:20000,expiresHours:24} as const;
export const TEMPLATE_FIELDS:Record<MasterDataImportKind,string[]>={
 enterprise:['enterpriseCode','enterpriseName','businessType','status','districtCode','uscc','legalPerson','contactPerson','contactPhone','serviceArea','address','disableReason'],
 department_mapping:['sourceSystem','sourceDepartmentCode','sourceDepartmentName','enterpriseCode','entityType','aliases','verified'],
 household:['enterpriseCode','households','validFrom','validTo'], dictionary_type:['code','name','status','published','cascadeDisable'],
 dictionary_item:['typeCode','code','label','parentCode','sort','status','published','cascadeDisable'],category:['code','label','parentCode','sort','status','published','cascadeDisable'],
 admin_grid:['code','name','districtCode'],community:['code','name','adminGridCode'],
 service_grid:['code','name','enterpriseCode','businessType'],
 grid_coverage:['code','validFrom','validTo','relationKind','relationCode'],grid_boundary:['code','coordinateSystem','geometrySource','geometry']};
const required:Record<MasterDataImportKind,string[]>={enterprise:['enterpriseCode','enterpriseName','businessType','status'],department_mapping:['sourceSystem','sourceDepartmentCode','sourceDepartmentName','enterpriseCode','entityType','aliases','verified'],household:['enterpriseCode','households','validFrom','validTo'],dictionary_type:['code','name','status','published','cascadeDisable'],dictionary_item:['typeCode','code','label','parentCode','sort','status','published','cascadeDisable'],category:['code','label','parentCode','sort','status','published','cascadeDisable'],admin_grid:['code','name','districtCode'],community:['code','name','adminGridCode'],service_grid:['code','name','enterpriseCode','businessType'],grid_coverage:['code','validFrom','validTo','relationKind','relationCode'],grid_boundary:[]};
export function parseKind(value:unknown):MasterDataImportKind {if(typeof value!=='string'||!IMPORT_KINDS.includes(value as MasterDataImportKind))throw AppError.validation('导入类型无效');return value as MasterDataImportKind;}
function text(bytes:Buffer){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{throw AppError.validation('文件编码必须为 UTF-8');}}
/** Consume every ZIP stream, enforcing actual inflated bytes as well as declared sizes. */
export function preflightXlsx(bytes:Buffer,maxRows=IMPORT_LIMITS.rows+1):Promise<void>{return new Promise((resolve,reject)=>{
 if(bytes.subarray(0,2).toString()!=='PK'){reject(AppError.validation('XLSX 必须为有效 ZIP 文件'));return;}
 yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
  if(error||!zip){reject(AppError.validation('XLSX ZIP 损坏'));return;}let inflated=0,entries=0,cells=0,finished=false;const names=new Set<string>();
  const fail=(message:string)=>{if(finished)return;finished=true;zip.close();reject(AppError.validation(message));};zip.on('error',()=>fail('XLSX ZIP 损坏'));
  zip.on('end',()=>{if(finished)return;finished=true;if(!names.has('[Content_Types].xml')||!names.has('xl/workbook.xml'))reject(AppError.validation('XLSX 结构不完整'));else resolve();});
  zip.on('entry',entry=>{if(++entries>IMPORT_LIMITS.zipEntries||entry.uncompressedSize>IMPORT_LIMITS.inflatedBytes)return fail('XLSX 解压资源超限');if(names.has(entry.fileName))return fail('XLSX ZIP 重复条目');names.add(entry.fileName);
   if(/vbaProject|externalLinks|connections\.xml/i.test(entry.fileName)||(entry.generalPurposeBitFlag&1))return fail('禁止宏、外部链接或加密 XLSX');
   zip.openReadStream(entry,(err,stream)=>{if(err||!stream)return fail('XLSX ZIP 损坏');const parts:Buffer[]=[];stream.on('error',()=>fail('XLSX ZIP 损坏'));stream.on('data',(part:Buffer)=>{inflated+=part.length;if(inflated>IMPORT_LIMITS.inflatedBytes){stream.destroy();fail('XLSX 实际解压体积超限');}else if(entry.fileName.endsWith('.xml')||entry.fileName.endsWith('.rels'))parts.push(part);});stream.on('end',()=>{if(finished)return;const xml=Buffer.concat(parts).toString('utf8');if(/<(?:[\w]+:)?f(?:\s|>)/.test(xml))return fail('禁止公式单元格（含共享公式与缓存值）');if(/TargetMode\s*=\s*["']External/.test(xml))return fail('禁止外部链接');if(/macroEnabled|vbaProject/i.test(xml))return fail('禁止宏');if(/<!DOCTYPE|<!ENTITY/i.test(xml))return fail('禁止 XML 实体');
    if(/xl\/worksheets\//.test(entry.fileName)){
     cells+=xml.match(/<(?:[\w]+:)?c(?:\s|>)/g)?.length??0;if(cells>IMPORT_LIMITS.cells)return fail('XLSX 单元格超限');
     for(const match of xml.matchAll(/<(?:[\w]+:)?row\b[^>]*\br\s*=\s*["'](\d+)["']/g))if(Number(match[1])>maxRows)return fail('XLSX 行资源超限');
     for(const match of xml.matchAll(/<(?:[\w]+:)?c\b[^>]*\br\s*=\s*["']([A-Z]+)(\d+)["']/g)){let col=0;for(const c of match[1])col=col*26+c.charCodeAt(0)-64;if(col>64||Number(match[2])>maxRows)return fail('XLSX 单元格坐标超限');}
    }
    if(entry.fileName==='xl/sharedStrings.xml'&&(xml.match(/<(?:[\w]+:)?si(?:\s|>)/g)?.length??0)>IMPORT_LIMITS.cells)return fail('XLSX 共享文本资源超限');zip.readEntry();});});
  });zip.readEntry();
 });
});}
function tableRows(table:unknown[][],kind:MasterDataImportKind,sheet:string):ImportRow[]{
 const headers=table[0]?.map(v=>String(v??''))??[];if(!headers.includes('templateVersion'))throw AppError.validation('模板版本列缺失，请下载 b4-v1 模板');
 if(new Set(headers).size!==headers.length||headers.some(h=>h!=='templateVersion'&&!TEMPLATE_FIELDS[kind].includes(h))||required[kind].some(h=>!headers.includes(h)))throw AppError.validation('模板字段缺失、重复或不兼容，请下载新模板');
 const rows:ImportRow[]=[];for(let i=1;i<table.length;i++){const cells=table[i];if(cells.every(v=>v===null||v===undefined||v===''))continue;if(cells.length>headers.length)throw AppError.validation('数据列数超过模板');const values:Record<string,unknown>={};for(let c=0;c<headers.length;c++){const v=cells[c]??'';if(typeof v!=='string')throw AppError.validation('所有输入须为文本；编码须保留前导零，日期使用 YYYY-MM-DD');if(Buffer.byteLength(v)>IMPORT_LIMITS.cellBytes)throw AppError.validation('单元格文本超限');values[headers[c]]=v.trim();}
 if(values.templateVersion!==TEMPLATE_VERSION)throw AppError.validation('模板版本不兼容，请下载 b4-v1 新模板');delete values.templateVersion;rows.push({sheet,row:i+1,values});if(rows.length>IMPORT_LIMITS.rows)throw AppError.validation('每批最多 2000 行，请拆批');}
 if(!rows.length)throw AppError.validation('模板没有数据行');return rows;
}
export async function parseImportFile(file:ImportFile,kind:MasterDataImportKind):Promise<{templateVersion:string;rows:ImportRow[]}>{
 parseKind(kind);if(file.bytes.length>IMPORT_LIMITS.bytes)throw AppError.validation('文件超过 10 MiB，请拆批');if(!file.bytes.length)throw AppError.validation('文件为空');const ext=file.name.toLowerCase().split('.').pop();
 if(kind==='grid_boundary'){
  if(ext!=='geojson')throw AppError.validation('边界仅接受 .geojson');let source:Record<string,unknown>;try{source=JSON.parse(text(file.bytes));}catch(e){if(e instanceof AppError)throw e;throw AppError.validation('GeoJSON 损坏');}
  if(source.type!=='FeatureCollection'||source.templateVersion!==TEMPLATE_VERSION||!Array.isArray(source.features)||!source.features.length||source.features.length>IMPORT_LIMITS.rows)throw AppError.validation('GeoJSON 类型、模板版本或行数无效');let vertices=0;
  const count=(v:unknown):void=>{if(Array.isArray(v)){if(v.every(n=>typeof n==='number'))vertices++;else v.forEach(count);}};
  const rows=source.features.map((f:Record<string,unknown>,i:number)=>{if(f?.type!=='Feature'||!f.properties||typeof f.properties!=='object')throw AppError.validation('GeoJSON Feature 无效');const p=f.properties as Record<string,unknown>;if(typeof p.code!=='string'||p.coordinateSystem!=='WGS84'||typeof p.geometrySource!=='string'||!p.geometrySource.trim()||p.conversion!=='none')throw AppError.validation('边界需现有行政网格编码、WGS84、来源与 conversion=none；不自动转换坐标');count((f.geometry as Record<string,unknown>)?.coordinates);if(vertices>IMPORT_LIMITS.vertices)throw AppError.validation('GeoJSON 顶点超限');return {sheet:'features',row:i+1,values:{code:p.code.trim(),coordinateSystem:p.coordinateSystem,geometrySource:p.geometrySource.trim(),geometry:validateGeometry(f.geometry)}};});return {templateVersion:TEMPLATE_VERSION,rows};
 }
 if(ext==='csv'){let table:unknown[][];try{table=parse(text(file.bytes),{bom:true,relax_column_count:true,max_record_size:IMPORT_LIMITS.cellBytes*TEMPLATE_FIELDS[kind].length});}catch(e){if(e instanceof AppError)throw e;throw AppError.validation('CSV 损坏或字段超限');}return {templateVersion:TEMPLATE_VERSION,rows:tableRows(table,kind,'数据')};}
 if(ext!=='xlsx')throw AppError.validation('只接受 .xlsx 或 UTF-8 .csv');await preflightXlsx(file.bytes);const workbook=new ExcelJS.Workbook();try{await workbook.xlsx.load(file.bytes as never);}catch{throw AppError.validation('XLSX 损坏');}
 if(workbook.worksheets.length>IMPORT_LIMITS.sheets||workbook.worksheets.some(w=>!['数据','说明'].includes(w.name)))throw AppError.validation('XLSX 只允许数据与说明两页');const data=workbook.getWorksheet('数据');if(!data||data.rowCount>IMPORT_LIMITS.rows+1||data.rowCount*data.columnCount>IMPORT_LIMITS.cells)throw AppError.validation('XLSX 数据页缺失或资源超限');const table:unknown[][]=[];
 for(let r=1;r<=data.rowCount;r++){const row:unknown[]=[];for(let c=1;c<=data.columnCount;c++){const cell=data.getCell(r,c);if(cell.type===ExcelJS.ValueType.Formula)throw AppError.validation('禁止公式单元格');row.push(cell.value??'');}table.push(row);}return {templateVersion:TEMPLATE_VERSION,rows:tableRows(table,kind,'数据')};
}
export function safeCsvCell(value:unknown):string {const s=String(value??'');return '"'+(/^[\s]*[=+\-@\t\r\n]/.test(s)?"'"+s:s).replace(/"/g,'""')+'"';}
