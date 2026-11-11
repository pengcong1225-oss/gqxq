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
 vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),cacheDir:'node_modules/.vite-source-delivery-tests',server:{middlewareMode:true,hmr:false},appType:'custom'});
 request=(await vite.ssrLoadModule('/src/api/request.ts')).default;store=(await vite.ssrLoadModule('/src/stores/appStore.ts')).useAppStore;
});
afterEach(()=>cleanup());after(async()=>{await vite.close();dom.window.close();});
function user(extra:string[]=[]){store.setState({token:'synthetic-session',userInfo:{id:'TEST-USER',username:'测试',roles:['readonly'],permissions:['complaint.read',...extra],mustChangePassword:false}});}
function response(config:any,data:any){return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};}
test('external followup opens persisted revision details and clears rows on identity change',async()=>{
 user();const Component=(await vite.ssrLoadModule('/src/components/SynchronizedFollowups.tsx')).default;
 const row={id:'f1',sourceId:'test',sourceObjectId:'test-f1',sourceVersion:2,payload:{occurredAt:'2026-11-11T08:00:00+08:00',contacted:true,evaluation:'dissatisfied',dissatisfactionReason:'合成回访原因',operatorName:'已脱敏',notes:null}};
 let current=true;
 request.defaults.adapter=async(config:any)=>response(config,config.url==='/synchronized-followups/f1'?{...row,history:[row,{...row,sourceVersion:1}]}:{content:current?[row]:[],total:current?1:0});
 const view=render(<Component complaintId="TEST-C1"/>);await waitFor(()=>assert.ok(view.getByText('合成回访原因')));
 fireEvent.click(view.getByText('查看修订明细'));await waitFor(()=>assert.ok(document.body.textContent?.includes('外部回访修订历史')));
 assert.ok(document.body.textContent?.includes('合成回访原因'));
 current=false;await act(async()=>store.setState({userInfo:{id:'OTHER',username:'其他',roles:['readonly'],permissions:['complaint.read'],mustChangePassword:false}}));
 await waitFor(()=>assert.equal(view.queryByText('合成回访原因'),null));
});
test('source process clears contacts on token-only session change and source permission revocation',async()=>{
 user(['source_document.read']);const Component=(await vite.ssrLoadModule('/src/components/SourceProcessTable.tsx')).default;
 const row={sourceSystem:'test',sourceId:'1',nodeId:'1',sourceSequence:1,sourceVersion:'1',revision:1,occurredAt:'2026-11-11T00:00:00Z',stage:'办理',department:'测试',contactName:'合成流程联系人',contactPhone:'合成电话',opinion:null,observedAt:null};
 let second=false,resolve:(value:any)=>void=()=>{};
 request.defaults.adapter=(config:any)=>second?new Promise(r=>{resolve=data=>r(response(config,data));}):Promise.resolve(response(config,{nodes:[row],revisions:[row],complete:true,state:'complete',cutoffAt:null,syncError:null,missingTimeNodeIds:[]}));
 const view=render(<Component complaintId="TEST-C1"/>);await waitFor(()=>assert.ok(view.getByText('合成流程联系人')));
 second=true;await act(async()=>store.setState({token:'synthetic-replacement-session'}));assert.equal(view.queryByText('合成流程联系人'),null);assert.equal(view.queryByText('合成电话'),null);
 await act(async()=>resolve({nodes:[row],revisions:[row],complete:true,state:'complete',cutoffAt:null,syncError:null,missingTimeNodeIds:[]}));
 await waitFor(()=>assert.ok(view.getByText('合成流程联系人')));
 await act(async()=>user());assert.equal(view.queryByText('合成流程联系人'),null);assert.equal(view.queryByText('合成电话'),null);
 await act(async()=>resolve({nodes:[],revisions:[],complete:false,state:'unavailable',cutoffAt:null,syncError:null,missingTimeNodeIds:[]}));
 await waitFor(()=>assert.ok(view.getByText('暂无已核实的来源节点')));
});
