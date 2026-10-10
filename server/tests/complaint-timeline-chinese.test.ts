import assert from 'node:assert/strict';
import {scopedTest as test} from './helpers/scopedTest';
import {pool} from '../src/db/pool';
import {getComplaintTimeline} from '../src/services/complaintService';

test('complaint timeline translates audit actions in both titles and summaries',async()=>{
 const original=pool.query;
 const operations=[
  {action:'INTAKE_CREATE',result:'success'},
  {action:'INTAKE_REDELIVERY',result:'failed'},
  {action:'CORRECTION_CONFIRM',result:'success'},
  {action:'FUTURE_OPERATION',result:'FUTURE_RESULT'},
 ].map((r,index)=>({...r,audit_id:String(index),user_id:null,biz_type:'complaint',biz_id:'C1',client_ip:null,detail:null,created_at:new Date('2026-10-10T00:00:00Z')}));
 pool.query=(async(sql:string)=>{
  if(sql.includes('from operation_audit_log'))return [operations,[]];
  if(sql.includes('from complaint_source_log')||sql.includes('from complaint_field_version'))return [[],[]];
  return [[{id:1,complaint_id:'C1'}],[]];
 }) as typeof pool.query;
 try{
  const timeline=await getComplaintTimeline('C1');
  assert.deepEqual(timeline.content.map(r=>r.action),['接收诉求','更新来源诉求','确认纠偏','其他操作']);
  assert.deepEqual(timeline.content.map(r=>r.summary),['接收诉求','更新来源诉求｜结果 失败','确认纠偏','其他操作｜结果 未知结果']);
  for(const r of operations){assert.equal(JSON.stringify(timeline).includes(r.action),false);}
  assert.equal(operations[0].action,'INTAKE_CREATE');
 }finally{pool.query=original;}
});
