import {env} from '../config/env';
import {pool} from '../db/pool';
import {findAuthIdentity} from '../repositories/userRepo';
import {resolveAuthorizationFrom} from '../repositories/roleRepo';
import {resolveAccessContext} from '../auth/accessScope';
import {recomputeShutdownLinks,listShutdownLinks,sendShutdownFeedback,reconcileShutdownFeedback} from './businessFeedbackService';
import {evaluateBusinessAlerts} from './businessAlertService';
import {shanghaiToday} from '../domain/statisticsQuery';
import type {BusinessEventContext} from '../types/businessEvents';
/** The operator is an explicitly configured, current internal identity. No implicit system/admin grants. */
export async function runBusinessFeatureCycle(userId:string){
 if(!userId)return {state:'disabled'};
 const identity=await findAuthIdentity(pool,userId);if(!identity||identity.status!==1||identity.mustChangePassword||identity.accountType!=='internal')return {state:'identity_unavailable'};
 const auth=await resolveAuthorizationFrom(pool,userId);if(auth.roleCodes.includes('readonly'))return {state:'readonly'};
 const ctx:BusinessEventContext={userId,userName:identity.username,clientIp:null,permissionCodes:auth.permissionCodes,access:await resolveAccessContext(userId,auth)};
 if(auth.permissionCodes.includes('shutdown.feedback.manage')&&auth.permissionCodes.includes('shutdown.read')&&auth.permissionCodes.includes('complaint.read')){
  await recomputeShutdownLinks(ctx);
  if(env.shutdownFeedback.url&&env.shutdownFeedback.secret.length>=32){const links=await listShutdownLinks(ctx);for(const link of links){if(link.feedbackState==='pending')await sendShutdownFeedback(String(link.linkId),ctx);else if(link.feedbackState==='uncertain'&&env.shutdownFeedback.statusUrl)await reconcileShutdownFeedback(String(link.linkId),ctx);}}
 }
 if(['alert.handle','alert.read','statistics.read','dashboard.read'].every(p=>auth.permissionCodes.includes(p as typeof auth.permissionCodes[number])))await evaluateBusinessAlerts(shanghaiToday(),ctx);
 return {state:'completed'};
}
export function startBusinessFeatureWorker():()=>void {
 if(!env.businessWorkerUserId)return ()=>{};
 let busy=false,stopped=false;
 const cycle=async()=>{if(busy||stopped)return;busy=true;try{const result=await runBusinessFeatureCycle(env.businessWorkerUserId);if(result.state!=='completed')console.warn('[business-features] worker identity unavailable; no implicit grants');}catch{console.error('[business-features] cycle failed; durable evidence and uncertain sends retained');}finally{busy=false;}};
 const timer=setInterval(()=>void cycle(),60000);timer.unref();void cycle();return()=>{stopped=true;clearInterval(timer);};
}
