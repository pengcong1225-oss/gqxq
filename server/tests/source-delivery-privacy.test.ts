import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db/pool';
import {runWithAccessContext} from '../src/auth/accessScope';
import {businessEventService,projectSourceEvent} from '../src/services/businessEventService';
import {getSourceProcesses} from '../src/services/sourceProcessService';

const access={userId:'reader',roles:['handler'],scopeVersion:1,rules:[{kind:'restricted' as const,enterpriseCodes:['E1'],districtCodes:[]}],canReadSource:false};
const event={sourceId:'synthetic',kind:'followup' as const,sourceObjectId:'F1',sourceVersion:2,sourceUpdatedAt:'2026-11-11T00:00:00Z',enterpriseCode:'E1',districtCode:null,payload:{complaintId:'C1',occurredAt:null,contacted:true,evaluation:'dissatisfied' as const,dissatisfactionReason:'合成姓名及电话',operatorName:'合成回访人',notes:'合成内部记录'}};
const ctx={userId:'reader',userName:'Reader',clientIp:null,access,permissionCodes:['complaint.read'] as any};

test('external followup free text is withheld without source permission and raw facts are unchanged',()=>{
 const row={...event,id:'F1',payloadHash:'hash',receivedAt:'2026-11-11T00:00:00Z',qualityReasons:[]};
 const projected=projectSourceEvent(row,ctx);
 assert.equal(projected.payload.dissatisfactionReason,null);assert.equal(projected.payload.notes,null);assert.equal(projected.payload.operatorName,'已脱敏');
 assert.equal(projected.payload.evaluation,'dissatisfied');assert.equal(row.payload.dissatisfactionReason,'合成姓名及电话');
 assert.equal(projectSourceEvent(row,{...ctx,access:{...access,canReadSource:true}}),row);
});

test('followup head and revision history are selected in one current complaint scope snapshot',async()=>{
 const original=pool.query;let queries=0,visible=true;
 pool.query=(async(sql:string,params:unknown[])=>{
  queries++;assert.match(sql,/left join source_business_revision r on r.event_id=e.event_id/);
  assert.match(sql,/exists\(select 1 from complaint c/);assert.match(sql,/c.enterprise_code in/);assert.ok(params.includes('E1'));
  if(!visible)return [[],[]];
  return [[{event_id:'F1',content:event,payload_hash:'new',received_at:'2026-11-11T00:00:00Z',revision_content:{...event,sourceVersion:1,payload:{...event.payload,dissatisfactionReason:'历史合成姓名电话'}},revision_hash:'old',revision_received_at:'2026-11-10T00:00:00Z'}],[]];
 }) as typeof pool.query;
 try {
  const result=await businessEventService.detail('followup','F1',ctx);assert.equal(queries,1);
  assert.equal(result.payload.dissatisfactionReason,null);assert.equal(result.history[0].payload.dissatisfactionReason,null);
  visible=false;await assert.rejects(()=>businessEventService.detail('followup','F1',ctx),/来源记录不存在/);assert.equal(queries,2);
 } finally {pool.query=original;}
});

test('process current and historical opinions are withheld while authorized readers retain original text',async()=>{
 const original=pool.query;
 pool.query=(async(sql:string)=>{
  if(!sql.includes('left join source_process_stream'))return [[{complaint_id:'C1',source_system:'synthetic',source_id:'C1'}],[]];
  return [[1,2].map(revision=>({source_system:'synthetic',source_id:'C1',node_id:'N1',revision,source_sequence:1,source_version:String(revision),occurred_at:null,stage:'办理',department:'合成部门',contact_name:'合成联系人',contact_phone:'合成电话',opinion:'合成意见内姓名电话 '+revision,observed_at:null,stream_version:2,completed_cutoff_at:null,stream_state:'partial',error_code:null})),[]];
 }) as typeof pool.query;
 try {
  const hidden=await runWithAccessContext(access,()=>getSourceProcesses('C1'));
  assert.equal(hidden.nodes[0].opinion,null);assert.ok(hidden.revisions.every(r=>r.opinion===null&&r.contactPhone==='已脱敏'&&r.contactName==='已脱敏'));
  const full=await runWithAccessContext({...access,canReadSource:true},()=>getSourceProcesses('C1'));
  assert.equal(full.nodes[0].opinion,'合成意见内姓名电话 2');assert.equal(full.revisions[0].opinion,'合成意见内姓名电话 1');
 } finally {pool.query=original;}
});
