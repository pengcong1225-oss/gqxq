import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createApp} from '../src/app';
import {isAllowed,matchRule} from '../src/auth/rolePolicy';
import {pool} from '../src/db/pool';
import {errorHandler} from '../src/middleware/errorHandler';
import {businessFeaturesRouter} from '../src/routes/businessFeatures';

const path='/business-alerts/rules';
const subject=(roles:string[],permissionCodes:string[])=>({id:'u',username:'test',roles,permissionCodes});
const reader=subject(['readonly'],['alert.read','alert.handle','statistics.read','dashboard.read']);
const manager=subject(['admin'],['alert.read','alert.handle','statistics.read','dashboard.read','business.rules.manage']);
const published={ruleId:'three-piece',name:'燃气三件套安装',kind:'alert',scene:'gas_three_piece',businessType:'gas',
  windowDays:7,threshold:133,majorCodes:[],minorCodes:['g01','g02','g04','g05'],dictionaryVersion:'20',
  effectiveFrom:'2020-01-01',effectiveTo:'2099-12-31',enabled:true,definitionBasis:'internal-baseline-evidence'};

function appFor(user=reader,whole=false){
  const app=express();
  app.use((req,_res,next)=>{
    req.user=user;
    req.accessContext={userId:user.id,roles:user.roles,scopeVersion:1,canReadSource:false,
      rules:whole?[{kind:'all'}]:[{kind:'restricted',districtCodes:['D1'],enterpriseCodes:[]}]};
    next();
  });
  app.use(businessFeaturesRouter,errorHandler);
  return app;
}

test('published rule settings use alert.read without enabling writes or reading the manager route',async()=>{
  assert.equal((await request(createApp()).get('/api/v1'+path)).status,401);
  assert.equal(matchRule('GET',path)?.permissionCode,'alert.read');
  assert.equal(isAllowed(reader,'GET',path).allowed,true);
  assert.equal(isAllowed(reader,'GET','/business-rules').allowed,false);
  assert.equal(isAllowed(reader,'POST','/business-alerts/evaluate').allowed,false);
  assert.equal(isAllowed(manager,'POST',path).allowed,false);
  assert.equal((await request(appFor(subject(['handler'],[]))).get(path)).status,403);
});

test('readonly responses list latest published settings and omit internal fields and draft metadata',async()=>{
  const original=pool.getConnection;
  const sqls:string[]=[];
  pool.getConnection=(async()=>({
    beginTransaction:async()=>{},rollback:async()=>{},commit:async()=>{},release:()=>{},
    execute:async()=>assert.fail('reading rule settings must not write'),
    query:async(sql:string,params:unknown[])=>{
      sqls.push(sql);
      assert.match(sql,/max\(version\).*from business_rule_version/);
      assert.deepEqual(params,['alert']);
      return [[{content:JSON.stringify(published),version:3},
        {content:{...published,ruleId:'planned-gas',scene:'planned_shutdown',enabled:false},version:4},
        {content:{...published,ruleId:'winter-expired',scene:'winter',effectiveTo:'2020-12-31'},version:5}],[]];
    },
  })) as unknown as typeof pool.getConnection;
  try{
    const res=await request(appFor()).get(path);
    assert.equal(res.status,200);
    assert.deepEqual(res.body.data.rules.map((rule:Record<string,unknown>)=>[rule.scene,rule.state]),[
      ['gas_three_piece','enabled'],['planned_shutdown','disabled'],['winter','out_of_effect'],
    ]);
    assert.deepEqual(res.body.data.rules[0],{
      ruleId:'three-piece',name:'燃气三件套安装',scene:'gas_three_piece',businessType:'gas',
      ruleVersion:3,windowDays:7,threshold:133,majorCodes:[],minorCodes:['g01','g02','g04','g05'],
      dictionaryVersion:'20',scope:'city',effectiveFrom:'2020-01-01',effectiveTo:'2099-12-31',state:'enabled',
    });
    assert.equal(res.body.data.draftScenes,null);
    assert.equal(res.body.data.canEvaluate,false);
    assert.equal(sqls.length,1);
  }finally{pool.getConnection=original;}
});

test('a rule manager sees pending draft scenes without ever substituting draft configuration',async()=>{
  const original=pool.getConnection;
  pool.getConnection=(async()=>({
    beginTransaction:async()=>{},rollback:async()=>{},commit:async()=>{},release:()=>{},
    execute:async()=>assert.fail('reading rule settings must not write'),
    query:async(sql:string)=>{
      if(sql.includes('from business_rule_version'))return [[{content:published,version:3},
        {content:{...published,ruleId:'summer',scene:'summer'},version:4}],[]];
      assert.match(sql,/from business_rule /);
      return [[{rule_id:'three-piece',edit_version:5,scene:'gas_three_piece'},
        {rule_id:'winter',edit_version:1,scene:'winter'},
        {rule_id:'summer',edit_version:5,scene:'summer'}],[]];
    },
  })) as unknown as typeof pool.getConnection;
  try{
    const res=await request(appFor(manager,true)).get(path);
    assert.equal(res.status,200);
    assert.deepEqual(res.body.data.draftScenes,['gas_three_piece','winter']);
    assert.equal(res.body.data.rules.find((rule:Record<string,unknown>)=>rule.ruleId==='three-piece').threshold,133);
    assert.equal(res.body.data.rules.some((rule:Record<string,unknown>)=>rule.scene==='winter'),false);
    assert.equal(res.body.data.canEvaluate,true);
    const restricted=await request(appFor(manager,false)).get(path);
    assert.equal(restricted.body.data.draftScenes,null);
  }finally{pool.getConnection=original;}
});

test('planned alert details return the frozen application and work-order link only with both grants', async () => {
  const original = pool.getConnection;
  const link = { complaintId: 'C1', eventId: 'E1', sourceApplicationNo: 'APP-1', sourceRevision: 'r4', eventRevision: 2 };
  pool.getConnection = (async () => ({
    beginTransaction: async () => {}, rollback: async () => {}, commit: async () => {}, release: () => {},
    execute: async () => assert.fail('reading alerts must not write'),
    query: async (sql: string) => sql.includes('from business_alert a') ? [[{
      alert_id: 'A1', rule_id: 'planned-water', rule_version: 3,
      window_from: new Date('2026-11-09T00:00:00Z'), window_to: new Date('2026-11-11T00:00:00Z'),
      quantity: 1, threshold_value: 1, state: 'open', evidence: {
        scope: 'city', scene: 'planned_shutdown', complaintIds: ['C1'], utilityEvidence: [link],
      },
    }], []] : [[{ complaint_id: 'C1' }], []],
  })) as unknown as typeof pool.getConnection;
  try {
    const fetch = (grants: string[]) => request(appFor(subject(['handler'], ['alert.read', ...grants]), true))
      .get('/business-alerts').expect(200);
    const full = await fetch(['complaint.read', 'shutdown.read']);
    assert.deepEqual(full.body.data[0].utilityEvidence, [link]);
    for (const grants of [['complaint.read'], ['shutdown.read']]) {
      const masked = await fetch(grants);
      assert.equal(masked.body.data[0].utilityEvidence, null);
    }
  } finally {
    pool.getConnection = original;
  }
});
