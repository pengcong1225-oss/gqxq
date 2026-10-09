import assert from 'node:assert/strict';import test, { before } from 'node:test';
let api:any={};before(async()=>{try{api=await import('../src/services/complaintProjection');}catch{}});
const ctx={userId:'u',roles:['handler'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:true};
test('detail whitelist excludes source documents even for authorized source readers',()=>{
 assert.equal(typeof api.projectComplaintDetail,'function');const detail=api.projectComplaintDetail({id:1,complaint_id:'C',source_payload:{secret:'marker'},source_fields:{secret:'marker'},unexpected_secret:'marker',effective_field_state:{address:{confirmed:true}}},ctx);
 assert.equal(JSON.stringify(detail).includes('marker'),false);assert.equal('sourcePayload' in detail,false);assert.equal('sourceFields' in detail,false);assert.equal(detail.editVersion,1);
});
test('callback and audit projections remove unknown nested documents',()=>{
 assert.equal(typeof api.projectReportingEvent,'function');const p=api.projectReportingEvent({eventId:'E',payload:{eventType:'task_submitted',submissionVersion:1,sourcePayload:{secret:'marker'},attachments:[{attachmentId:1,fileName:'a',size:1,sha256:'s',contentType:'text/plain',secret:'marker'}]}});
 assert.equal(JSON.stringify(p).includes('marker'),false);assert.equal(p.payload.attachments[0].attachmentId,1);
});

test('effective field metadata cannot embed an alternate source document',()=>{
 const detail=api.projectComplaintDetail({id:1,complaint_id:'C',effective_field_state:{source_payload:{resolution:'confirmed',value:{secret:'METADATA_SECRET'},version:1},address:{resolution:'confirmed',value:'核实地址',version:2,reason:'人工核实',sourcePayload:{secret:'METADATA_SECRET'}}}},ctx);
 assert.equal(JSON.stringify(detail).includes('METADATA_SECRET'),false);assert.equal(detail.effectiveFieldState.address.value,'核实地址');
});
test('reporting fields retain normal scalars and count withheld composite/unknown values',()=>{
 const p=api.projectReportingEvent({eventId:'E',payload:{eventType:'TASK_SUBMITTED',eventSequence:2,enterpriseDisposalResult:{result:'已处置',summary:3,disposalContent:null,remark:true,reason:{sourcePayload:'NESTED_SECRET'},sourcePayload:{secret:'NESTED_SECRET'},token:'TOKEN_SECRET',disposalResult:NaN},attachments:[{attachmentId:1,fileName:'材料',size:2,contentType:'text/plain',sha256:'s',token:'TOKEN_SECRET'}]}});
 assert.deepEqual(p.payload.enterpriseDisposalResult,{result:'已处置',summary:3,disposalContent:null,remark:true});assert.equal(p.payload.withheldFieldCount,4);assert.equal(p.payload.eventSequence,2);assert.equal(JSON.stringify(p).includes('SECRET'),false);
});
