import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {reportCapture,reportQuery} from './helpers/reportFixture';
test('real DOCX/XLSX deterministic OOXML contains charts and frozen aggregates without private rows',async()=>{
 assert.ok(existsSync(new URL('../src/services/reportRenderer.ts',import.meta.url)),'D3 real renderer missing');
 const {renderReport}=await import('../src/services/reportRenderer');const {freezeReportSnapshot,parseReportInput}=await import('../src/domain/reportSnapshot');const JSZip=(await import('jszip')).default;
 for(const format of ['docx','xlsx'] as const){
  const capture=reportCapture();capture.summary.dimensions[0].name='=SUM(1,2)';
  const snap=freezeReportSnapshot(parseReportInput({requestId:'synthetic',templateCode:'statistics-draft',templateVersion:'v1',format,query:reportQuery}),capture,[{kind:'all'}]);
  const bytes=await renderReport(snap);assert.deepEqual(await renderReport(snap),bytes);const zip=await JSZip.loadAsync(bytes);
  await assert.rejects(()=>renderReport({...snap,renderPlan:'unavailable-old-renderer'} as any),/RENDERER_UNAVAILABLE/);
  const xml=(await Promise.all(Object.keys(zip.files).filter(k=>k.endsWith('.xml')).map(k=>zip.files[k].async('string')))).join('');
  assert.ok(xml.includes('待业务确认'));assert.equal(xml.includes('PRIVATE_SOURCE_TITLE'),false);assert.ok(Object.keys(zip.files).some(k=>k.endsWith('.png')));
  if(format==='xlsx'){assert.equal(xml.includes('<f>'),false);assert.ok(xml.includes('=SUM(1,2)'));}else assert.ok(xml.includes('<w:cantSplit'));
 }
});
