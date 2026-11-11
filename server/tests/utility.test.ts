import test from 'node:test';
import assert from 'node:assert/strict';
import {validateUtilityEvent,timeoutCandidate} from '../src/domain/utility';
import {saveUtility,utilityList,pushUtility} from '../src/services/utilityService';
import type {UtilityEvent,UtilityOptions} from '../src/types/utility';
const options:UtilityOptions={enterprises:[{id:'SIM-W',name:'模拟水企',businessType:'water'}],grids:[{id:'SIM-G',name:'模拟网格',districtCode:'D'}]};
const event:UtilityEvent={id:'SIM-E',mode:'simulation',kind:'shutdown',title:'【模拟】停水',businessType:'water',enterpriseId:'SIM-W',gridIds:['SIM-G'],districtCode:'D',startsAt:'2026-11-01T00:00:00+08:00',endsAt:'2026-11-02T00:00:00+08:00',restoredAt:'2026-11-02T00:00:00+08:00',households:10,workers:1,reason:'检修',area:'模拟区域',plan:'模拟预案',housing:'模拟房屋',sourceApplicationNo:'SIM-A',approvalStatus:'approved',approvalNote:'模拟审批',approvedBy:'模拟审批人',approvedAt:'2026-10-31T00:00:00+08:00',relatedTypes:['水压问题'],revision:1,updatedAt:'2026-11-02T00:00:00+08:00'};
test('utility validates approval provenance, matching master references and temporal order',()=>{
 assert.equal(validateUtilityEvent(event,'simulation',options).title,event.title);
 for(const patch of [{approvedBy:''},{gridIds:['missing']},{gridIds:['SIM-G','SIM-G']},{businessType:'gas'},{endsAt:'2026-10-30T00:00:00+08:00'},{households:-1},{startsAt:'2026-02-30T00:00:00+08:00'}])assert.throws(()=>validateUtilityEvent({...event,...patch},'simulation',options));
 assert.throws(()=>validateUtilityEvent({...event,mode:'real'},'real',options));
});
test('timeout matches post-restoration 24h exact boundaries, types, grids and excludes future',()=>{
 const rows=[['start','2026-11-02T00:00:00+08:00'],['in','2026-11-02T00:00:01+08:00'],['end','2026-11-03T00:00:00+08:00'],['late','2026-11-03T00:00:01+08:00']].map(([id,occurredAt])=>({id,occurredAt,title:id,gridId:'SIM-G',type:'水压问题'}));
 const item=timeoutCandidate(event,[...rows,{...rows[1],id:'wrong-grid',gridId:'x'},{...rows[1],id:'wrong-type',type:'收费'}],new Date('2026-11-04T00:00:00Z'))!;
 assert.deepEqual(item.complaints.map(c=>c.id),['end','in']);
 assert.equal(timeoutCandidate({...event,approvalStatus:'pending'},rows,new Date()),null);
 assert.equal(timeoutCandidate({...event,kind:'pipeline'},rows,new Date()),null);
 assert.deepEqual(timeoutCandidate(event,rows,new Date('2026-11-02T00:00:02+08:00'))!.complaints.map(c=>c.id),['in']);
 assert.notEqual(item.id,timeoutCandidate({...event,revision:2},rows,new Date())!.id);
 assert.notEqual(item.id,timeoutCandidate(event,rows.filter(c=>c.id!=='end'),new Date())!.id);
});
test('utility operations reject missing rights and readonly writes before touching storage',async()=>{
 const ctx:any={userId:'u',permissionCodes:[],access:{roles:['readonly'],rules:[{kind:'all'}]}};
 await assert.rejects(utilityList('simulation','shutdown',ctx));
 await assert.rejects(saveUtility('simulation',undefined,{},ctx));
 await assert.rejects(pushUtility('simulation','x',{},ctx));
 await assert.rejects(saveUtility('real',undefined,{}, {...ctx,permissionCodes:['masterdata.import'],access:{roles:['admin'],rules:[{kind:'all'}]}}),/真实申请/);
});
import {isAllowed} from '../src/auth/rolePolicy';
test('utility endpoint retains forced-password gate with either read capability',()=>{
 const user:any={id:'u',username:'u',roles:['admin'],permissionCodes:['shutdown.read'],mustChangePassword:true};
 assert.equal(isAllowed(user,'GET','/utility/events').allowed,false);
 assert.equal(isAllowed({...user,mustChangePassword:false},'GET','/utility/events').allowed,true);
 assert.equal(isAllowed({...user,mustChangePassword:false,permissionCodes:['pipeline.read']},'GET','/utility/events').allowed,true);
 assert.equal(isAllowed({...user,mustChangePassword:false,permissionCodes:[]},'GET','/utility/events').allowed,false);
});
