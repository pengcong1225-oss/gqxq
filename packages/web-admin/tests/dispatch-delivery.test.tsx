import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import React from 'react';
import {JSDOM} from 'jsdom';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
let vite:ViteDevServer,dom:JSDOM;const originalChannel=globalThis.MessageChannel;const channels:MessageChannel[]=[];
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}} as any;
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Document:dom.window.Document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,localStorage:dom.window.localStorage,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((element:Element)=>computed(element)) as any;Object.defineProperty(globalThis,'getComputedStyle',{value:dom.window.getComputedStyle,configurable:true});
 Object.defineProperty(globalThis,'MessageChannel',{value:class extends originalChannel{constructor(){super();channels.push(this);}},configurable:true,writable:true});
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-dispatch-delivery-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();for(const c of channels){c.port1.close();c.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalChannel,configurable:true,writable:true});});
for(const [state,label] of [['pending','已排队'],['sending','发送中'],['unknown','结果未知 · 需人工核验'],['succeeded','已确认创建'],['failed','失败／已停止']] as const)test('actual DispatchOrders persists '+state+' state after reload',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/DispatchOrders.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['dispatch.read','dispatch.push'],mustChangePassword:false}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let sends=0;
 const order={id:1,assignmentId:'A',orderNo:'A',complaintId:'C',complaintTitle:'Synthetic',status:'pending',statusName:'待推送',deliveryState:state,deliveryAttempts:1,deliveryRetryAllowed:false,sensitiveWords:[],createdAt:null};
 client.defaults.adapter=async(config:any)=>{if(config.method==='post')sends++;return {data:{code:200,data:config.url==='/dispatch/orders'?{content:[order],total:1,page:1,size:20}:config.url==='/dispatch/orders/A'?order:config.url.endsWith('/reporting-result')?{events:[],taskUrl:null}:config.url.startsWith('/dicts')?[]:{content:[],total:0}},status:200,statusText:'OK',headers:{},config};};
 const {MemoryRouter}=await import('react-router-dom');const {render,within,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/dispatch?assignmentId=A']}><Page/></MemoryRouter>);
 try{await waitFor(()=>assert.match(document.body.textContent??'',new RegExp(label)));const buttons=within(ui.container).queryAllByTestId('dispatch-push-A');if(['pending','sending','unknown','succeeded','failed'].includes(state))assert.ok(buttons.every(b=>(b as HTMLButtonElement).disabled));assert.equal(sends,0);assert.equal(document.body.textContent?.includes('修改报文'),false);}
 finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('revoked push permission hides actionable sends on actual page',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/DispatchOrders.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['admin'],permissions:['dispatch.read'],mustChangePassword:false}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let writes=0;client.defaults.adapter=async(config:any)=>{if(config.method==='post')writes++;return {data:{code:200,data:config.url==='/dispatch/orders'?{content:[{assignmentId:'A',orderNo:'A',status:'pending',statusName:'待推送',sensitiveWords:[]}],total:1}:config.url.endsWith('/reporting-result')?{events:[],taskUrl:null}:config.url.startsWith('/dicts')?[]:config.url==='/dispatch/orders/A'?{assignmentId:'A',status:'pending',sensitiveWords:[]}:{content:[],total:0}},status:200,statusText:'OK',headers:{},config};};
 const {MemoryRouter}=await import('react-router-dom');const {render,within,waitFor,cleanup}=await import('@testing-library/react');const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/dispatch?assignmentId=A']}><Page/></MemoryRouter>);
 try{await waitFor(()=>assert.ok(within(ui.container).queryAllByTestId('dispatch-push-A').length));assert.ok(within(ui.container).queryAllByTestId('dispatch-push-A').every(b=>(b as HTMLButtonElement).disabled));assert.equal(writes,0);}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
