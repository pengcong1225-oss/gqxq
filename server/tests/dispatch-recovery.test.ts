import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DOTENV_CONFIG_PATH='nonexistent-c4-test.env';
Object.assign(process.env,{GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'1',GQXQ_DB_USER:'synthetic',GQXQ_DB_NAME:'synthetic',GQXQ_JWT_SECRET:'synthetic-c4',GQXQ_PU_BASE_URL:'http://127.0.0.1:1',GQXQ_PU_KEY_ID:'synthetic',GQXQ_PU_SECRET:'synthetic'});

test('accepted response without task id is unknown, never a proved permanent rejection',async()=>{
 const {classifyOutcome}=await import('../src/services/dispatchPushService');
 const result=classifyOutcome({kind:'response',httpStatus:200,bodyText:'{"created":false}'});
 assert.equal(result.result,'unknown');
 assert.equal(result.retryable,false);
});
test('malformed task identifiers cannot falsely confirm a created task',async()=>{
 const {classifyOutcome}=await import('../src/services/dispatchPushService');
 for(const id of [{forged:true},[],9007199254740992,'   '])assert.equal(classifyOutcome({kind:'response',httpStatus:200,bodyText:JSON.stringify({created:true,task:{id}})}).result,'unknown');
});
test('unconfirmed request lookup is typed unsupported and never invokes HTTP',async()=>{
 const {dispatchRecoveryTransport}=await import('../src/clients/publicUtilityClient');const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no request lookup route');};
 try{assert.deepEqual(await dispatchRecoveryTransport.queryByRequestId('R'),{kind:'unsupported'});assert.equal(calls,0);}finally{globalThis.fetch=original;}
});
test('transport identity freezes target and capability version but allows signing key rotation',async()=>{
 const {currentTransportIdentity}=await import('../src/clients/publicUtilityClient');const {env}=await import('../src/config/env');const before=currentTransportIdentity();const original={secret:env.pu.secret,keyId:env.pu.keyId,baseUrl:env.pu.baseUrl,recoveryMode:env.pu.recoveryMode,recoveryContractVersion:env.pu.recoveryContractVersion};
 try{Object.assign(env.pu,{keyId:'rotated',secret:'rotated'});assert.equal(currentTransportIdentity(),before);env.pu.baseUrl='http://127.0.0.1:2/context';assert.notEqual(currentTransportIdentity(),before);Object.assign(env.pu,{...original,recoveryMode:'same-body-idempotent',recoveryContractVersion:'synthetic'});assert.notEqual(currentTransportIdentity(),before);}finally{Object.assign(env.pu,original);}
});
