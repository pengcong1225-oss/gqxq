import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithAccessContext } from '../src/auth/accessScope';
import { pool } from '../src/db/pool';
import { closeComplaint } from '../src/services/closureService';

test('closure requires applied latest-round approval and the matching reviewed result', async () => {
  const original = {query:pool.query,getConnection:pool.getConnection};
  let finalApplied=true, assignment:string|null='NEW', result='current result', pending=0, approved=true, closed=false;
  let writes:string[]=[];
  const query=async(sql:string, params:unknown[]=[]) => {
    if(sql.startsWith('select id, complaint_id')) return [[{id:1,complaint_id:'C'}],[]];
    if(sql.startsWith('select enterprise_code')) return [[{enterprise_code:'E',district_code:'D',deleted:0}],[]];
    if(sql.startsWith('select complaint_no')) return [[{complaint_no:'C',reporting_status:approved?'approved':'submitted',closed_in_system:closed?1:0}],[]];
    if(sql.includes('count(*)')) return [[{total:pending}],[]];
    if(sql.startsWith('select assignment_id from dispatch_order')) return [[{assignment_id:'NEW'}],[]];
    if(sql.includes('from approval_trace')) { assert.deepEqual(params,['C','NEW']); return [finalApplied?[{eventId:'LATEST-APPROVAL'}]:[],[]]; }
    if(sql.includes('straight_join business_event')) {
      assert.match(sql,/e\.processed_result = 'applied'/); assert.match(sql,/d\.status in \('completed', 'archived'\)/);
      assert.deepEqual(params.slice(0,3),['NEW','C','LATEST-APPROVAL']);
      return [[{eventId:'LATEST-APPROVAL',payload:{enterpriseDisposalResult:'current result'}}],[]];
    }
    if(sql.includes("field_name = 'disposal_result'")) return [[{assignment_id:assignment,old_value:result}],[]];
    throw Error('unexpected query '+sql);
  };
  const execute=async(sql:string) => {writes.push(sql);return [{affectedRows:1},[]];};
  Object.assign(pool,{query,getConnection:async()=>({query,execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}})});
  const access={userId:'operator',roles:['handler'],scopeVersion:1,rules:[{kind:'all' as const}],canReadSource:false};
  const close=()=>runWithAccessContext(access,()=>closeComplaint('C',{basis:'核验最新交办及处置结果'},{userId:'operator',userName:'Operator',clientIp:null}));
  try {
    finalApplied=false; await assert.rejects(close,/最新交办/); assert.equal(writes.length,0);
    finalApplied=true; assignment='OLD'; await assert.rejects(close,/本轮处置结果/); assert.equal(writes.length,0);
    assignment='NEW'; result='old result'; await assert.rejects(close,/本轮处置结果/); assert.equal(writes.length,0);
    result='current result'; pending=1; await assert.rejects(close,/待纠偏/); assert.equal(writes.length,0);
    pending=0; approved=false; await assert.rejects(close,/最终审批通过/); assert.equal(writes.length,0);
    approved=true; closed=true; await assert.rejects(close,/不能重复办结/); assert.equal(writes.length,0);
    closed=false;
    await assert.rejects(()=>runWithAccessContext({...access,rules:[]},()=>closeComplaint('C',{basis:'test'},{userId:'operator',clientIp:null})),/不在授权范围/);
    assert.equal(writes.length,0);
    const outcome=await close(); assert.equal(outcome.closedInSystem,true);
    assert.equal(writes.length,2); assert.match(writes[0],/closed_in_system = 1/); assert.doesNotMatch(writes[0],/source_event_status/);
    assert.match(writes[1],/operation_audit_log/);
  } finally { Object.assign(pool,original); }
});
