import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGridComparison, complaintsForCommunity, complaintsForEvent, eventsInRange, inLocalDateRange } from '../src/tenderSupport/layersModel';
import type { SupportComplaint, SupportEvent, TenderDataset } from '../src/tenderSupport/types';

const event: SupportEvent = {id:'e',kind:'planned-water',title:'跨网格停水',enterpriseId:'p',gridIds:['g1','g2'],startsAt:'2026-11-02T10:00:00',endsAt:'2026-11-03T10:00:00',households:100,workers:4,reason:'检修',area:'A',plan:'保障',housing:'小区'};
const complaint = (id:string, changes:Partial<SupportComplaint> = {}):SupportComplaint => ({id,title:id,businessType:'water',type:'停水',enterpriseId:'p',districtCode:'d',gridId:'g1',communityId:'c1',occurredAt:'2026-11-02T10:00:00',completedAt:null,evaluation:'unevaluated',longitude:111,latitude:30,scenario:'planned',...changes});
const data:TenderDataset = {schemaVersion:1,mode:'simulation',revision:1,sourceLabel:'测试模拟',updatedAt:'2026-11-01',grids:['g1','g2','g3','g4'].map(id=>({id,name:id,districtCode:'d',districtName:'区',longitude:111,latitude:30,ring:[]})),communities:[],enterprises:[],events:[event],complaints:[complaint('start'),complaint('end',{gridId:'g2',occurredAt:event.endsAt}),complaint('wrong-grid',{gridId:'g3'}),complaint('wrong-business',{businessType:'gas'}),complaint('before',{occurredAt:'2026-11-02T09:59:59'}),complaint('after',{occurredAt:'2026-11-03T10:00:01'}),complaint('other-community',{communityId:'c2'})]};

test('local date scope includes entire end day and rejects invalid/reversed dates',()=>{
 assert.equal(inLocalDateRange('2026-11-03T23:59:59.999','2026-11-02','2026-11-03'),true);
 assert.equal(inLocalDateRange('2026-11-04T00:00:00','2026-11-02','2026-11-03'),false);
 assert.equal(inLocalDateRange('invalid','2026-11-02','2026-11-03'),false);
 assert.equal(inLocalDateRange('2026-11-03','2026-11-04','2026-11-02'),false);
 assert.equal(inLocalDateRange('2026-11-09T16:00:00Z','2026-11-10','2026-11-10'),true);
 assert.equal(inLocalDateRange('2026-11-09T15:59:59Z','2026-11-10','2026-11-10'),false);
 assert.equal(inLocalDateRange('2026-11-10T15:59:59.999Z','2026-11-10','2026-11-10'),true);
 assert.equal(inLocalDateRange('2026-11-10T16:00:00Z','2026-11-10','2026-11-10'),false);
 assert.equal(inLocalDateRange('2026-02-28','2026-02-28','2026-02-30'),false);
 assert.equal(inLocalDateRange('2026-02-30T10:00:00','2026-02-01','2026-03-01'),false);
});
test('an event remains one event with multiple impacted grids and overlaps the date scope',()=>{
 assert.deepEqual(eventsInRange(data.events,'2026-11-03','2026-11-04').map(r=>r.id),['e']);
 assert.equal(eventsInRange(data.events,'2026-11-04','2026-11-04').length,0);
 assert.deepEqual(complaintsForEvent(data,event,'2026-11-01','2026-11-04').map(r=>r.id),['start','end','other-community']);
 assert.deepEqual(complaintsForEvent(data,event,'2026-11-03','2026-11-03').map(r=>r.id),['end']);
 assert.equal(complaintsForEvent(data,{...event,kind:'emergency-gas'},'2026-11-01','2026-11-04')[0].id,'wrong-business');
 assert.equal(complaintsForEvent(data,{...event,kind:'gas-project'},'2026-11-01','2026-11-04')[0].id,'wrong-business');
 assert.equal(eventsInRange([{...event,startsAt:event.endsAt,endsAt:event.startsAt}],'2026-11-01','2026-11-04').length,0);
});
test('community association uses exact community id plus selected date scope',()=>{
 assert.deepEqual(complaintsForCommunity(data,'c2','2026-11-02','2026-11-02').map(r=>r.id),['other-community']);
 assert.equal(complaintsForCommunity(data,'unknown','2026-11-01','2026-11-04').length,0);
});
test('comparison enforces two to three distinct actual grids and counts exact cell records',()=>{
 assert.throws(()=>buildGridComparison(data,['g1'],'2026-11-01','2026-11-04'));
 assert.throws(()=>buildGridComparison(data,['g1','g1'],'2026-11-01','2026-11-04'));
 assert.throws(()=>buildGridComparison(data,['g1','bad'],'2026-11-01','2026-11-04'));
 assert.throws(()=>buildGridComparison(data,['g1','g2','g3','g4'],'2026-11-01','2026-11-04'));
 const fixture={...data,complaints:[complaint('a'),complaint('b',{gridId:'g2'}),complaint('c',{gridId:'g3',type:'漏水'}),complaint('out',{occurredAt:'2026-10-01'})]};
 const comparison=buildGridComparison(fixture,['g1','g2','g3'],'2026-11-02','2026-11-02');
 assert.equal(comparison.find(r=>r.type==='停水')?.cells[0].records.length,1);
 assert.deepEqual(comparison.find(r=>r.type==='停水')?.cells.map(c=>c.isMaximum),[true,true,false]);
 assert.deepEqual(comparison.find(r=>r.type==='漏水')?.cells.map(c=>c.isMaximum),[false,false,true]);
 assert.deepEqual(buildGridComparison(fixture,['g1','g2'],'2026-12-01','2026-12-02'),[]);
 assert.equal(buildGridComparison(fixture,['g1','g2'],'2026-11-02','2026-11-02').flatMap(r=>r.cells.flatMap(c=>c.records)).length,2);
});
