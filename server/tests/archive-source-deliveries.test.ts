import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {parseSourceProcessDelivery,normalizeSourceProcessNode} from '../src/domain/sourceProcess';
import {verifyBusinessSource,parseBusinessEvent,classifySourceRevision} from '../src/domain/businessEvents';
import {bindFollowupTarget} from '../src/domain/businessSourceBinding';
import {sourceDeliveryConfigs} from '../src/routes/sourceDeliveries';
import {env} from '../src/config/env';
import {projectSourceEvent} from '../src/services/businessEventService';
import {projectComplaintDetail} from '../src/services/complaintProjection';
const config={sourceId:'synthetic-source',sourceSystem:'宜接就办',keyId:'test-key',secret:'synthetic-unit-only-signing-key-123456',maxSkewSeconds:60,complaintTargets:[{sourceSystem:'宜接就办',enterpriseCodes:['TEST-E1']}]};
const clock=new Date('2026-11-11T00:00:00Z');
const node={sourceSystem:'宜接就办',sourceId:'TEST-1',nodeId:'n1',sourceSequence:1,sourceVersion:'1',occurredAt:clock.toISOString(),stage:'办理',department:'测试部门',contactName:'测试联系人',contactPhone:'测试电话',opinion:null};
test('source process contract requires complete watermark, matching source, valid dates and unique nodes',()=>{
 const input={sourceSystem:'宜接就办',sourceId:'TEST-1',sourceVersion:1,complete:true,cutoffAt:clock.toISOString(),deadlineAt:null,completedAt:null,nodes:[node]};
 assert.equal(parseSourceProcessDelivery(input,'宜接就办').nodes[0].contactPhone,'测试电话');
 for(const patch of [{cutoffAt:null},{sourceSystem:'other'},{nodes:[node,node]},{deadlineAt:'2026-02-30T00:00:00Z'}])assert.throws(()=>parseSourceProcessDelivery({...input,...patch},'宜接就办'));
 assert.throws(()=>normalizeSourceProcessNode({...node,occurredAt:'2026-02-30T00:00:00Z'},'宜接就办','TEST-1'));
});
test('signatures authenticate exact bytes, timestamp, source and configured targets',()=>{
 const raw=Buffer.from('{"synthetic":true}'),timestamp=clock.toISOString(),signature=createHmac('sha256',config.secret).update(timestamp+'\n').update(raw).digest('hex'),headers={sourceId:config.sourceId,keyId:config.keyId,timestamp,signature};
 assert.equal(verifyBusinessSource(raw,headers,config,clock),true);
 assert.equal(verifyBusinessSource(Buffer.concat([raw,Buffer.from(' ')]),headers,config,clock),false);
 assert.equal(verifyBusinessSource(raw,headers,config,new Date(clock.valueOf()+61000)),false);
 const target={complaint_id:'TEST-C1',source_system:'宜接就办',source_id:'TEST-1',enterprise_code:'TEST-E1'};
 assert.equal(bindFollowupTarget(config,target).complaintId,'TEST-C1');
 assert.throws(()=>bindFollowupTarget(config,{...target,enterprise_code:'TEST-E2'}));
 assert.throws(()=>bindFollowupTarget({...config,complaintTargets:[]},target));
});
test('source configuration fails closed on duplicate identities and malformed grants',()=>{
 const old=env.businessSources;try{
  (env as any).businessSources=JSON.stringify([config]);assert.equal(sourceDeliveryConfigs().length,1);
  (env as any).businessSources=JSON.stringify([config,config]);assert.deepEqual(sourceDeliveryConfigs(),[]);
  (env as any).businessSources=JSON.stringify([{...config,complaintTargets:[{sourceSystem:'宜接就办',allEnterprises:'true'}]}]);assert.deepEqual(sourceDeliveryConfigs(),[]);
 }finally{(env as any).businessSources=old;}
});
test('followup permission masks operator and notes without losing evaluation; revision cannot replace equal version bytes',()=>{
 const event=parseBusinessEvent({sourceId:'test',kind:'followup',sourceObjectId:'test-f1',sourceVersion:1,sourceUpdatedAt:clock.toISOString(),payload:{complaintId:'TEST-C1',occurredAt:clock.toISOString(),contacted:true,evaluation:'satisfied',operatorName:'测试回访员',notes:'测试内部备注'}});
 const row={...event,id:'test',receivedAt:clock.toISOString(),payloadHash:'a',qualityReasons:[]};
 const ctx:any={access:{canReadSource:false}};const projected=projectSourceEvent(row,ctx);assert.equal((projected.payload as any).operatorName,'已脱敏');assert.equal((projected.payload as any).notes,null);assert.equal((projected.payload as any).evaluation,'satisfied');assert.equal(projectSourceEvent(row,{access:{canReadSource:true}} as any),row);
 const rev={sourceId:'test',kind:'followup' as const,sourceObjectId:'test-f1',sourceVersion:1,payloadHash:'a'};
 assert.equal(classifySourceRevision(rev,rev),'duplicate');assert.throws(()=>classifySourceRevision(rev,{...rev,payloadHash:'b'}));
});
test('authoritative process revision with null dates never revives outdated imported dates',()=>{
 const row:any={complaint_id:'TEST-C1',source_process_received_at:clock,source_deadline_at:null,source_completed_at:null,source_payload:{metadata:{'规定完成时间':'2026-11-01 08:00:00','实际完成时间':'2026-11-02 08:00:00'}}};
 const detail=projectComplaintDetail(row,{} as any);assert.equal(detail.sourceDeadlineAt,null);assert.equal(detail.sourceCompletedAt,null);
});
