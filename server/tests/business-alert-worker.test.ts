import test from 'node:test';
import assert from 'node:assert/strict';
import {businessAlertWorkerConfig,startBusinessAlertWorker} from '../src/services/businessAlertWorker';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('alert scheduler defaults disabled and requires explicit account and bounded interval',()=>{
 assert.equal(businessAlertWorkerConfig({}).enabled,false);
 assert.equal(businessAlertWorkerConfig({NODE_ENV:'test',GQXQ_BUSINESS_ALERT_WORKER_ENABLED:'true'}).enabled,false);
 for(const values of [{GQXQ_BUSINESS_ALERT_WORKER_ENABLED:'true'},{GQXQ_BUSINESS_ALERT_WORKER_ENABLED:'true',GQXQ_BUSINESS_ALERT_USER_ID:'u',GQXQ_BUSINESS_ALERT_INTERVAL_MS:'1'}])assert.throws(()=>businessAlertWorkerConfig(values));
 assert.deepEqual(businessAlertWorkerConfig({GQXQ_BUSINESS_ALERT_WORKER_ENABLED:'true',GQXQ_BUSINESS_ALERT_USER_ID:'service-alert'}),{enabled:true,userId:'service-alert',intervalMs:300000});
 let scheduled=false;startBusinessAlertWorker({readConfig:()=>({enabled:false,userId:'',intervalMs:300000}),evaluate:async()=>assert.fail('disabled'),schedule:()=>{scheduled=true;return {};}})();assert.equal(scheduled,false);
});
test('timer invokes shared evaluator, coalesces overlap, rereads disable and stops without external delivery',async()=>{
 let config={enabled:true,userId:'service-alert',intervalMs:60000},tick:()=>void=()=>{},calls=0,finish:(value?:unknown)=>void=()=>{},cancelled=false;
 const stop=startBusinessAlertWorker({readConfig:()=>config,evaluate:async(c,read)=>{calls++;assert.equal(c.userId,'service-alert');assert.equal(read().enabled,true);await new Promise(resolve=>{finish=resolve;});},schedule:fn=>{tick=fn;return {};},cancel:()=>{cancelled=true;}});
 assert.equal(calls,1);tick();tick();assert.equal(calls,1);finish();await settle();tick();assert.equal(calls,2);finish();await settle();
 config={...config,enabled:false};tick();await settle();assert.equal(calls,2);
 stop();assert.equal(cancelled,true);config={...config,enabled:true};tick();await settle();assert.equal(calls,2);
});
test('revoked actor rejects each timed evaluation without writing; scheduler stays available for later authorized retry',async()=>{
 let allowed=true,tick:()=>void=()=>{},attempts=0,writes=0,errors=0;
 const stop=startBusinessAlertWorker({readConfig:()=>({enabled:true,userId:'service-alert',intervalMs:60000}),evaluate:async()=>{attempts++;if(!allowed)throw Error('current permission revoked');writes++;},schedule:fn=>{tick=fn;return {};},cancel:()=>{},onError:()=>{errors++;}});
 await settle();assert.equal(writes,1);allowed=false;tick();await settle();assert.equal(attempts,2);assert.equal(writes,1);assert.equal(errors,1);stop();
});
