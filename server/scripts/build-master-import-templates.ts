// Application-owned generator: bundled authoring runtime is never a server dependency.
import ExcelJS from 'exceljs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const out=resolve(__dirname,'../templates/imports');
async function main(){const fields=JSON.parse(await readFile(resolve(out,'fields.json'),'utf8')) as Record<string,Record<string,string>>;
 for(const [kind,example] of Object.entries(fields)){if(process.argv[2]&&process.argv[2]!==kind)continue;
  const wb=new ExcelJS.Workbook();const data=wb.addWorksheet('数据',{views:[{state:'frozen',ySplit:1}]});const keys=['templateVersion',...Object.keys(example)];data.addRow(keys);data.addRow(['b4-v1',...Object.values(example)]);data.columns=keys.map(key=>({key,width:24,style:{numFmt:'@'}}));data.getRow(1).height=30;data.getRow(2).height=30;data.getRow(1).eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF163A5F'}};c.font={color:{argb:'FFFFFFFF'},bold:true};});
  const notes=wb.addWorksheet('说明');notes.columns=[{width:26},{width:95}];const guide=await readFile(resolve(out,kind+'-fields.md'),'utf8');notes.addRow(['字段','规则']);for(const line of guide.split('\n').filter(l=>l.startsWith('- ')&&l!=='- 字段：规则')){const at=line.indexOf('：');notes.addRow([line.slice(2,at),line.slice(at+1)]);}notes.eachRow(row=>{row.height=32;row.eachCell(c=>{c.alignment={wrapText:true,vertical:'middle'};});});notes.getRow(1).eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF163A5F'}};c.font={color:{argb:'FFFFFFFF'},bold:true};});await wb.xlsx.writeFile(resolve(out,kind+'.xlsx'));console.log(kind+': canonical ExcelJS XLSX generated');
 }
}
void main();
