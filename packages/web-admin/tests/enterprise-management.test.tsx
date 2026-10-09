import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import React from 'react';
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;
import {JSDOM} from 'jsdom';
import {createServer, type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
const storage = new Map<string,string>();
globalThis.localStorage = {getItem:k=>storage.get(k)??null,setItem:(k,v)=>{storage.set(k,v);},removeItem:k=>{storage.delete(k);}} as Storage;
let vite:ViteDevServer;
let dom:JSDOM;
const originalMessageChannel=globalThis.MessageChannel;
const browserChannels:MessageChannel[]=[];
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
  Document:dom.window.Document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,
  Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true,
  ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}})) Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
 const computed=dom.window.getComputedStyle.bind(dom.window);
 dom.window.getComputedStyle=((element:Element)=>computed(element)) as any;
 Object.defineProperty(globalThis,'getComputedStyle',{value:dom.window.getComputedStyle,configurable:true});
 // rc-overflow creates browser channels without closing them; Node's ports keep
 // the test process alive. Preserve channel behavior and close fixture resources.
 Object.defineProperty(globalThis,'MessageChannel',{value:class extends originalMessageChannel {constructor(){super();browserChannels.push(this);}},configurable:true,writable:true});
 ({MemoryRouter}=await import('react-router-dom'));
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-enterprise-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();for(const channel of browserChannels){channel.port1.close();channel.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalMessageChannel,configurable:true,writable:true});});

test('enterprise page reads real server data and hides management without effective capability',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/CompanyList.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];
 useAppStore.setState({userInfo:{userId:'u',roles:['custom'],permissions:['enterprise.read'],mustChangePassword:false}});
 client.defaults.adapter=async(config:any)=>{calls.push(config);return {data:{code:200,data:config.url==='/enterprises'?{content:[{id:1,enterpriseCode:'E1',enterpriseName:'真实接口虚构样本',businessType:'water',status:'enabled'}],total:1,page:1,size:20,totalPages:1}:[]},status:200,statusText:'OK',headers:{},config};};
 const {render,within,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<Page/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('真实接口虚构样本')));assert.equal(ui.container.textContent?.includes('演示'),false);assert.equal(within(ui.container).queryByRole('button',{name:'新增企业'}),null);assert.equal(within(ui.container).queryByRole('button',{name:'编辑企业'}),null);assert.ok(calls.some(c=>c.url==='/enterprises'));}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('enterprise editor sends stable code/version and retains edits on server conflict',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/CompanyList.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];
 useAppStore.setState({userInfo:{userId:'u',roles:['custom'],permissions:['enterprise.read','enterprise.manage'],mustChangePassword:false}});
 const value={id:1,enterpriseCode:'E1',enterpriseName:'虚构企业',businessType:'water',status:'enabled',version:7,districtCode:null};
 client.defaults.adapter=async(config:any)=>{calls.push(config);if(config.method==='patch')throw {status:409,message:'企业版本冲突'};let data:any=[];if(config.url==='/enterprises')data={content:[value],total:1,page:1,size:20,totalPages:1};else if(config.url==='/enterprises/E1')data=value;else if(config.url==='/enterprise-reference-options')data={businessTypes:[{value:'water',label:'供水'}],districts:[]};return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<Page/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('虚构企业')));fireEvent.click(within(ui.container).getByRole('button',{name:'编辑企业'}));await waitFor(()=>assert.ok(within(document.body).getByLabelText('企业全称')));fireEvent.change(within(document.body).getByLabelText('企业全称'),{target:{value:'核实企业'}});fireEvent.click(within(document.body).getByRole('button',{name:'保存企业'}));await waitFor(()=>assert.ok(calls.some(c=>c.method==='patch')));const sent=JSON.parse(calls.find(c=>c.method==='patch').data);assert.equal(sent.enterpriseCode,'E1');assert.equal(sent.expectedVersion,7);await waitFor(()=>assert.ok(document.body.textContent?.includes('企业版本冲突')));assert.equal((within(document.body).getByLabelText('企业全称') as HTMLInputElement).value,'核实企业');}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
