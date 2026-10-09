import assert from 'node:assert/strict';
import test from 'node:test';
import {runWithAccessContext} from '../src/auth/accessScope';
import {buildWhere} from '../src/repositories/complaintRepo';
import {parseListQuery} from '../src/services/complaintService';
import {projectComplaintDetail} from '../src/services/complaintProjection';
import {isAllowed} from '../src/auth/rolePolicy';
const ctx={userId:'synthetic',roles:['custom'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false};
test('source-only public document number joins escaped keyword search without bypassing scope',()=>{
 const where=runWithAccessContext(ctx,()=>buildWhere({keyword:'公文!%_'}));
 assert.match(where.text,/c.source_id like \? escape '!'/);
 assert.deepEqual(where.params,['%公文!!!%!_%','%公文!!!%!_%','%公文!!!%!_%','%公文!!!%!_%','%公文!!!%!_%']);
 assert.match(buildWhere({keyword:'number'}).text,/0 = 1/);
});
test('every allowed ordering ends in numeric key to break tied dates and names',()=>{
 for(const [sort,ending] of [['receivedAt,desc',', c.id desc'],['receivedAt,asc',', c.id asc'],['complaintNo,asc',', c.id asc'],['urgencyLevel,desc',', c.id desc']])assert.ok(parseListQuery({sort}).orderBy.endsWith(ending));
 assert.throws(()=>parseListQuery({sort:'sourceId; drop,asc'}),{status:400});
});
test('original A and confirmed B retain separate provenance and missing source dates never use receipt/closure',()=>{
 const detail=projectComplaintDetail({id:1,complaint_id:'C1',address:'B',source_fields:{address:'A',_receivedAt:'2026-10-09T00:00:00Z'},received_at:new Date('2026-10-09T00:00:00Z'),source_updated_at:new Date('2026-10-09T00:00:00Z'),closed_at:new Date('2026-10-10T00:00:00Z'),effective_field_state:{address:{resolution:'confirmed',value:'B',version:2}},source_payload:{secret:'SECRET'}},ctx);
 assert.equal(detail.sourceAddress,'A');assert.equal(detail.effectiveAddress,'B');
 assert.equal(detail.sourceSnapshotAt,'2026-10-09T00:00:00.000Z');
 assert.equal(detail.businessTimeSource,'platform_received_at');assert.equal(detail.sourceDeadlineAt,null);assert.equal(detail.sourceCompletedAt,null);
 assert.ok(detail.sourceFieldReasons.sourceDeadlineAt);assert.ok(detail.sourceFieldReasons.sourceCompletedAt);assert.equal(JSON.stringify(detail).includes('SECRET'),false);
});
test('source business time remains distinct from fallback and unavailable address is explicit',()=>{
 const detail=projectComplaintDetail({id:1,complaint_id:'C1',address:'effective',source_reported_at:new Date('2026-09-01T00:00:00Z'),received_at:new Date('2026-10-09T00:00:00Z')},ctx);
 assert.equal(detail.businessTimeSource,'source_reported_at');assert.equal(detail.sourceAddress,null);assert.ok(detail.sourceFieldReasons.sourceAddress);assert.equal(detail.sourceSnapshotAt,null);
 const missing=projectComplaintDetail({id:1,complaint_id:'C1'},ctx);assert.equal(missing.businessTimeSource,'unavailable');
});
test('process endpoint uses current complaint capability for custom roles and denies revoked direct API',()=>{
 const user={id:'u',username:'u',roles:['custom'],permissionCodes:['complaint.read']};
 assert.equal(isAllowed(user,'GET','/complaints/C1/source-processes').allowed,true);
 assert.equal(isAllowed({...user,permissionCodes:[]},'GET','/complaints/C1/source-processes').allowed,false);
 assert.equal(isAllowed(user,'POST','/complaints/C1/source-processes').allowed,false);
});
