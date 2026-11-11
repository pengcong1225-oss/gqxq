import test from 'node:test';
import assert from 'node:assert/strict';
import * as service from '../src/services/heatRuleService';
import {pool} from '../src/db/pool';
import {validateConfirmation,TENDER_HEAT_POLICY_ID} from '../src/domain/heatRule';

type State={drafts:Record<string,{rule_id:string;category_key:string;edit_version:number;content:string}>;policies:Record<string,{fingerprint:string;content:string}>;confirmations:Record<string,{fingerprint:string;truth_table:string;evidence_ref:string}>;published:{version_id:string;category_key:string;effective_from:string;content:string}[];audits:unknown[][]};
function memoryDb(){
 let state:State={drafts:{},policies:{},confirmations:{},published:[],audits:[]};let work=state;let failAudit=false;
 const run=async(sql:string,args:unknown[]=[])=>{
  let rows:unknown[]=[];const a=args as any[];
  if(sql.includes(' from dict_type '))rows=[{code:'complaint_category',name:'分类',status:'enabled',version:1,published:1}];
  else if(sql.includes(' from dict_item '))rows=[{itemId:'a',typeCode:'complaint_category',code:'water',label:'供水',parentCode:null,sort:0,status:'enabled',version:1,published:1}];
  else if(sql.startsWith('select category_key from heat_rule_head'))rows=[{category_key:a[0]}];
  else if(sql.startsWith('select rule_id,category_key,edit_version,content from heat_rule_draft'))rows=work.drafts[a[0]]?[work.drafts[a[0]]]:[];
  else if(sql.startsWith('select rule_id from heat_rule_draft'))rows=Object.values(work.drafts).filter(d=>d.category_key===a[0]);
  else if(sql.startsWith('select fingerprint from heat_policy_version'))rows=work.policies[a[0]]?[work.policies[a[0]]]:[];
  else if(sql.startsWith('select fingerprint,truth_table,evidence_ref'))rows=work.confirmations[a[0]]?[work.confirmations[a[0]]]:[];
  else if(sql.startsWith('select effective_from from heat_rule_published'))rows=work.published.filter(p=>p.category_key===a[0]).sort((x,y)=>y.effective_from.localeCompare(x.effective_from)).slice(0,1);
  else if(sql.startsWith('insert ignore into heat_rule_head')){}
  else if(sql.startsWith('insert ignore into heat_policy_version'))work.policies[a[0]]??={fingerprint:a[2],content:a[3]};
  else if(sql.startsWith('insert ignore into heat_policy_confirmation'))work.confirmations[a[0]]??={fingerprint:a[2],truth_table:a[3],evidence_ref:a[4]};
  else if(sql.startsWith('insert into heat_rule_draft'))work.drafts[a[0]]={rule_id:a[0],category_key:a[1],edit_version:a[2],content:a[3]};
  else if(sql.startsWith('insert into heat_rule_published'))work.published.push({version_id:a[0],category_key:a[1],effective_from:a[2],content:a[3]});
  else if(sql.startsWith('update heat_rule_draft set edit_version=edit_version+1'))work.drafts[a[0]].edit_version++;
  else if(sql.startsWith('insert into operation_audit_log')){if(failAudit)throw Error('audit unavailable');work.audits.push(a);}
  else throw Error('unsupported SQL: '+sql);
  return [rows,[]];
 };
 const connection={query:run,execute:run,beginTransaction:async()=>{work=structuredClone(state);},commit:async()=>{state=work;},rollback:async()=>{work=state;},release:()=>{}};
 return {connection,get state(){return state;},set failAudit(v:boolean){failAudit=v;}};
}
const ctx={userId:'manager',userName:'管理员',clientIp:null,permissionCodes:['heatmap.manage'],access:{rules:[{kind:'all'}]}} as any;
const clock=()=>new Date('2026-11-10T04:00:00Z');
const input={category:{majorCode:'water',minorCode:null,dictionaryVersion:'1'},coefficients:['1','5','10','20','30'],expectedVersion:0};
const save=(raw:unknown,context=ctx)=>(service as any).saveTenderHeatRule(raw,context,clock);

test('save confirms the fixed tender algorithm and publishes in one transaction without user policy fields',async()=>{
 assert.equal(typeof (service as any).saveTenderHeatRule,'function','atomic tender save exists');
 const db=memoryDb();const original=pool.getConnection;pool.getConnection=(async()=>db.connection) as any;
 try{
  const result=await save(input);assert.equal(result.effectiveFrom,'2026-11-10');assert.equal(db.state.published.length,1);
  const frozen=JSON.parse(db.state.published[0].content);
  assert.equal(frozen.rule.policyId,TENDER_HEAT_POLICY_ID);assert.deepEqual(frozen.rule.coefficients,input.coefficients);
  assert.equal(validateConfirmation(frozen.confirmation,1,frozen.policy),true);assert.equal(db.state.audits.length,2);
  assert.equal(result.editVersion,db.state.drafts[result.ruleId].edit_version);
 }finally{pool.getConnection=original;}
});
test('concurrent edits are rejected, old frozen publication stays unchanged and later save gets a new day',async()=>{
 assert.equal(typeof (service as any).saveTenderHeatRule,'function');
 const db=memoryDb();const original=pool.getConnection;pool.getConnection=(async()=>db.connection) as any;
 try{
  const first=await save(input);const old=db.state.published[0].content;
  await assert.rejects(()=>save({...input,ruleId:first.ruleId,expectedVersion:first.editVersion-1}),/版本/);
  assert.equal(db.state.published.length,1);
  const next=await save({...input,ruleId:first.ruleId,expectedVersion:first.editVersion,coefficients:['2','6','12','24','36']});
  assert.equal(next.effectiveFrom,'2026-11-11');assert.equal(db.state.published.length,2);assert.equal(db.state.published[0].content,old);
 }finally{pool.getConnection=original;}
});
test('audit failure rolls back policy confirmation, draft and publication; unauthorized save writes nothing',async()=>{
 assert.equal(typeof (service as any).saveTenderHeatRule,'function');
 const db=memoryDb();db.failAudit=true;const original=pool.getConnection;pool.getConnection=(async()=>db.connection) as any;
 try{
  await assert.rejects(()=>save(input),/audit unavailable/);assert.equal(db.state.published.length,0);assert.deepEqual(db.state.drafts,{});assert.deepEqual(db.state.confirmations,{});
  await assert.rejects(()=>save(input,{...ctx,permissionCodes:[]}),/权限|forbidden/i);assert.equal(db.state.published.length,0);
 }finally{pool.getConnection=original;}
});
