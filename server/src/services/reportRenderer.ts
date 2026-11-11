import {deflateSync} from 'node:zlib';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {Document,Packer,Paragraph,TextRun,HeadingLevel,Table,TableRow,TableCell,WidthType,BorderStyle,ImageRun,AlignmentType,VerticalAlign} from 'docx';
import {AppError} from '../http/errors';
import {reportRendererAvailable,REPORT_LIMITS,type ReportSnapshot} from '../domain/reportSnapshot';
import type {PeriodComparison} from '../types/statistics';
export function reportChartValues(s:ReportSnapshot):{label:string;value:number}[]{return [{label:'本期',value:s.statistics.summary.total},...s.statistics.summary.comparisons.filter(c=>c.baselineCount!==null).map(c=>({label:c.label,value:c.baselineCount!}))];}
const crc=(b:Buffer)=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
function pngChunk(name:string,data:Buffer){const n=Buffer.from(name),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([n,data])));return Buffer.concat([size,n,data,check]);}
const digits=['1110111','0010010','1011101','1011011','0111010','1101011','1101111','1010010','1111111','1111011'];
/** Portable deterministic numeric bar chart; labels are paired with a real table.
 * No external image renderer/network, no invented color/heat policy. */
export function reportChart(s:ReportSnapshot):Buffer {
 const w=1000,h=350,pixels=Buffer.alloc(w*h*3,255);const rect=(x:number,y:number,ww:number,hh:number,color:number[])=>{for(let j=Math.max(0,y);j<Math.min(h,y+hh);j++)for(let i=Math.max(0,x);i<Math.min(w,x+ww);i++)for(let k=0;k<3;k++)pixels[(j*w+i)*3+k]=color[k];};
 const number=(value:number,x:number,y:number)=>{for(const char of String(value)){const d=digits[Number(char)];const seg=[[2,0,16,3],[0,2,3,16],[18,2,3,16],[2,18,16,3],[0,20,3,16],[18,20,3,16],[2,36,16,3]];seg.forEach((r,i)=>{if(d?.[i]==='1')rect(x+r[0],y+r[1],r[2],r[3],[35,48,65]);});x+=28;}};
 const values=reportChartValues(s),maximum=Math.max(1,...values.map(v=>v.value));rect(65,275,870,2,[160,174,191]);
 values.forEach((v,i)=>{const x=140+i*280,height=Math.round(v.value/maximum*180);if(height)rect(x,275-height,145,height,[45,90,135]);number(v.value,x,230-height);number(i+1,x+60,293);});
 const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)pixels.copy(raw,y*(w*3+1)+1,y*w*3,(y+1)*w*3);
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(raw)),pngChunk('IEND',Buffer.alloc(0))]);
}
export function reportSections(s:ReportSnapshot):{title:string;headers:string[];rows:(string|number|null)[][]}[]{
 if(s.tenderStatistics)return fixedReportSections(s);
 const m=s.statistics.summary;
 const sections=[{title:'期间比较',headers:['比较口径','基期范围','本期数量','基期数量','变化百分比','说明'],rows:m.comparisons.map(c=>[c.label,c.from&&c.to?c.from+' 至 '+c.to:'不可用',c.currentCount,c.baselineCount,c.changePercent,c.reason??(c.truncated?'基期按候选规则截短':'候选政策，待业务确认')])},{title:'统计分布',headers:['维度','分类或对象','字典版本','数量'],rows:m.dimensions.map(d=>[d.dimension+(d.level?' '+d.level:''),d.name,d.dictionaryVersion??null,d.count])},{title:'按日统计',headers:['业务日期','数量'],rows:m.trend.map(t=>[t.date,t.count])},{title:'历史户数与候选指标',headers:['企业','选定日期','户数','历史版本','每万户事件数','说明'],rows:m.rates.map(r=>[r.enterpriseCode,r.at,r.households,r.version,r.value,r.reason??r.label])}];
 if(s.heat)sections.push({title:'热力统计',headers:['服务网格','数量','规则版本','政策版本','状态说明'],rows:s.heat.data.grids.map(g=>[g.code,g.count,g.ruleVersion,g.policyVersion,g.reason??g.level??'不可用'])} as any);
 return sections;
}
type ReportSection=ReturnType<typeof reportSections>[number];
const percentage=(comparisons:PeriodComparison[],kind:'yoy'|'mom')=>{const c=comparisons.find(c=>c.kind===kind);return !c?'不可用':c.changePercent===null?'不可用（'+(c.reason??'无有效基期')+'）':c.changePercent.toFixed(2)+'%';};
function fixedReportSections(s:ReportSnapshot):ReportSection[]{
 const t=s.tenderStatistics!,m=s.statistics.summary;
 const selectedComparisons=t.periods.find(p=>p.query.periodKind===s.input.query.periodKind&&p.query.from===s.input.query.from&&p.query.to===s.input.query.to)?.comparisons??m.comparisons;
 const sections:ReportSection[]=[{title:'选定期间诉求概况',headers:['统计范围','诉求量','同比','环比','起止时间','说明'],rows:[['选定业务范围',m.total,percentage(selectedComparisons,'yoy'),percentage(selectedComparisons,'mom'),s.input.query.from+' 至 '+s.input.query.to,m.partial?'存在日期缺失，比较不完整':'数量按当前授权筛选范围计算'],...t.services.map(service=>[service.title,service.total,null,null,service.query.from+' 至 '+service.query.to,'下列年季月统计以结束日期为统计时点'])]}];
 const calendarRows=(periods:typeof t.periods)=>periods.filter(p=>p.key!=='yesterday').map(p=>[p.label,p.query.from+' 至 '+p.query.to,p.total,percentage(p.comparisons,'yoy'),percentage(p.comparisons,'mom'),p.key==='year'?'年度环比以上年同期累计为基期；与同比相同':'同比、环比均按可比经过日数计算']);
 sections.push({title:(s.input.query.businessType?'所选业务':'全部业务')+'年季月诉求量',headers:['期间','起止时间','诉求量','同比','环比','说明'],rows:calendarRows(t.periods)});
 for(const service of t.services){
  const periods=service.periods.filter(p=>p.key!=='yesterday');
  sections.push({title:service.title+'年季月诉求量',headers:['期间','起止时间','诉求量','同比','环比','说明'],rows:calendarRows(periods)});
  sections.push({title:service.title+'年季月分类型同比环比',headers:['期间','诉求类型','数量','同比','环比','分类依据'],rows:periods.flatMap(p=>p.types.map(type=>[p.label,type.bucket.name,type.count,percentage(type.comparisons,'yoy'),percentage(type.comparisons,'mom'),type.bucket.dictionaryVersion?'分类版本 '+type.bucket.dictionaryVersion:'分类版本未留存']))});
  sections.push({title:service.title+'选定期间分类与区域分布',headers:['维度','分类或区域','诉求量'],rows:[...service.categories.map(c=>['诉求类型',c.name,c.count]),...service.districts.map(d=>['行政区域',d.name,d.count])]});
  sections.push({title:service.title+'企业万户诉求量',headers:['企业','诉求量','服务户数','每万户诉求量','户数日期','说明'],rows:service.enterpriseRates.map(r=>[r.name,r.count,r.households,r.value,r.at,r.reason??'诉求量 ÷ 服务户数 × 10000'])});
 }
 sections.push({title:'选定期间月度趋势',headers:['月份','供水诉求量','供气诉求量','供水供气合计'],rows:t.dynamics.months.map(p=>[p.label,p.water,p.gas,p.water+p.gas])});
 sections.push({title:'选定期间每周分布',headers:['星期','供水诉求量','供气诉求量'],rows:t.dynamics.weekdays.map(p=>[p.label,p.water,p.gas])});
 sections.push({title:'选定期间小时分布',headers:['小时（北京时间）','供水诉求量','供气诉求量'],rows:t.dynamics.hours.map(p=>[p.label,p.water,p.gas])});
 sections.push({title:'指标数据说明',headers:['指标','说明'],rows:[...t.dynamics.unavailable.map(i=>[i.title,i.reason]),['日期缺失',t.dateFilterUnavailableCount+' 条；缺失记录不强行归入日期区间。'],['小时缺失',t.dynamics.missingTimeCount+' 条；缺失记录不强行归入小时。'],['接收时间回退',t.sourceTimeFallbackCount+' 条；来源填报时间缺失时采用平台接收时间。'],['人口范围',m.overallRate.reason]]});
 if(s.heat)sections.push({title:'选定期间网格热力统计',headers:['服务网格','诉求量','规则版本','统计版本','说明'],rows:s.heat.data.grids.map(g=>[g.code,g.count,g.ruleVersion,g.policyVersion,g.reason??g.level??'不可用'])});
 return sections;
}
const displayed=(v:string|number|null)=>v===null?'未知或不可用':typeof v==='number'&&!Number.isInteger(v)?v.toFixed(2):String(v);
function reportIntro(s:ReportSnapshot):string[]{const m=s.statistics.summary;if(s.tenderStatistics)return [
 '本报告按固定模板生成，统计范围及数据截止时间如下。报告供业务分析使用，尚未履行业务审核或发布程序。',
 `统计期间：${s.input.query.from} 至 ${s.input.query.to}；数据范围：${s.input.query.dataset==='ledger'?'诉求总账':'分析库'}；取值方式：${s.input.query.projection==='current'?'当前有效数据':'入库时数据'}；数据截止：${m.dataCutoffAt}。`,
 `选定期间诉求 ${m.total} 条，${s.tenderStatistics.services.map(service=>service.title+' '+service.total+' 条').join('、')}。年、季、月统计截至 ${s.input.query.to}，可能超出所选开始日期；各表均标明实际统计期间。`,
 '时间按北京时间计算；来源填报时间优先，缺失或无效时采用平台接收时间。同比比较上年同期间，月度、季度环比比较上一期间的可比经过日数；年度环比以上年同期累计为基期。基期为零、日期缺失或缺少依据时显示不可用。',
 ...(s.dataSources?[`数据来源说明：选定期间包含 ${s.dataSources.selectedDemoCount} 条演示记录；年季月扩展范围包含 ${s.dataSources.calendarDemoCount} 条演示记录。演示记录与业务记录共同按当前筛选范围统计，请据此核实报告用途。`]:['数据来源说明：沿用当前授权数据范围，未取得独立的来源核验标记。']),
 ...(m.partial?['部分记录缺少有效日期，统计与比较存在数据缺口。']:[]),
 ...(m.total===0?['选定期间无匹配数据，不能据此推断满意度或服务质量。']:[]),
 ...Object.entries(m.excludedByReason).map(([reason,count])=>`未计入原因：${reason}，${count} 条。`)
 ];return [
 '本报告为 statistics-draft v1 工程草稿。统计、比较、户数和热力政策待业务确认，本稿不代表正式核准或对外发布。',
 `数据集 ${s.input.query.dataset}；取值 ${s.input.query.projection}；期间 ${s.input.query.from} 至 ${s.input.query.to}；快照截止 ${m.dataCutoffAt}。`,
 `本期共 ${m.total} 条；无空间定位 ${m.unlocatedCount} 条；多网格 ${m.multiGridCount} 条。网格分组可能重叠，不能相加作为总数。`,
 `政策 ${m.policy.id} 版本 ${m.policy.version} ${m.policy.label}。时间口径 ${m.timeBasis}。${m.partial?'统计不完整，存在不可用日期或字段。':'按选定口径统计。'}`,
 `未知日期 ${m.dateFilterUnavailableCount} 条；收件日期回退 ${m.sourceTimeFallbackCount} 条。总体人口指标 ${m.overallRate.reason}；满意度 ${m.satisfactionRate.reason}。`,
 ...Object.entries(m.excludedByReason).map(([reason,count])=>`未计入原因 ${reason}：${count} 条。`),
 ...(m.total===0?['选定期间无匹配数据；不以空样本推断政策、满意度或热力等级。']:[])
 ];}
async function docxBytes(s:ReportSnapshot):Promise<Buffer>{
 const para=(text:string)=>new Paragraph({children:[new TextRun({text,font:'Microsoft YaHei',size:22,color:'000000'})],spacing:{after:150,line:320}});
 const border={style:BorderStyle.SINGLE,size:4,color:'D9D9D9'};
 const table=(headers:string[],data:(string|number|null)[][])=>new Table({width:{size:100,type:WidthType.PERCENTAGE},borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},rows:[headers,...data].map((row,i)=>new TableRow({tableHeader:i===0,cantSplit:true,children:row.map(v=>new TableCell({verticalAlign:VerticalAlign.CENTER,margins:{top:90,bottom:90,left:100,right:100},shading:{fill:i===0?'E5EDF5':i%2?'FFFFFF':'F5F7FA'},children:[new Paragraph({children:[new TextRun({text:displayed(v),font:'Microsoft YaHei',size:20,bold:i===0,color:'000000'})],spacing:{after:50,line:260}})]}))}))});
 const children:any[]=[new Paragraph({text:s.tenderStatistics?'供水燃气诉求统计分析报告':'供水燃气诉求统计报告草稿',heading:HeadingLevel.TITLE}),...reportIntro(s).map(para),new Paragraph({text:'期间数量图',heading:HeadingLevel.HEADING_1}),new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({type:'png',data:reportChart(s),transformation:{width:540,height:189},altText:{title:'期间数量对比',description:reportChartValues(s).map((v,i)=>`${i+1} ${v.label} ${v.value}`).join('；'),name:'period-counts'}})]}),para(reportChartValues(s).map((v,i)=>`${i+1} ${v.label} ${v.value} 条`).join('；'))];
 for(const section of reportSections(s)){children.push(new Paragraph({text:section.title,heading:HeadingLevel.HEADING_1}));children.push(section.rows.length?table(section.headers,section.rows):para('本节无可用数据。'));children.push(para(''));}
 const doc=new Document({creator:'gqxq',title:s.tenderStatistics?'供水燃气诉求统计分析报告':'供水燃气诉求统计报告草稿',description:s.tenderStatistics?'固定模板，按冻结统计数据生成':'工程草稿，政策待业务确认',lastModifiedBy:'gqxq',revision:1,styles:{default:{document:{run:{font:'Microsoft YaHei',size:22,color:'000000'}}},paragraphStyles:[{id:'Title',name:'Title',basedOn:'Normal',run:{size:36,bold:true,color:'000000'},paragraph:{spacing:{after:260}}},{id:'Heading1',name:'Heading 1',basedOn:'Normal',run:{size:26,bold:true,color:'000000'},paragraph:{spacing:{before:240,after:140},keepNext:true}}]},sections:[{properties:{page:{margin:{top:1100,bottom:1100,left:1000,right:1000}}},children}]});
 return Packer.toBuffer(doc);
}
async function xlsxBytes(s:ReportSnapshot):Promise<Buffer>{
 const workbook=new ExcelJS.Workbook();workbook.creator='gqxq';workbook.created=new Date(s.statistics.summary.dataCutoffAt);workbook.modified=workbook.created;
 const sheet=workbook.addWorksheet('统计报告',{views:[{showGridLines:false}],pageSetup:{paperSize:9,orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0}});
 sheet.columns=[{width:19},{width:30},{width:18},{width:18},{width:20},{width:44}];
 let row=1;const full=(text:string,size=11,bold=false)=>{sheet.mergeCells(row,1,row,6);const c=sheet.getCell(row,1);c.value=text;c.font={name:'Microsoft YaHei',size,bold,color:{argb:'FF000000'}};c.alignment={wrapText:true,vertical:'middle'};sheet.getRow(row).height=Math.max(size*2,Math.ceil(text.length/80)*18);row++;};
 full(s.tenderStatistics?'供水燃气诉求统计分析报告':'供水燃气诉求统计报告草稿',18,true);reportIntro(s).forEach(t=>full(t));full('期间数量图',13,true);
 const image=workbook.addImage({buffer:reportChart(s) as any,extension:'png'});sheet.addImage(image,{tl:{col:0,row:row-1},ext:{width:700,height:245}});for(let i=0;i<14;i++)sheet.getRow(row++).height=18;full(reportChartValues(s).map((v,i)=>`${i+1} ${v.label} ${v.value} 条`).join('；'));
 for(const section of reportSections(s)){full(section.title,13,true);const heading=sheet.getRow(row++);heading.values=section.headers;heading.font={bold:true,name:'Microsoft YaHei',color:{argb:'FF000000'}};heading.height=28;heading.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE5EDF5'}};c.alignment={wrapText:true,vertical:'middle'};});
  if(!section.rows.length){full('本节无可用数据。');continue;}
  for(const values of section.rows){const r=sheet.getRow(row++);r.values=values.map(v=>v===null?'未知或不可用':v);r.font={name:'Microsoft YaHei',size:11};r.height=Math.max(25,...values.map((v,i)=>Math.ceil(displayed(v).length/(sheet.columns[i].width??20))*17));r.eachCell(c=>{c.alignment={wrapText:true,vertical:'middle'};c.border={bottom:{style:'thin',color:{argb:'FFD9D9D9'}}};if(typeof c.value==='number')c.numFmt=Number.isInteger(c.value)?'#,##0':'0.00';});}row++;
 }
 sheet.pageSetup.printArea='A1:F'+(row-1);return Buffer.from(await workbook.xlsx.writeBuffer());
}
/** Stabilize ZIP/core metadata introduced by Office generators. No re-export on download. */
export async function renderReport(s:ReportSnapshot):Promise<Buffer>{
 if(!reportRendererAvailable(s.renderPlan))throw AppError.validation('RENDERER_UNAVAILABLE');
 const raw=s.input.format==='docx'?await docxBytes(s):await xlsxBytes(s);const source=await JSZip.loadAsync(raw),zip=new JSZip();
 for(const name of Object.keys(source.files).sort()){const entry=source.files[name];if(entry.dir)continue;let bytes=await entry.async('nodebuffer');if(name==='docProps/core.xml'){let text=bytes.toString().replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]+/g,'$1'+s.statistics.summary.dataCutoffAt);bytes=Buffer.from(text);}if(name==='word/document.xml'){let id=0;bytes=Buffer.from(bytes.toString().replace(/<wp:docPr id="\d+"/g,()=>'<wp:docPr id="'+(++id)+'"'));}zip.file(name,bytes,{date:new Date('1980-01-01T00:00:00Z'),createFolders:false});}
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});if(bytes.length>REPORT_LIMITS.artifact)throw AppError.validation('报告产物超过工程限额');return bytes;
}
