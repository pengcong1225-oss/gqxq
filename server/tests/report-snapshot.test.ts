import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {reportCapture,reportQuery} from './helpers/reportFixture';
test('D3 actual immutable capture and bounded envelope exist',async()=>{
 assert.ok(existsSync(new URL('../src/domain/reportSnapshot.ts',import.meta.url)),'D3 immutable snapshot implementation is missing');
 const {freezeReportSnapshot,parseReportInput}=await import('../src/domain/reportSnapshot');
 const input=parseReportInput({requestId:'synthetic-request',templateCode:'statistics-draft',templateVersion:'v1',format:'docx',query:reportQuery});
 const source=reportCapture();const snapshot=freezeReportSnapshot(input,source,[{kind:'all'}]);
 source.summary.total=999;assert.equal(snapshot.statistics.summary.total,10);assert.equal(snapshot.statistics.periodFacts[1].rows.length,8);assert.equal(snapshot.domain.ranges.length,3);assert.deepEqual(snapshot.domain.rules,[{kind:'all'}]);
 const tooLong=reportCapture();tooLong.summary.timeBasis='中'.repeat(2731);assert.throws(()=>freezeReportSnapshot(input,tooLong,[{kind:'all'}]),/限额/);
 assert.throws(()=>parseReportInput({...input,path:'../x'}));assert.throws(()=>parseReportInput({...input,templateVersion:'approved'}));
});
