import test from 'node:test';import assert from 'node:assert/strict';import JSZip from 'jszip';
import {simulatedSupportData,defaultSupportWarnings} from '../src/domain/tenderSupportData';
import {renderSupportReport,supportReportSections} from '../src/services/tenderSupportReport';
import {buildSupportStatistics} from '../src/domain/supportStatisticsModel';
test('supplement export shares UI aggregation, carries provenance, and renders both formats',async()=>{
 const d=simulatedSupportData('2026-11-10'),s=buildSupportStatistics(d,'2026-01-01','2026-11-10');
 assert.ok(d.complaints.every(c=>!c.completedAt||new Date(Date.parse(c.completedAt)+8*3600000).toISOString().slice(0,10)<='2026-11-10'));
 const sections=supportReportSections(d,defaultSupportWarnings,'2026-01-01','2026-11-10');assert.equal(sections.find(s=>s.title==='满意度分析')!.rows[0][0],s.evaluation.satisfiedCount);assert.ok(sections.some(s=>s.title==='冬季保供前六网格'));
 const doc=await renderSupportReport(d,defaultSupportWarnings,'2026-01-01','2026-11-10','docx');const zip=await JSZip.loadAsync(doc),xml=await zip.file('word/document.xml')!.async('string');assert.ok(xml.includes('【模拟数据】'));assert.ok(xml.includes('四场景预警'));
 const xlsx=await renderSupportReport(d,defaultSupportWarnings,'2026-01-01','2026-11-10','xlsx');assert.ok((await JSZip.loadAsync(xlsx)).file('xl/workbook.xml'));
});
