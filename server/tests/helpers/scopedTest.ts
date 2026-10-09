import test from 'node:test';
import type { AccessContext } from '../../src/auth/accessScope';
// Direct-service fixtures model an explicitly authorized synthetic caller.
// HTTP/machine tests establish their actual context through the real boundary.
const access:AccessContext={userId:'synthetic-operator',roles:['handler'],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false};
export const scopedTest:typeof test=((name:string,...args:any[])=>{
 const fn=args.pop();
 return (test as any)(name,...args,async(...callbackArgs:any[])=>{
  const {runWithAccessContext}=await import('../../src/auth/accessScope');
  return runWithAccessContext(access,()=>fn(...callbackArgs));
 });
}) as typeof test;
