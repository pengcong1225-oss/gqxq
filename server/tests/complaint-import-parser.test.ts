import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {existsSync} from 'node:fs';

process.env.DOTENV_CONFIG_PATH='missing-synthetic-complaint-import.env';
process.env.GQXQ_DB_HOST='127.0.0.1'; process.env.GQXQ_DB_PORT='1';
process.env.GQXQ_DB_USER='synthetic'; process.env.GQXQ_DB_NAME='synthetic';
process.env.GQXQ_JWT_SECRET='synthetic-complaint-import';
const headers=['案件公文号','诉求类型','来话内容','录入时间','案件主类型名','案件二级类型名','案件类型名','详细地址','区','市民姓名','市民电话','处理结果'];
const data=['0000123','投诉类','【来源】供水异常请联系13812345678。后续内容','2026-09-17 17:09:00','公共服务','供水服务','供水异常','虚构路1号','虚构区','测试姓名','13812345678','处理中'];
const parser=()=>import('../src/services/complaintImportParser');
test('expanded shared text has an aggregate budget before storing any import plan',async()=>{
 const {normalizeComplaintTable}=await parser();const large=[...data];large[2]='a'.repeat(16000);assert.throws(()=>normalizeComplaintTable([headers,...Array.from({length:1000},()=>large)]),/展开|文字|文本/);
});
test('dates outside MySQL supported years are preview errors',async()=>{const {normalizeComplaintTable}=await parser();for(const date of ['0999-09-17 17:09:00',new Date('0999-09-17T17:09:00Z')]){const row:unknown[]=[...data];row[3]=date;assert.ok(normalizeComplaintTable([headers,row])[0].errors.some(e=>e.includes('录入时间')));}});
test('native XLSX dates preserve Excel displayed wall time without an eight-hour shift',async()=>{
 const w=new ExcelJS.Workbook();const s=w.addWorksheet('Sheet0');s.addRow(headers);s.addRow([...data]);s.getCell('D2').value=new Date('2026-09-17T17:09:00Z');s.getCell('D2').numFmt='yyyy-mm-dd hh:mm:ss';
 const {parseComplaintExport,normalizeComplaintTable}=await parser();const rows=await parseComplaintExport({name:'dates.xlsx',bytes:Buffer.from(await w.xlsx.writeBuffer())});assert.equal(rows[0].sourceReportedAt,'2026-09-17T17:09:00+08:00');assert.equal(rows[0].sourceReportedAt,normalizeComplaintTable([headers,data])[0].sourceReportedAt);
});
test('complaint XLSX accepts 2000 data rows following a title and header',async()=>{
 const w=new ExcelJS.Workbook();const s=w.addWorksheet('Sheet0');s.addRow(['综合查询']);s.addRow(headers);for(let i=0;i<2000;i++)s.addRow([`LIMIT-${i}`,...data.slice(1)]);
 const {parseComplaintExport}=await parser();const rows=await parseComplaintExport({name:'boundary.xlsx',bytes:Buffer.from(await w.xlsx.writeBuffer())});assert.equal(rows.length,2000);assert.ok(rows.every(row=>!row.errors.length));
});
async function xlsx(table:unknown[][]){const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Sheet0');table.forEach(row=>sheet.addRow(row));return Buffer.from(await book.xlsx.writeBuffer());}
// Small synthetic BIFF8 stream; no citizen data or real source workbook is stored.
function biff(table:unknown[][],extraRecord?:number):Buffer {
 const record=(id:number,body=Buffer.alloc(0))=>{const prefix=Buffer.alloc(4);prefix.writeUInt16LE(id);prefix.writeUInt16LE(body.length,2);return Buffer.concat([prefix,body]);};
 const bof=(type:number)=>{const body=Buffer.alloc(16);body.writeUInt16LE(0x600);body.writeUInt16LE(type,2);body.writeUInt16LE(0x0dbb,4);body.writeUInt16LE(1996,6);return record(0x809,body);};
 const bound=Buffer.alloc(20);bound[6]=6;bound[7]=1;Buffer.from('Sheet0','utf16le').copy(bound,8);
 const xf=Buffer.alloc(20);xf.writeUInt16LE(14,2);
 const globals=[bof(5),record(0xe0,xf),record(0x85,bound),record(0x0a)];
 bound.writeUInt32LE(globals.reduce((n,part)=>n+part.length,0));globals[2]=record(0x85,bound);
 const dimension=Buffer.alloc(14);dimension.writeUInt32LE(table.length,4);dimension.writeUInt16LE(Math.max(...table.map(row=>row.length)),10);
 const sheet=[bof(0x10),record(0x200,dimension)];
 table.forEach((row,r)=>row.forEach((value,c)=>{
  if(value===null||value===undefined||value==='')return;
  if(typeof value==='number'){const body=Buffer.alloc(14);body.writeUInt16LE(r);body.writeUInt16LE(c,2);body.writeDoubleLE(value,6);sheet.push(record(0x203,body));return;}
  const text=String(value);const body=Buffer.alloc(9+text.length*2);body.writeUInt16LE(r);body.writeUInt16LE(c,2);body.writeUInt16LE(text.length,6);body[8]=1;Buffer.from(text,'utf16le').copy(body,9);sheet.push(record(0x204,body));
 }));
 if(extraRecord!==undefined)sheet.push(record(extraRecord,Buffer.alloc(20)));
 sheet.push(record(0x0a));return Buffer.concat([...globals,...sheet]);
}

test('complaint export discovers title/header rows, preserves duplicate IDs and excludes citizen columns',async()=>{
 assert.ok(existsSync(new URL('../src/services/complaintImportParser.ts',import.meta.url)),'complaint export parser exists');
 const {normalizeComplaintTable}=await parser();
 const rows=normalizeComplaintTable([['综合查询'],headers,data,[],data]);
 assert.equal(rows.length,2); assert.deepEqual(rows.map(r=>r.row),[3,5]);
 assert.equal(rows[0].sourceId,'0000123'); assert.equal(rows[1].sourceId,'0000123');
 assert.equal(rows[0].title,'供水异常请联系[联系方式已隐去]');
 assert.equal(rows[0].content,data[2]); assert.equal(rows[0].businessType,'water');
 assert.equal(rows[0].complaintType,'complaint'); assert.equal(rows[0].sourceReportedAt,'2026-09-17T17:09:00+08:00');
 assert.equal(rows[0].metadata['处理结果'],'处理中');
 assert.equal('市民姓名' in rows[0].metadata,false); assert.equal('市民电话' in rows[0].metadata,false);
 assert.deepEqual(rows[0].errors,[]); assert.equal('enterpriseId' in rows[0],false); assert.equal('longitude' in rows[0],false);
});

test('complaint export produces bounded field errors without echoing source values or guessing business',async()=>{
 const {normalizeComplaintTable}=await parser();
 const invalid=[...data]; invalid[0]='';invalid[1]='未知诉求';invalid[2]='燃气咨询';invalid[3]='2026-02-30 12:00:00';invalid[5]='不明确';
 const row=normalizeComplaintTable([headers,invalid])[0];
 assert.equal(row.businessType,null); assert.equal(row.complaintType,null); assert.equal(row.sourceReportedAt,null);
 assert.equal(row.errors.length,4);assert.ok(row.errors.every(e=>e.includes('2')));
 assert.ok(row.errors.every(e=>!e.includes('未知诉求')&&!e.includes('不明确')));
 for(const [index,value] of [[0,'a'.repeat(129)],[2,'中'.repeat(16001)],[7,'a'.repeat(501)],[8,'a'.repeat(65)]] as const){
  const long=[...data];long[index]=value;assert.ok(normalizeComplaintTable([headers,long])[0].errors.length>0);
 }
 const bad:unknown[]=[...data];bad[2]={text:'object'};assert.ok(normalizeComplaintTable([headers,bad])[0].errors.length>0);
});

test('complaint export validates required/duplicate headers and row/column resource bounds',async()=>{
 const {normalizeComplaintTable}=await parser();
 assert.throws(()=>normalizeComplaintTable([headers.filter(h=>h!=='案件主类型名'),data]),/表头|字段/);
 assert.throws(()=>normalizeComplaintTable([[...headers,'案件公文号'],[...data,'x']]),/重复/);
 assert.throws(()=>normalizeComplaintTable([[],[],[],[],[],headers,data]),/表头|字段/);
 assert.throws(()=>normalizeComplaintTable([headers,...Array.from({length:2001},()=>data)]),/2000|行/);
 assert.throws(()=>normalizeComplaintTable([[...headers,...Array.from({length:53},(_,i)=>'额外'+i)],data]),/列/);
});

test('complaint export maps every supported complaint enum and Date cells in China timezone',async()=>{
 const {normalizeComplaintTable}=await parser();
 for(const [label,value] of [['投诉类','complaint'],['咨询类','consult'],['建议类','suggest'],['举报类','report'],['求助类','help'],['其他类','other'],['表扬类','praise']]){
  const row:unknown[]=[...data];row[1]=label;row[3]=new Date('2026-09-17T17:09:00Z');row[5]='供气服务';
  const parsed=normalizeComplaintTable([headers,row])[0];assert.equal(parsed.complaintType,value);assert.equal(parsed.businessType,'gas');assert.equal(parsed.sourceReportedAt,'2026-09-17T17:09:00+08:00');
 }
});

test('complaint XLSX parsing rejects formulas, external links, macros and invalid uploads',async()=>{
 const {parseComplaintExport}=await parser();
 const bytes=await xlsx([['综合查询'],headers,data]);const rows=await parseComplaintExport({name:'synthetic.xlsx',bytes});assert.equal(rows[0].sourceId,'0000123');
 const formula:unknown[]=[...data];formula[2]={formula:'1+1',result:2};
 await assert.rejects(async()=>parseComplaintExport({name:'formula.xlsx',bytes:await xlsx([headers,formula])}),/公式/);
 for(const [name,value,pattern] of [['xl/vbaProject.bin','fake',/宏/],['xl/_rels/workbook.xml.rels','<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>',/外部链接/]] as const){
  const zip=await JSZip.loadAsync(bytes);zip.file(name,value);
  await assert.rejects(async()=>parseComplaintExport({name:'malicious.xlsx',bytes:await zip.generateAsync({type:'nodebuffer'})}),pattern);
 }
 await assert.rejects(()=>parseComplaintExport({name:'wrong.csv',bytes:Buffer.from('x')}),/xls/i);
 await assert.rejects(()=>parseComplaintExport({name:'too-large.xls',bytes:Buffer.alloc(10*1024*1024+1)}),/10 MiB/);
 await assert.rejects(()=>parseComplaintExport({name:'empty.xls',bytes:Buffer.alloc(0)}),/空/);
});

test('complaint export rejects non-ASCII source keys and unexpected cell objects without exposing values',async()=>{
 const {normalizeComplaintTable}=await parser();
 const row:unknown[]=[...data];row[0]='隐藏来源号';row[11]={text:'private-metadata-value'};
 const result=normalizeComplaintTable([headers,row])[0];
 assert.ok(result.errors.some(error=>error.includes('案件公文号')));
 assert.ok(result.errors.some(error=>error.includes('处理结果')));
 assert.ok(result.errors.every(error=>!error.includes('隐藏来源号')&&!error.includes('private-metadata-value')));
});

test('complaint XLS reports missing configured runtime safely',async()=>{
 const previous=process.env.COMPLAINT_IMPORT_PYTHON;process.env.COMPLAINT_IMPORT_PYTHON='definitely-missing-complaint-python';
 try{const {parseComplaintExport}=await parser();await assert.rejects(()=>parseComplaintExport({name:'synthetic.xls',bytes:biff([headers,data])}),/解析服务不可用|解析失败/);}
 finally{if(previous===undefined)delete process.env.COMPLAINT_IMPORT_PYTHON;else process.env.COMPLAINT_IMPORT_PYTHON=previous;}
});

test('complaint XLS parser reads bounded synthetic BIFF and converts Excel dates',async()=>{
 const previous=process.env.COMPLAINT_IMPORT_PYTHON;
 process.env.COMPLAINT_IMPORT_PYTHON=existsSync('C:/Program Files/Python311/python.exe')?'C:/Program Files/Python311/python.exe':previous||'python';
 try{
  const {parseComplaintExport}=await parser();const numericDate:unknown[]=[...data];numericDate[3]=45000;
  const rows=await parseComplaintExport({name:'synthetic.xls',bytes:biff([['综合查询'],headers,numericDate])});
  assert.equal(rows.length,1);assert.equal(rows[0].sourceId,'0000123');assert.equal(rows[0].sourceReportedAt,'2023-03-15T00:00:00+08:00');assert.deepEqual(rows[0].errors,[]);
 }finally{if(previous===undefined)delete process.env.COMPLAINT_IMPORT_PYTHON;else process.env.COMPLAINT_IMPORT_PYTHON=previous;}
});

test('complaint XLS parser rejects cached formulas, external workbook records and corrupt BIFF',async()=>{
 const previous=process.env.COMPLAINT_IMPORT_PYTHON;
 process.env.COMPLAINT_IMPORT_PYTHON=existsSync('C:/Program Files/Python311/python.exe')?'C:/Program Files/Python311/python.exe':previous||'python';
 try{
  const {parseComplaintExport}=await parser();
  for(const record of [0x06,0x1ae,0x2f,0xd3])await assert.rejects(()=>parseComplaintExport({name:'unsafe.xls',bytes:biff([headers,data],record)}),/公式|外部|宏|损坏/);
  await assert.rejects(()=>parseComplaintExport({name:'corrupt.xls',bytes:Buffer.from('invalid-workbook')}),/损坏/);
 }finally{if(previous===undefined)delete process.env.COMPLAINT_IMPORT_PYTHON;else process.env.COMPLAINT_IMPORT_PYTHON=previous;}
});
