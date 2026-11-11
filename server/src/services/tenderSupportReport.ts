import ExcelJS from 'exceljs';
import {Document,Packer,Paragraph,Table,TableRow,TableCell,HeadingLevel,TextRun,WidthType} from 'docx';
import {buildSupportStatistics} from '../domain/supportStatisticsModel';
import {buildSupportResearch,isLocalDate} from '../domain/supportResearchModel';
import {eventsInRange,complaintsForEvent} from '../domain/supportLayersModel';
import type {TenderDataset,SupportWarningConfig} from '../types/tenderSupport';
import {AppError} from '../http/errors';
type Section={title:string;headers:string[];rows:(string|number)[][]};
const percentage=(v:number|null)=>v===null?'无有效评价':v.toFixed(2)+'%';
export function supportReportSections(d:TenderDataset,c:SupportWarningConfig,from:string,to:string):Section[]{
 if(!isLocalDate(from)||!isLocalDate(to)||from>to)throw AppError.validation('报告日期无效');
 const s=buildSupportStatistics(d,from,to),r=buildSupportResearch(d,from,to,c.rules);
 const sections:Section[]=[
 {title:'数据来源与口径',headers:['项目','值'],rows:[['数据性质',d.mode==='simulation'?'模拟数据，非真实业务结果':'真实接入数据'],['来源',d.sourceLabel],['数据版本',d.revision],['规则版本',c.revision],['统计期间',from+' 至 '+to],['诉求量',s.rows.length],['满意度分母','仅已评价记录；未评价单列'],['处理时长','发生至办结，互斥区间；未办结单列']]},
 {title:'满意度分析',headers:['满意','不满意','未评价','满意比例','不满意比例'],rows:[[s.evaluation.satisfiedCount,s.evaluation.unsatisfiedCount,s.evaluation.missingCount,percentage(s.evaluation.satisfiedPercent),percentage(s.evaluation.unsatisfiedPercent)]]},
 {title:'不满意诉求业务占比',headers:['业务','不满意件数','占全部不满意比例'],rows:s.unsatisfiedBusiness.map(b=>[b.name,b.count,percentage(b.percent)])},
 {title:'办理时长',headers:['时长','件数','满意比例','不满意比例','未评价'],rows:[...s.duration.map(b=>[b.name,b.count,percentage(b.evaluation.satisfiedPercent),percentage(b.evaluation.unsatisfiedPercent),b.evaluation.missingCount]),['未办结',s.openRows.length,'—','—','—'],['无效办理时间',s.invalidDurationRows.length,'—','—','—']]},
 {title:'小区诉求排名',headers:['排名','小区','数量'],rows:s.communities.map(x=>[x.rank,x.name,x.count])},
 {title:'企业每万户诉求量',headers:['企业','诉求量','服务户数','每万户诉求量'],rows:s.enterpriseRates.map(x=>[x.name,x.count,x.households??'未知',x.per10k===null?'不可用':x.per10k.toFixed(2)])},
 {title:'同期事件及关联诉求',headers:['事件','业务','开始','结束','涉及户数','关联诉求'],rows:eventsInRange(d.events,from,to).map(e=>[e.title,e.kind,e.startsAt,e.endsAt,e.households,complaintsForEvent(d,e,from,to).length])},
 {title:'往年同期前三类',headers:['类型','数量','期间'],rows:r.priorTop3.map(x=>[x.name,x.rows.length,r.priorRange.from+' 至 '+r.priorRange.to])},
 {title:'四场景预警',headers:['场景','观察窗','数量','阈值','状态'],rows:r.warnings.map(w=>[w.rule.name,w.from+' 至 '+w.to,w.rows.length,w.rule.threshold,!w.rule.enabled?'停用':w.triggered?'触发预警':'未达阈值'])}
 ];
 for(const [name,season] of [['冬季保供',r.winter],['夏季保畅',r.summer]] as const){
  sections.push({title:name+'近五季',headers:['季年度','实际期间','诉求量'],rows:season.years.map(y=>[y.year,y.from+' 至 '+y.to,y.rows.length])});
  sections.push({title:name+'月度对比',headers:['月份','本季数量','上一季数量','本季月份范围','上一季月份范围'],rows:season.months.map(m=>[m.label,m.currentRows.length,m.previousRows.length,m.currentRange.from+' 至 '+m.currentRange.to,m.previousRange.from+' 至 '+m.previousRange.to])});
  sections.push({title:name+'前六网格',headers:['网格','本季数量','上一季数量'],rows:season.topGrids.map(g=>[g.name,g.rows.length,g.previousRows.length])});
 }
 return sections;
}
export async function renderSupportReport(d:TenderDataset,c:SupportWarningConfig,from:string,to:string,format:'docx'|'xlsx'){
 const sections=supportReportSections(d,c,from,to),title=(d.mode==='simulation'?'【模拟数据】':'')+'供水燃气专题统计分析报告';
 if(format==='xlsx'){const book=new ExcelJS.Workbook();book.creator='宜昌诉求平台';for(const [i,s] of sections.entries()){const sheet=book.addWorksheet(String(i+1)+' '+s.title);sheet.addRow([title]);sheet.addRow(s.headers);sheet.getRow(2).font={bold:true};for(const r of s.rows)sheet.addRow(r);sheet.columns.forEach(col=>{col.width=24;});sheet.views=[{state:'frozen',ySplit:2}];}return Buffer.from(await book.xlsx.writeBuffer());}
 const children:(Paragraph|Table)[]=[new Paragraph({text:title,heading:HeadingLevel.TITLE}),new Paragraph(d.mode==='simulation'?'本报告所有专题数据均为模拟，不能作为真实业务结论。':'本报告采用所列真实接入版本。')];
 for(const s of sections){children.push(new Paragraph({text:s.title,heading:HeadingLevel.HEADING_1}));children.push(new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:[s.headers,...s.rows].map((row,i)=>new TableRow({tableHeader:i===0,children:row.map(cell=>new TableCell({children:[new Paragraph({children:[new TextRun({text:String(cell),bold:i===0,size:20})]})]}))}))}));}
 return Packer.toBuffer(new Document({creator:'宜昌诉求平台',title,sections:[{children}]}));
}
