import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
test('comparison requires two or three distinct grids and highlights ties; seasonal windows cross year',async()=>{
 assert.ok(existsSync(new URL('../src/domain/businessAssessment.ts',import.meta.url)),'assessment domain implemented');const d=await import('../src/domain/businessAssessment');
 assert.throws(()=>d.compareAdminGrids(['A'],[]));assert.throws(()=>d.compareAdminGrids(['A','A'],[]));assert.throws(()=>d.compareAdminGrids(['A','B','C','D'],[]));
 const row={complaintId:'1',adminGridCode:'A',majorCode:'W',dictionaryVersion:'5'};const result=d.compareAdminGrids(['A','B'],[row,{...row,complaintId:'2',adminGridCode:'B'},row]);assert.deepEqual(result.categories[0].highest,['A','B']);assert.equal(result.totals.A,1);
 assert.deepEqual(d.seasonRange(2025,11,1),{from:'2025-11-01',to:'2026-01-31'});assert.deepEqual(d.seasonRange(2024,2,2),{from:'2024-02-01',to:'2024-02-29'});
 assert.equal(d.samePeriodYear('2024-02-29',2023),'2023-02-28');assert.equal(d.samePeriodYear('2024-12-01',2023),'2023-12-01');
});
test('top categories distinguish dictionary versions and stable ties',async()=>{const d=await import('../src/domain/businessAssessment');const rows=[{complaintId:'a',majorCode:'B',dictionaryVersion:'1'},{complaintId:'b',majorCode:'A',dictionaryVersion:'1'},{complaintId:'c',majorCode:'A',dictionaryVersion:'2'}];assert.deepEqual(d.topCategories(rows,3).map(r=>[r.code,r.dictionaryVersion,r.count]),[['A','1',1],['A','2',1],['B','1',1]]);});
