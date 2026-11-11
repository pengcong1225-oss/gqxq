import {withTransaction} from '../db/tx';
import {AppError} from '../http/errors';
import {shanghaiToday} from '../domain/statisticsQuery';
import {currentFeatureActor,featurePermission} from './businessFeatureAuth';
import {evaluateBusinessAlertsIn} from './businessAlertService';
import type {BusinessEventContext} from '../types/businessEvents';
export interface BusinessAlertWorkerConfig {enabled:boolean;userId:string;intervalMs:number}
export function businessAlertWorkerConfig(env:NodeJS.ProcessEnv=process.env):BusinessAlertWorkerConfig {
 const intervalMs=Number(env.GQXQ_BUSINESS_ALERT_INTERVAL_MS??300000),userId=(env.GQXQ_BUSINESS_ALERT_USER_ID??'').trim();
 const enabled=env.NODE_ENV!=='test'&&env.GQXQ_BUSINESS_ALERT_WORKER_ENABLED==='true';
 if(enabled&&(!/^[A-Za-z0-9_.:-]{1,64}$/.test(userId)||!Number.isSafeInteger(intervalMs)||intervalMs<60000||intervalMs>86400000))throw AppError.validation('预警定时配置无效：需要服务账号及60000至86400000毫秒间隔');
 return {enabled,userId,intervalMs};
}
/** Re-resolve the named account under the authorization lock every time. This is
 * deliberately NOT runAsTrustedSystem and never creates an all-scope context. */
export async function evaluateScheduledBusinessAlerts(config:BusinessAlertWorkerConfig,readConfig:()=>BusinessAlertWorkerConfig=businessAlertWorkerConfig){
 if(!config.enabled)return;
 return withTransaction(async tx=>{
  const ctx:BusinessEventContext={userId:config.userId,permissionCodes:[],access:{userId:config.userId,roles:[],scopeVersion:0,rules:[],canReadSource:false}};
  const actor=await currentFeatureActor(tx,ctx,'alert.handle',true);
  for(const permission of ['alert.read','statistics.read','dashboard.read'])featurePermission(actor,permission,true);
  const assertActive=()=>{const latest=readConfig();if(!latest.enabled||latest.userId!==config.userId)throw AppError.forbidden('预警定时配置已停用或服务账号已变化');};
  assertActive();return evaluateBusinessAlertsIn(tx,shanghaiToday(),actor,assertActive);
 });
}
interface WorkerDependencies {
 readConfig?:()=>BusinessAlertWorkerConfig;
 evaluate?:(config:BusinessAlertWorkerConfig,readConfig:()=>BusinessAlertWorkerConfig)=>Promise<unknown>;
 schedule?:(callback:()=>void,intervalMs:number)=>{unref?:()=>void};
 cancel?:(timer:unknown)=>void;
 onError?:(error:unknown)=>void;
}
/** One in-flight evaluation per process; stable alert keys provide DB idempotency.
 * Disabled by default. Account revoke/disable is checked again in every transaction. */
export function startBusinessAlertWorker(deps:WorkerDependencies={}){
 if(process.env.NODE_ENV==='test'&&!deps.evaluate)return ()=>{};
 const readConfig=deps.readConfig??businessAlertWorkerConfig;
 const evaluate=deps.evaluate??evaluateScheduledBusinessAlerts;
 const onError=deps.onError??(()=>console.error('[business-alert] evaluation rejected or failed; no external messages sent'));
 let config:BusinessAlertWorkerConfig;
 try{config=readConfig();}catch(error){onError(error);return ()=>{};}
 if(!config.enabled)return ()=>{};
 let stopped=false,running=false;
 const tick=async()=>{if(stopped||running)return;running=true;try{const current=readConfig();if(current.enabled)await evaluate(current,()=>stopped?{...readConfig(),enabled:false}:readConfig());}catch(error){onError(error);}finally{running=false;}};
 const schedule=deps.schedule??((callback,interval)=>setInterval(callback,interval));
 const timer=schedule(()=>void tick(),config.intervalMs);timer.unref?.();void tick();
 return ()=>{stopped=true;(deps.cancel??(timer=>clearInterval(timer as ReturnType<typeof setInterval>)))(timer);};
}
