import assert from 'node:assert/strict';
import test,{before} from 'node:test';
let domain:any={};before(async()=>{try{domain=await import('../src/domain/sourceProcess');}catch{}});
const node=(extra:any={})=>({sourceSystem:'synthetic',sourceId:'S1',nodeId:'N1',sourceSequence:1,sourceVersion:'v1',occurredAt:'2026-10-01T00:00:00Z',stage:'受理',department:null,contactName:null,opinion:null,...extra});
test('unavailable process adapter has typed state and performs no fake fetch',async()=>{
 assert.equal(typeof domain.UnavailableSourceProcessAdapter,'function');
 await assert.rejects(new domain.UnavailableSourceProcessAdapter().fetch('S1'),(e:any)=>e.code==='SOURCE_PROCESS_UNAVAILABLE');
});
test('four sources preserve proven identity, same-time source sequence and null-time anomalies',()=>{
 assert.equal(typeof domain.normalizeSourceProcessNode,'function');
 for(const sourceSystem of ['s1','s2','s3','s4'])assert.equal(domain.normalizeSourceProcessNode(node({sourceSystem}),sourceSystem,'S1').sourceSystem,sourceSystem);
 const nodes=[node({nodeId:'N2',sourceSequence:2}),node({nodeId:'N1',sourceSequence:1}),node({nodeId:'N3',sourceSequence:null,occurredAt:null})];
 const ordered=domain.orderSourceProcessNodes(nodes);assert.deepEqual(ordered.map((n:any)=>n.nodeId),['N1','N2','N3']);assert.equal(ordered[2].occurredAt,null);
 assert.throws(()=>domain.normalizeSourceProcessNode(node({nodeId:''}),'synthetic','S1'));
 assert.throws(()=>domain.normalizeSourceProcessNode(node({sourceId:'wrong'}),'synthetic','S1'));
 assert.throws(()=>domain.normalizeSourceProcessNode(node({occurredAt:'invalid'}),'synthetic','S1'));
});
test('node projection rejects nested contact/opinion and never forwards unknown source payload',()=>{
 assert.equal(typeof domain.normalizeSourceProcessNode,'function');
 const projected=domain.normalizeSourceProcessNode(node({secret:'SECRET',opinion:'第一行\n第二行'}),'synthetic','S1');
 assert.equal(projected.opinion,'第一行\n第二行');assert.equal('secret' in projected,false);
 assert.throws(()=>domain.normalizeSourceProcessNode(node({contactName:{token:'SECRET'}}),'synthetic','S1'));
});
test('blank source version is not a trustworthy revision identifier',()=>{
 assert.throws(()=>domain.normalizeSourceProcessNode(node({sourceVersion:'  '}),'synthetic','S1'));
});
