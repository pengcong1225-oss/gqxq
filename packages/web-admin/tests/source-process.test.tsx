const boundedPause=(setRelease:(release:()=>void)=>void)=>{let timer:ReturnType<typeof setTimeout>;return new Promise<void>(resolve=>{setRelease(resolve);timer=setTimeout(resolve,15000);timer.unref();}).finally(()=>clearTimeout(timer));};
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import React from 'react';
import {JSDOM} from 'jsdom';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
let vite:ViteDevServer,dom:JSDOM;
const originalChannel=globalThis.MessageChannel;const channels:MessageChannel[]=[];
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}} as any;
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Document:dom.window.Document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,localStorage:dom.window.localStorage,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
 const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((element:Element)=>computed(element)) as any;Object.defineProperty(globalThis,'getComputedStyle',{value:dom.window.getComputedStyle,configurable:true});
 Object.defineProperty(globalThis,'MessageChannel',{value:class extends originalChannel{constructor(){super();channels.push(this);}},configurable:true,writable:true});
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-source-process-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();for(const channel of channels){channel.port1.close();channel.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalChannel,configurable:true,writable:true});});
async function component(){let page:any;try{page=(await vite.ssrLoadModule('/src/components/SourceProcessTable.tsx')).default;}catch{}assert.equal(typeof page,'function','source process UI component is absent');return page;}
const node={sourceSystem:'synthetic',sourceId:'S1',nodeId:'N1',sourceSequence:1,sourceVersion:'v1',revision:1,occurredAt:null,stage:'办理',department:null,contactName:null,opinion:'第一行\n第二行'+ '长文'.repeat(1000),observedAt:'2026-10-09T00:00:00Z'};
test('source panel hides revoked capability and never calls process endpoint',async()=>{
 const Page=await component();const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['admin'],permissions:[],mustChangePassword:false}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let calls=0;client.defaults.adapter=async()=>{calls++;throw Error('must not fetch');};
 const {render,within,cleanup}=await import('@testing-library/react');const ui=render(<Page complaintId="C1"/>);
 try{assert.equal(within(ui.container).queryByRole('button',{name:'查看来源全过程'}),null);assert.equal(calls,0);}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
for(const state of ['unavailable','partial','error','complete'] as const)test('source panel renders '+state+' truthfully, with long multiline and missing fields',async()=>{
 const Page=await component();const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['complaint.read'],mustChangePassword:false}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;
 client.defaults.adapter=async(config:any)=>({data:{code:200,data:{complaintId:'C1',nodes:state==='unavailable'?[]:[node],revisions:state==='unavailable'?[]:[node],state,complete:state==='complete',cutoffAt:state==='complete'?'2026-10-08T00:00:00Z':null,syncError:state==='error'?'安全同步异常':state==='unavailable'?'来源契约未就绪':null,missingTimeNodeIds:state==='unavailable'?[]:['N1']}},status:200,statusText:'OK',headers:{},config});
 const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<Page complaintId="C1"/>);
 try{fireEvent.click(within(ui.container).getByRole('button',{name:'查看来源全过程'}));await waitFor(()=>assert.match(ui.container.textContent??'',new RegExp({unavailable:'尚未接入',partial:'尚未完整',error:'安全同步异常',complete:'完整批次'}[state])));
  if(state!=='unavailable'){const text=within(ui.container).getByText(node.opinion,{exact:true,normalizer:s=>s});assert.equal(text.textContent,node.opinion);assert.equal((text as HTMLElement).style.whiteSpace,'pre-wrap');assert.match(ui.container.textContent??'',/来源时间缺失/);}
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('source API failure is visible and stale response cannot survive a complaint change',async()=>{
 const Page=await component();const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['complaint.read'],mustChangePassword:false}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let release!:(v:any)=>void;
 client.defaults.adapter=(config:any)=>new Promise(resolve=>{release=()=>resolve({data:{code:200,data:{complaintId:'C1',nodes:[node],revisions:[node],state:'complete',complete:true,cutoffAt:null,syncError:null,missingTimeNodeIds:[]}},status:200,statusText:'OK',headers:{},config});});
 const {render,within,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react');const ui=render(<Page complaintId="C1"/>);
 try{fireEvent.click(within(ui.container).getByRole('button',{name:'查看来源全过程'}));await waitFor(()=>assert.ok(release));ui.rerender(<Page complaintId="C2"/>);await act(async()=>release(null));assert.equal(ui.container.textContent?.includes(node.opinion),false);
  client.defaults.adapter=async()=>{throw Error('HTTP failed');};fireEvent.click(within(ui.container).getByRole('button',{name:'查看来源全过程'}));await waitFor(()=>assert.match(ui.container.textContent??'',/请求失败，请稍后重试/));
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('detail distinguishes original/effective address, null source dates and local timeline',async()=>{
 const {MemoryRouter,Routes,Route}=await import('react-router-dom');const {default:Page}=await vite.ssrLoadModule('/src/views/ComplaintDetail.tsx');
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['complaint.read'],mustChangePassword:false}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;
 client.defaults.adapter=async(config:any)=>({data:{code:200,data:config.url==='/complaints/C1'?{complaintId:'C1',complaintNo:'C1',title:'Synthetic',sourceAddress:'原地址A',effectiveAddress:'人工地址B',address:'人工地址B',sourceFieldReasons:{sourceDeadlineAt:'无可信来源期限',sourceCompletedAt:'无可信来源办结'},sourceDeadlineAt:null,sourceCompletedAt:null,sourceSnapshotAt:'2026-10-09T00:00:00Z',businessTimeSource:'platform_received_at',receivedAt:'2026-10-09T00:00:00Z',locationClues:[],locationConflict:false,content:'正文第一行\n正文第二行'}:config.url==='/source-status'?{enabled:false,message:'disabled'}:config.url.endsWith('/followups')?{sourceEvaluation:{label:null,reason:'fixture unavailable',provenance:'unavailable'},formalEvaluation:{reason:'policy pending'},records:[],history:[]}:{content:[],total:0}},status:200,statusText:'OK',headers:{},config});
 const {render,within,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/complaints/C1']}><Routes><Route path="/complaints/:id" element={<Page/>}/></Routes></MemoryRouter>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('原地址A')));assert.ok(within(ui.container).getByText('无可信来源期限'));assert.ok(within(ui.container).getByText('无可信来源办结'));assert.match(ui.container.textContent??'',/业务时间回落系统接收时间/);assert.ok(within(ui.container).getByText('本平台处理记录'));const content=within(ui.container).getByText('正文第一行\n正文第二行',{normalizer:s=>s});assert.equal((content as HTMLElement).style.whiteSpace,'pre-wrap');
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('saved node revisions expand without hiding prior opinion and revoked access removes loaded data',async()=>{
 const Page=await component();const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const user={roles:['custom'],permissions:['complaint.read'],mustChangePassword:false};useAppStore.setState({userInfo:user});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const old={...node,opinion:'OLD source opinion'};const current={...node,opinion:'NEW source opinion',sourceVersion:'v2',revision:2};
 client.defaults.adapter=async(config:any)=>({data:{code:200,data:{complaintId:'C1',nodes:[current],revisions:[old,current],state:'complete',complete:true,cutoffAt:null,syncError:null,missingTimeNodeIds:['N1']}},status:200,statusText:'OK',headers:{},config});
 const {render,within,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react');const ui=render(<Page complaintId="C1"/>);
 try{fireEvent.click(within(ui.container).getByRole('button',{name:'查看来源全过程'}));await waitFor(()=>assert.ok(within(ui.container).getByText('NEW source opinion')));fireEvent.click(within(ui.container).getByRole('button',{name:/expand/i}));assert.ok(within(ui.container).getByText('OLD source opinion'));
  await act(async()=>useAppStore.setState({userInfo:{...user,permissions:[]}}));assert.equal(ui.container.textContent?.includes('source opinion'),false);assert.equal(within(ui.container).queryByRole('button',{name:'查看来源全过程'}),null);
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});

test('source document modal clears and fences pending bytes on same-capability focus refresh',async()=>{
 const {MemoryRouter}=await import('react-router-dom');const {default:App}=await vite.ssrLoadModule('/src/App.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const user={userId:'u',username:'u',roles:['custom'],permissions:['complaint.read','source_document.read'],mustChangePassword:false,authorizationVersion:1};useAppStore.setState({token:'synthetic',userInfo:user});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let authVersion=1,delay=false,release:(()=>void)|undefined;
 client.defaults.adapter=async(config:any)=>{let data:any=config.url==='/auth/user-info'?{...user,authorizationVersion:authVersion}:config.url==='/complaints/C1'?{complaintId:'C1',complaintNo:'C1',title:'Synthetic',locationClues:[],locationConflict:false,content:'safe current detail'}:config.url==='/source-status'?{enabled:false,message:'disabled'}:config.url.endsWith('/followups')?{sourceEvaluation:{label:null,reason:'fixture unavailable',provenance:'unavailable'},formalEvaluation:{reason:'policy pending'},records:[],history:[]}:{content:[],total:0};
  if(config.url.endsWith('/followups'))data={sourceEvaluation:{label:null,reason:'fixture unavailable',provenance:'unavailable'},formalEvaluation:{reason:'policy pending'},records:[],history:[]};
  if(config.url.includes('/source-document')){data={complaintId:'C1',sourcePayload:{marker:'RAW_OLD_SCOPE'}};if(delay){delay=false;await boundedPause(r=>release=r);}}
  return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react');const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/complaints/C1']}><App/></MemoryRouter>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByRole('button',{name:'查看来源原件'})));fireEvent.click(within(ui.container).getByRole('button',{name:'查看来源原件'}));await waitFor(()=>assert.match(document.body.textContent??'',/RAW_OLD_SCOPE/));
  authVersion=2;await act(async()=>window.dispatchEvent(new window.Event('focus')));await waitFor(()=>assert.equal(useAppStore.getState().userInfo.authorizationVersion,2));await waitFor(()=>assert.equal(document.body.textContent?.includes('RAW_OLD_SCOPE'),false));
  delay=true;fireEvent.click(within(ui.container).getByRole('button',{name:'查看来源原件'}));await waitFor(()=>assert.ok(release));authVersion=3;await act(async()=>window.dispatchEvent(new window.Event('focus')));await waitFor(()=>assert.equal(useAppStore.getState().userInfo.authorizationVersion,3));await act(async()=>release!());assert.equal(document.body.textContent?.includes('RAW_OLD_SCOPE'),false);
 }finally{release?.();ui.unmount();cleanup();client.defaults.adapter=original;}
});
