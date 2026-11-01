import {deflateSync} from 'node:zlib';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {Document,Packer,Paragraph,TextRun,HeadingLevel,Table,TableRow,TableCell,WidthType,BorderStyle,ImageRun,AlignmentType,VerticalAlign} from 'docx';
import {AppError} from '../http/errors';
import {RENDER_PLAN,PROCUREMENT_RENDER_PLAN,REPORT_LIMITS,type ReportSnapshot} from '../domain/reportSnapshot';
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
 const m=s.statistics.summary;
 if(s.input.templateCode==='procurement-statistics')return procurementSections(s);
 const sections=[{title:'期间比较',headers:['比较口径','基期范围','本期数量','基期数量','变化百分比','说明'],rows:m.comparisons.map(c=>[c.label,c.from&&c.to?c.from+' 至 '+c.to:'不可用',c.currentCount,c.baselineCount,c.changePercent,c.reason??(c.truncated?'基期按候选规则截短':'候选政策，待业务确认')])},{title:'统计分布',headers:['维度','分类或对象','字典版本','数量'],rows:m.dimensions.map(d=>[d.dimension+(d.level?' '+d.level:''),d.name,d.dictionaryVersion??null,d.count])},{title:'按日统计',headers:['业务日期','数量'],rows:m.trend.map(t=>[t.date,t.count])},{title:'历史户数与候选指标',headers:['企业','选定日期','户数','历史版本','每万户事件数','说明'],rows:m.rates.map(r=>[r.enterpriseCode,r.at,r.households,r.version,r.value,r.reason??r.label])}];
 if(s.heat)sections.push({title:'热力统计',headers:['服务网格','数量','规则版本','政策版本','状态说明'],rows:s.heat.data.grids.map(g=>[g.code,g.count,g.ruleVersion,g.policyVersion,g.reason??g.level??'不可用'])} as any);
 return sections;
}
const displayed=(v:string|number|null)=>v===null?'未知或不可用':typeof v==='number'&&!Number.isInteger(v)?v.toFixed(2):String(v);
const reportTitle=(s:ReportSnapshot)=>s.input.templateCode==='procurement-statistics'?'供水燃气诉求统计分析报告':'供水燃气诉求统计报告草稿';
function procurementIntro(s:ReportSnapshot):string[]{
 const m=s.statistics.summary,r=m.satisfactionRate;
 return [
  `本报告依据冻结的授权案件生成，期间为 ${m.query.from} 至 ${m.query.to}，资料截止 ${m.dataCutoffAt}。纳入宜接就办来源明确办结的供水、供气案件，以来源录入时间归属期间。`,
  `本期共 ${m.total} 件，未定位 ${m.unlocatedCount} 件。${m.partial?'存在缺失来源日期的记录，统计不完整。':'来源覆盖仍需与提供方对账；无案件不能证明来源完整。'}`,
  `满意率 ${r.value===null?'不可计算':r.value.toFixed(2)+'%'}；满意案件 ${r.satisfiedCount??'未知'} 件，有效评价案件 ${r.validCount??'未知'} 件。${r.reason}`,
  `模板 procurement-statistics v1；政策 ${m.policy.id} 版本 ${m.policy.version}；数据集 ${m.query.dataset}，取值 ${m.query.projection}。分类版本 ${[...new Set(s.statistics.categoryEvidence.map(e=>e.dictionaryVersion))].join('、')||'未提供'}。`,
  '日历同比环比、末次回访优先及人口指标仍需业务确认；本报告保存计算依据，不代表完成业务审批。网格可能重叠，不相加作为总量。',
 ];
}
function procurementSections(s:ReportSnapshot):{title:string;headers:string[];rows:(string|number|null)[][]}[]{
 const m=s.statistics.summary;
 const distribution=(dimension:string)=>m.dimensions.filter(d=>d.dimension===dimension).map(d=>[d.name,d.dictionaryVersion??null,d.count,m.total?Math.round(d.count/m.total*10000)/100:null]);
 const communities=new Map<string,number>();for(const row of s.statistics.rows){const code=row.communityCode;if(code)communities.set(code,1+(communities.get(code)??0));}
 const r=m.satisfactionRate,evidence=s.statistics.satisfactionEvidence;
 const diss=evidence?.evidence.filter(e=>e.evaluation==='dissatisfied')??[];
 const byId=new Map(s.statistics.rows.map(row=>[row.complaintId,row]));
 const sections:{title:string;headers:string[];rows:(string|number|null)[][]}[]=[
  {title:'供水供气分项',headers:['业务','分类版本','件数','占总量百分比'],rows:distribution('business')},
  {title:'类型构成',headers:['类型','分类版本','件数','占总量百分比'],rows:m.dimensions.filter(d=>d.dimension==='category').map(d=>[(d.level==='major'?'大类 ':'小类 ')+d.name,d.dictionaryVersion??null,d.count,m.total?Math.round(d.count/m.total*10000)/100:null])},
  {title:'区域分布',headers:['区域','版本说明','件数','占总量百分比'],rows:distribution('district')},
  {title:'高频小区',headers:['小区编码','件数','资料说明'],rows:[...communities].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,10).map(([code,count])=>[code,count,'按已核验小区编码聚合；缺归属案件不纳入排名'])},
  {title:'企业分布',headers:['企业','版本说明','件数','占总量百分比'],rows:distribution('enterprise')},
  {title:'总量及变化',headers:['比较','基期范围','本期件数','基期件数','变化百分比','说明'],rows:m.comparisons.map(c=>[c.label,c.from&&c.to?c.from+' 至 '+c.to:'不可用',c.currentCount,c.baselineCount,c.changePercent,c.reason??'同一采购准入与来源录入时间；日历对齐规则待业务确认'])},
  {title:'按日趋势',headers:['来源录入日期','件数'],rows:m.trend.map(t=>[t.date,t.count])},
  {title:'满意度',headers:['指标','分子件数','分母件数','百分比','口径'],rows:[['满意占比',r.satisfiedCount??null,r.validCount??null,r.value,r.reason],['不满意占比',r.validCount===undefined||r.satisfiedCount===undefined?null:r.validCount-r.satisfiedCount,r.validCount??null,r.value===null?null:Math.round((100-r.value)*100)/100,'同一批有效接通评价案件'],...(['water','gas'] as const).map(b=>{const n=diss.filter(e=>byId.get(e.complaintId)?.businessType===b).length;return [b==='water'?'供水不满意构成':'供气不满意构成',n,diss.length,diss.length?Math.round(n/diss.length*10000)/100:null,'分母为两行业不满意案件总数'] as (string|number|null)[];})]},
  {title:'指标说明',headers:['指标','数值','说明'],rows:[['每万户指标',null,m.overallRate.reason],...m.rates.map(h=>[h.enterpriseCode,h.value,h.reason??h.label] as (string|number|null)[])]},
  {title:'数据完整性',headers:['未计入原因或资料项','件数','说明'],rows:[...Object.entries(m.excludedByReason).map(([reason,count])=>[reason,count,'同一授权范围内的排除记录'] as (string|number|null)[]),['来源日期不可用',m.dateFilterUnavailableCount,'不回退本系统接收时间'],['缺小区归属',s.statistics.rows.filter(row=>!row.communityCode).length,'不以缺失归属推定小区零案件'],['回访未纳入有效评价',evidence?.excluded.length??null,'当前来源版本；排除原因随统计快照冻结'],['来源对账',null,'正式接口映射、历史覆盖及回执待真实联调确认']]},
 ];
 if(s.heat)sections.push({title:'热力统计',headers:['服务网格','数量','规则版本','政策版本','说明'],rows:s.heat.data.grids.map(g=>[g.code,g.count,g.ruleVersion,g.policyVersion,g.reason??g.level??'不可用'])});
 return sections;
}
function reportIntro(s:ReportSnapshot):string[]{const m=s.statistics.summary;if(s.input.templateCode==='procurement-statistics')return procurementIntro(s);return [
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
 const children:any[]=[new Paragraph({text:reportTitle(s),heading:HeadingLevel.TITLE}),...reportIntro(s).map(para),new Paragraph({text:'期间数量图',heading:HeadingLevel.HEADING_1}),new Paragraph({alignment:AlignmentType.CENTER,children:[new ImageRun({type:'png',data:reportChart(s),transformation:{width:540,height:189},altText:{title:'期间数量对比',description:reportChartValues(s).map((v,i)=>`${i+1} ${v.label} ${v.value}`).join('；'),name:'period-counts'}})]}),para(reportChartValues(s).map((v,i)=>`${i+1} ${v.label} ${v.value} 条`).join('；'))];
 for(const section of reportSections(s)){children.push(new Paragraph({text:section.title,heading:HeadingLevel.HEADING_1}));children.push(section.rows.length?table(section.headers,section.rows):para('本节无可用数据。'));children.push(para(''));}
 const doc=new Document({creator:'gqxq',title:reportTitle(s),description:s.input.templateCode==='procurement-statistics'?'固定统计模板；以快照中的口径与限制为准':'工程草稿，政策待业务确认',lastModifiedBy:'gqxq',revision:1,styles:{default:{document:{run:{font:'Microsoft YaHei',size:22,color:'000000'}}},paragraphStyles:[{id:'Title',name:'Title',basedOn:'Normal',run:{size:36,bold:true,color:'000000'},paragraph:{spacing:{after:260}}},{id:'Heading1',name:'Heading 1',basedOn:'Normal',run:{size:26,bold:true,color:'000000'},paragraph:{spacing:{before:240,after:140},keepNext:true}}]},sections:[{properties:{page:{margin:{top:1100,bottom:1100,left:1000,right:1000}}},children}]});
 return Packer.toBuffer(doc);
}
async function xlsxBytes(s:ReportSnapshot):Promise<Buffer>{
 const workbook=new ExcelJS.Workbook();workbook.creator='gqxq';workbook.created=new Date(s.statistics.summary.dataCutoffAt);workbook.modified=workbook.created;
 const sheet=workbook.addWorksheet('统计报告',{views:[{showGridLines:false}],pageSetup:{paperSize:9,orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0}});
 sheet.columns=[{width:19},{width:30},{width:18},{width:18},{width:20},{width:44}];
 let row=1;const full=(text:string,size=11,bold=false)=>{sheet.mergeCells(row,1,row,6);const c=sheet.getCell(row,1);c.value=text;c.font={name:'Microsoft YaHei',size,bold,color:{argb:'FF000000'}};c.alignment={wrapText:true,vertical:'middle'};sheet.getRow(row).height=Math.max(size*2,Math.ceil(text.length/80)*18);row++;};
 full(reportTitle(s),18,true);reportIntro(s).forEach(t=>full(t));full('期间数量图',13,true);
 const image=workbook.addImage({buffer:reportChart(s) as any,extension:'png'});sheet.addImage(image,{tl:{col:0,row:row-1},ext:{width:700,height:245}});for(let i=0;i<14;i++)sheet.getRow(row++).height=18;full(reportChartValues(s).map((v,i)=>`${i+1} ${v.label} ${v.value} 条`).join('；'));
 for(const section of reportSections(s)){full(section.title,13,true);const heading=sheet.getRow(row++);heading.values=section.headers;heading.font={bold:true,name:'Microsoft YaHei',color:{argb:'FF000000'}};heading.height=28;heading.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE5EDF5'}};c.alignment={wrapText:true,vertical:'middle'};});
  if(!section.rows.length){full('本节无可用数据。');continue;}
  for(const values of section.rows){const r=sheet.getRow(row++);r.values=values.map(v=>v===null?'未知或不可用':v);r.font={name:'Microsoft YaHei',size:11};r.height=Math.max(25,...values.map((v,i)=>Math.ceil(displayed(v).length/(sheet.columns[i].width??20))*17));r.eachCell(c=>{c.alignment={wrapText:true,vertical:'middle'};c.border={bottom:{style:'thin',color:{argb:'FFD9D9D9'}}};if(typeof c.value==='number')c.numFmt=Number.isInteger(c.value)?'#,##0':'0.00';});}row++;
 }
 sheet.pageSetup.printArea='A1:F'+(row-1);return Buffer.from(await workbook.xlsx.writeBuffer());
}
/** Stabilize ZIP/core metadata introduced by Office generators. No re-export on download. */
export async function renderReport(s:ReportSnapshot):Promise<Buffer>{
 if(s.renderPlan!==RENDER_PLAN&&s.renderPlan!==PROCUREMENT_RENDER_PLAN)throw AppError.validation('RENDERER_UNAVAILABLE');
 const raw=s.input.format==='docx'?await docxBytes(s):await xlsxBytes(s);const source=await JSZip.loadAsync(raw),zip=new JSZip();
 for(const name of Object.keys(source.files).sort()){const entry=source.files[name];if(entry.dir)continue;let bytes=await entry.async('nodebuffer');if(name==='docProps/core.xml'){let text=bytes.toString().replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]+/g,'$1'+s.statistics.summary.dataCutoffAt);bytes=Buffer.from(text);}if(name==='word/document.xml'){let id=0;bytes=Buffer.from(bytes.toString().replace(/<wp:docPr id="\d+"/g,()=>'<wp:docPr id="'+(++id)+'"'));}zip.file(name,bytes,{date:new Date('1980-01-01T00:00:00Z'),createFolders:false});}
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});if(bytes.length>REPORT_LIMITS.artifact)throw AppError.validation('报告产物超过工程限额');return bytes;
}
