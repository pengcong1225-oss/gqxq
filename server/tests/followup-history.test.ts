import assert from 'node:assert/strict';
import test from 'node:test';
test('uncontacted/null evaluation and dissatisfied reason are enforced, identities cannot be forged',async()=>{
 const {parseFollowupFacts,parseRevision,parseConclusion}=await import('../src/domain/followup');
 const facts={contacted:false,occurredAt:'2026-10-09T08:30:00+08:00',evaluationCode:null,dissatisfactionReason:null,notes:null};
 assert.equal(parseFollowupFacts(facts).occurredAt,'2026-10-09T00:30:00.000Z');
 assert.throws(()=>parseFollowupFacts({...facts,evaluationCode:'dissatisfied'}),{status:400});
 assert.throws(()=>parseFollowupFacts({...facts,contacted:true,evaluationCode:'dissatisfied'}),{status:400});
 assert.throws(()=>parseFollowupFacts({...facts,ownerId:'other'}),{status:400});
 assert.throws(()=>parseFollowupFacts({...facts,occurredAt:'2026-10-09T08:30:00'}),{status:400});
 assert.throws(()=>parseRevision({...facts,requestId:'r',expectedVersion:1,reason:'correct',conclusion:'forged'}),{status:400});
 assert.throws(()=>parseConclusion({requestId:'r',expectedVersion:1,reason:' ',conclusion:'ok'}),{status:400});
 assert.equal(parseFollowupFacts({...facts,contacted:true}).evaluationCode,null);
});
test('explicit unapproved candidate selection collapses revisions then deduplicates complaint by last qualifying call',async()=>{
 const {selectCandidateEvaluations}=await import('../src/domain/followup');
 const f=(id:string,complaintId:string,version:number,occurredAt:string,evaluationCode:'satisfied'|'dissatisfied'|null,order:number)=>({followupId:id,complaintId,version,occurredAt,evaluationCode,contacted:evaluationCode!==null,order});
 const result=selectCandidateEvaluations([f('a','C1',1,'2026-10-01T00:00:00Z',null,1),f('b','C1',1,'2026-10-02T00:00:00Z','dissatisfied',2),f('c','C1',1,'2026-10-03T00:00:00Z','satisfied',3),f('c','C1',2,'2026-10-03T00:00:00Z',null,3),f('d','C2',1,'2026-10-02T00:00:00Z','satisfied',4)]);
 assert.equal(result.policy,'candidate-unapproved');assert.deepEqual(result.records.map(r=>r.followupId),['b','d']);
 assert.equal(selectCandidateEvaluations([f('a','C1',1,'2026-10-02T00:00:00Z','satisfied',1),f('b','C1',1,'2026-10-02T00:00:00Z','dissatisfied',2)]).records[0].followupId,'b');
});
test('source evaluation is a narrow independent projection and formal policy remains unavailable',async()=>{
 const {sourceEvaluation,formalEvaluationState}=await import('../src/domain/followup');
 assert.equal(sourceEvaluation({metadata:{'坐席满意度':'满意',phone:'13800001234'}}).label,'满意');
 assert.equal(sourceEvaluation({metadata:{'坐席满意度':'满意 13800001234'}}).label,null);
 assert.equal(sourceEvaluation({satisfaction:'满意'}).label,null);
 assert.equal(JSON.stringify(sourceEvaluation({metadata:{'坐席满意度':'13800001234'}})).includes('13800001234'),false);
 assert.equal(formalEvaluationState.state,'unavailable');
});
test('C3 capabilities register owner editing separately from supervisor conclusion',async()=>{
 const {isAllowed,builtinPermissionCodes}=await import('../src/auth/rolePolicy');
 const user={id:'u',username:'u',roles:['custom'],permissionCodes:['followup.create']};
 assert.equal(isAllowed(user,'POST','/complaints/C1/followups').allowed,true);
 assert.equal(isAllowed(user,'PATCH','/followups/F1/conclusion').allowed,false);
 assert.ok(builtinPermissionCodes('handler').includes('followup.create' as any));
 assert.equal(builtinPermissionCodes('handler').includes('followup.conclude' as any),false);
});
