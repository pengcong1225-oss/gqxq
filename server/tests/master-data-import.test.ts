import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
process.env.DOTENV_CONFIG_PATH='missing-synthetic-b4.env';process.env.GQXQ_DB_HOST='127.0.0.1';process.env.GQXQ_DB_PORT='1';process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_NAME='synthetic';process.env.GQXQ_JWT_SECRET='synthetic-b4-pure';
const parserPath=new URL('../src/services/masterDataImportParser.ts',import.meta.url);
test('B4 previews new parents through the same typed B1 item validator',async()=>{
 const dict=await import('../src/services/dictService');
 assert.equal(typeof dict.validateDictionaryItemState,'function','typed shared B1 validation exists');
 const type={code:'test',name:'test',status:'enabled' as const,version:1,published:true,readOnly:false,fixedCodes:false};
 const ctx={userId:'synthetic',userName:'synthetic',clientIp:null,permissionCodes:['system.dict.manage'],access:{userId:'synthetic',roles:[],rules:[{kind:'all' as const}],scopeVersion:1,canReadSource:false}};
 const root=dict.validateDictionaryItemState({typeCode:'test',code:'001',label:'Root',published:true,expectedVersion:0},type,[],ctx);
 const child=dict.validateDictionaryItemState({typeCode:'test',code:'002',parentCode:'001',label:'Child',published:true,expectedVersion:0},type,[root.item],ctx);
 assert.equal(child.item.parentCode,'001');assert.throws(()=>dict.validateDictionaryItemState({typeCode:'test',code:'001',parentCode:'002',label:'Cycle',expectedVersion:0},type,[root.item,child.item],ctx),/两级|环/);
});
test('B4 parser enforces inflated ZIP/cell dimensions/macros/links/rows and escapes error CSV formulas',async()=>{
 const {parseImportFile,preflightXlsx,safeCsvCell,TEMPLATE_VERSION}=await import('../src/services/masterDataImportParser');
 const bytes=readFileSync(new URL('../templates/imports/enterprise.xlsx',import.meta.url));
 const mutate=async(name:string,value:string)=>{const zip=await JSZip.loadAsync(bytes);zip.file(name,value);return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});};
 await assert.rejects(async()=>preflightXlsx(await mutate('xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="999999999"><c r="A999999999" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>')),/资源|行|单元格/);
 await assert.rejects(async()=>preflightXlsx(await mutate('xl/vbaProject.bin','fake')),/宏/);
 await assert.rejects(async()=>preflightXlsx(await mutate('xl/_rels/workbook.xml.rels','<Relationships><Relationship TargetMode="External" Target="http://127.0.0.1:1"/></Relationships>')),/外部链接/);
 await assert.rejects(async()=>preflightXlsx(await mutate('xl/worksheets/sheet1.xml','<worksheet>'+(' '.repeat(40*1024*1024+1))+'</worksheet>')),/解压/);
 const csv=Buffer.from('templateVersion,enterpriseCode,enterpriseName,businessType,status\r\n'+Array.from({length:2001},(_,i)=>`${TEMPLATE_VERSION},${i},虚构,water,enabled`).join('\r\n'));
 await assert.rejects(()=>parseImportFile({name:'too-many.csv',bytes:csv},'enterprise'),/2000/);
 for(const s of ['=SUM(A1)','+1','-1','@cmd','\t=1'])assert.ok(safeCsvCell(s).startsWith('"\''));
});
test('B4 real CSV/XLSX templates and bounded parser preserve stable text keys',async()=>{
 assert.ok(existsSync(parserPath),'B4 bounded parser is implemented');
 const {parseImportFile,IMPORT_KINDS,TEMPLATE_VERSION}=await import('../src/services/masterDataImportParser');
 for(const kind of IMPORT_KINDS.filter(k=>k!=='grid_boundary')){
  for(const ext of ['csv','xlsx']){
   const bytes=readFileSync(new URL('../templates/imports/'+kind+'.'+ext,import.meta.url));
   const parsed=await parseImportFile({name:kind+'.'+ext,bytes},kind);
   assert.equal(parsed.templateVersion,TEMPLATE_VERSION);assert.ok(parsed.rows.length>0,kind+' '+ext);const leadingKey=kind==='enterprise'||kind==='department_mapping'||kind==='household'?'enterpriseCode':kind==='dictionary_type'?null:'code';if(leadingKey)assert.equal(parsed.rows[0].values[leadingKey],'001',kind+' '+ext+' text leading zero');
  }
 }
 const bytes=readFileSync(new URL('../templates/imports/enterprise.csv',import.meta.url));
 const parsed=await parseImportFile({name:'enterprise.csv',bytes},'enterprise');
 assert.equal(parsed.rows[0].values.enterpriseCode,'001');
 await assert.rejects(()=>parseImportFile({name:'fake.xlsx',bytes},'enterprise'),/XLSX|ZIP/);
 await assert.rejects(()=>parseImportFile({name:'old.csv',bytes:Buffer.from(bytes.toString().replace(TEMPLATE_VERSION,'b4-v0'))},'enterprise'),/版本/);
 await assert.rejects(()=>parseImportFile({name:'bad.csv',bytes:Buffer.from([0xff,0xfe,0x01])},'enterprise'),/UTF-8/);
 await assert.rejects(()=>parseImportFile({name:'huge.csv',bytes:Buffer.alloc(10*1024*1024+1)},'enterprise'),/10 MiB/);
 const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('数据');ws.addRow(['templateVersion','enterpriseCode','enterpriseName','businessType','status']);ws.addRow([TEMPLATE_VERSION,'001',{formula:'1+1',result:2},'water','enabled']);
 const formulaBytes=Buffer.from(await wb.xlsx.writeBuffer());
 await assert.rejects(()=>parseImportFile({name:'formula.xlsx',bytes:formulaBytes},'enterprise'),/公式/);
});
