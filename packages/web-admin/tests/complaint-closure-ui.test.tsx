import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
let vite:ViteDevServer,dom:JSDOM,render:any,cleanup:any,waitFor:any,fireEvent:any,act:any,request:any,store:any;
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const key of ['window','document','navigator','HTMLElement','Element','SVGElement','Node','ShadowRoot','localStorage','MutationObserver'])Object.defineProperty(globalThis,key,{value:(dom.window as any)[key],configurable:true,writable:true});
 const style=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((el:Element)=>style(el)) as any;globalThis.getComputedStyle=dom.window.getComputedStyle;
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}})) as any;
 (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 ({render,cleanup,waitFor,fireEvent,act}=await import('@testing-library/react'));
 vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),cacheDir:'node_modules/.vite-closure-tests',server:{middlewareMode:true,hmr:false},appType:'custom'});
 request=(await vite.ssrLoadModule('/src/api/request.ts')).default;store=(await vite.ssrLoadModule('/src/stores/appStore.ts')).useAppStore;
});
afterEach(()=>cleanup());after(async()=>{await vite.close();dom.window.close();});
function setUser(permissions:string[]=['complaint.close'], id='CLOSURE-USER') {store.setState({token:'test-token',userInfo:{userId:id,username:'Synthetic',roles:['handler'],permissions,mustChangePassword:false}});}
function response(config:any,data:any) {return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};}
const detail={complaintId:'C1',closedInSystem:false,reportingStatusCode:'approved'};

test('closure controls honor effective permission, approval and closed state',async()=>{
 const Component=(await vite.ssrLoadModule('/src/components/ComplaintClosureConfirmation.tsx')).default;
 setUser([]);const view=render(<Component detail={detail} onSaved={()=>{}}/>);
 assert.equal(view.queryByRole('button',{name:'确认本系统办结'}),null);
 await act(async()=>setUser());view.rerender(<Component detail={{...detail,reportingStatusCode:'submitted'}} onSaved={()=>{}}/>);
 assert.equal((view.getByRole('button',{name:'确认本系统办结'}) as HTMLButtonElement).disabled,true);
 view.rerender(<Component detail={{...detail,closedInSystem:true}} onSaved={()=>{}}/>);
 assert.equal(view.queryByRole('button',{name:'确认本系统办结'}),null);
});

test('pending corrections block closure even with basis',async()=>{
 const Component=(await vite.ssrLoadModule('/src/components/ComplaintClosureConfirmation.tsx')).default;
 setUser();let writes=0;
 request.defaults.adapter=async(config:any)=>{if(config.method==='post')writes++;return response(config,[{status:'pending'}]);};
 const view=render(<Component detail={detail} onSaved={()=>{}}/>);
 fireEvent.click(view.getByRole('button',{name:'确认本系统办结'}));
 await waitFor(()=>assert.ok(document.body.textContent?.includes('仍有 1 项纠偏未处理')));
 fireEvent.change(view.getByRole('textbox',{name:'本系统办结依据'}),{target:{value:'已经检查'}});
 assert.equal((view.getByRole('button',{name:'确认办结'}) as HTMLButtonElement).disabled,true);assert.equal(writes,0);
});

test('closure requires basis, sends it once and clears confirmation after permission revocation',async()=>{
 const Component=(await vite.ssrLoadModule('/src/components/ComplaintClosureConfirmation.tsx')).default;
 setUser();const writes:any[]=[];let saved=0;
 request.defaults.adapter=async(config:any)=>{if(config.method==='post'){writes.push(config);return response(config,{closedInSystem:true});}return response(config,[{status:'confirmed'},{status:'rejected'}]);};
 const view=render(<Component detail={detail} onSaved={()=>{saved++;}}/>);
 fireEvent.click(view.getByRole('button',{name:'确认本系统办结'}));
 await waitFor(()=>assert.ok(document.body.textContent?.includes('全部纠偏项已处理')));
 const confirm=()=>view.getByRole('button',{name:'确认办结'}) as HTMLButtonElement;
 assert.equal(confirm().disabled,true);
 fireEvent.change(view.getByRole('textbox',{name:'本系统办结依据'}),{target:{value:'  已核验本轮结果  '}});
 fireEvent.click(confirm());await waitFor(()=>assert.equal(saved,1));assert.equal(writes.length,1);
 assert.equal(writes[0].url,'/complaints/C1/close');assert.deepEqual(JSON.parse(writes[0].data),{basis:'已核验本轮结果'});
 fireEvent.click(view.getByRole('button',{name:'确认本系统办结'}));
 await waitFor(()=>assert.ok(document.body.textContent?.includes('全部纠偏项已处理')));
 await act(async()=>setUser([]));
 assert.equal(view.queryByRole('textbox',{name:'本系统办结依据'}),null);assert.equal(writes.length,1);
});
