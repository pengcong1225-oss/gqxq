import test from 'node:test';import assert from 'node:assert/strict';
import {dispatchWireSubjectMatches,dispatchCallbackSubjectMatches} from '../src/domain/puDispatchEnterprise';
const target='PU-COMPANY-71-water';
const snapshot={enterpriseSubjects:[{subjectCode:'PU-COMPANY-71'}],metadata:{contractVersion:2,enterpriseIdentity:{sourceSystem:'public-utility',sourceKind:'company',sourceId:'71',targetEnterpriseCode:target,gqxqSubjectCode:'PU-COMPANY-71',subjectAliases:[{subjectId:'10',subjectCode:'LEGACY-71',status:'ACTIVE'},{subjectId:'20',subjectCode:'REPORTING_COMPANY_10',status:'ACTIVE'},{subjectId:'30',subjectCode:'RETIRED',status:'DISABLED'}]}}};
test('per-business local key maps only to its frozen authoritative wire company',()=>{
 assert.equal(dispatchWireSubjectMatches(snapshot,target),true);
 assert.equal(dispatchWireSubjectMatches(snapshot,'PU-COMPANY-71-gas'),false);
 assert.equal(dispatchWireSubjectMatches({...snapshot,enterpriseSubjects:[{subjectCode:'PU-COMPANY-72'}]},target),false);
 assert.equal(dispatchWireSubjectMatches({enterpriseSubjects:[{subjectCode:target}]},target),true);
});
test('callback accepts only explicit active original aliases for the frozen company',()=>{
 assert.equal(dispatchCallbackSubjectMatches(snapshot,target,'LEGACY-71'),true);
 assert.equal(dispatchCallbackSubjectMatches(snapshot,target,'REPORTING_COMPANY_10'),true);
 for(const code of ['RETIRED','same-name-other-company','PU-COMPANY-72','LEGACY-72',target])assert.equal(dispatchCallbackSubjectMatches(snapshot,target,code),false);
 assert.equal(dispatchCallbackSubjectMatches(snapshot,'PU-COMPANY-72-water','LEGACY-71'),false);
 assert.equal(dispatchCallbackSubjectMatches(null,target,'LEGACY-71'),false);
 assert.equal(dispatchCallbackSubjectMatches(null,'GQXQ-TEST-20261020','GQXQ-TEST-20261020'),true);
});
test('actual payload and callback relation keep local enterprise and exact assignment bindings',async()=>{
 process.env.GQXQ_DB_USER ||= 'isolated-unit';process.env.GQXQ_DB_NAME ||= 'isolated-unit';process.env.GQXQ_JWT_SECRET ||= 'isolated-unit-key';
 const {buildTaskPayload,validatePushIdentity}=await import('../src/services/dispatchPushService');
 const {serializeOnce}=await import('../src/clients/publicUtilityClient');
 const {relationError}=await import('../src/services/callbackService');
 const prep={assignmentId:'A',requestId:'R',complaintId:'C',complaintNo:'N',sourceEventNo:null,complaintTitle:'Title',targetEnterpriseCode:target,targetEnterpriseName:'Company',requirement:'Complete',reason:null,deadline:new Date(),dispatchType:'manual',triggerType:'manual_flag',status:'pending',reportingTaskId:null,enterpriseIdentity:snapshot.metadata.enterpriseIdentity} as import('../src/services/dispatchService').PushPreparation;
 const payload=buildTaskPayload(prep),bytes=serializeOnce(payload);
 assert.equal((payload.enterpriseSubjects as Array<{subjectCode:string}>)[0].subjectCode,'PU-COMPANY-71');
 assert.doesNotThrow(()=>validatePushIdentity(bytes,'A','C','R',target));
 assert.throws(()=>validatePushIdentity(bytes,'A','C','R','PU-COMPANY-72-water'),/identity mismatch/);
 const event={sourceAppCode:'gqxq',sourceBusinessId:'C',subjectCode:'LEGACY-71',taskId:'T',sceneCode:payload.sceneCode,templateVersion:payload.templateVersion,contractVersion:2,requestId:'R',assignmentId:'A',reportingItemId:'I'} as import('../src/services/callbackService').ParsedEvent;
 const ref={assignmentId:'A',complaintId:'C',subjectCode:target,taskId:'T',requestId:'R',reportingItemId:'I',lastEventSequence:0,status:'processing',pushPayload:payload};
 assert.equal(relationError(event,ref),null);
 for(const changed of [{sourceBusinessId:'OTHER'},{requestId:'OTHER'},{assignmentId:'OTHER'},{taskId:'OTHER'},{subjectCode:'LEGACY-72'},{reportingItemId:'OTHER'}])assert.notEqual(relationError({...event,...changed},ref),null);
});
