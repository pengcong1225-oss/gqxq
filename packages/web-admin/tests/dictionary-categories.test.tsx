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
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-dictionary-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();for(const channel of browserChannels){channel.port1.close();channel.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalMessageChannel,configurable:true,writable:true});});
test('dictionary page uses real metadata and denied capability renders no management controls',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:App}=await vite.ssrLoadModule('/src/App.tsx');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];
 const identity={userId:'u',username:'u',roles:['admin'],permissions:[],mustChangePassword:false};
 client.defaults.adapter=async(config:any)=>{calls.push(config);return {data:{code:200,data:identity},status:200,statusText:'OK',headers:{},config};};useAppStore.setState({token:'synthetic',userInfo:identity});
 const {render,within,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/dicts']}><App/></MemoryRouter>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('无权限，请联系管理员')));assert.equal(within(ui.container).queryByRole('button',{name:'新增字典项'}),null);assert.equal(calls.some(c=>c.url==='/dict-types'),false);}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('category selector changes major and clears incompatible minor with actual dictionary version',async()=>{
 const {default:Selector}=await vite.ssrLoadModule('/src/components/CategorySelector.tsx');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const changes:any[]=[];
 client.defaults.adapter=async(config:any)=>({data:{code:200,data:{dictionaryVersion:'7',items:[{code:'fee',label:'费用',parentCode:null},{code:'pressure',label:'气压',parentCode:null},{code:'price',label:'价格',parentCode:'fee'}]}},status:200,statusText:'OK',headers:{},config});
 const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<Selector value={{majorCode:'fee',minorCode:'price',dictionaryVersion:'6'}} onChange={(v:any)=>changes.push(v)}/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByRole('option',{name:'气压'})));fireEvent.change(within(ui.container).getByLabelText('正式大类'),{target:{value:'pressure'}});assert.deepEqual(changes.at(-1),{majorCode:'pressure',minorCode:null,dictionaryVersion:'7'});}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('managed dictionary table saves server version and preserves editor on conflict',async()=>{
 const {default:Manager}=await vite.ssrLoadModule('/src/views/DictManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];
 useAppStore.setState({userInfo:{userId:'u',roles:['manager'],permissions:['system.dict.manage'],mustChangePassword:false}});
 const type={code:'complaint_category',name:'正式大小类',version:4,published:true,status:'enabled',readOnly:false,fixedCodes:false};const item={itemId:'fee-id',code:'fee',label:'费用',parentCode:null,version:2,status:'enabled',sort:0,published:true};
 client.defaults.adapter=async(config:any)=>{calls.push(config);if(config.method==='patch')throw {status:409,message:'版本冲突'};return {data:{code:200,data:config.url==='/dict-types'?[type]:{type,items:[item]}},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<Manager/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('费用')));assert.equal(ui.container.textContent?.includes('演示'),false);fireEvent.click(within(ui.container).getByRole('button',{name:'编辑条目'}));await waitFor(()=>assert.ok(within(document.body).getByLabelText('条目标签')));fireEvent.change(within(document.body).getByLabelText('条目标签'),{target:{value:'核实费用'}});fireEvent.click(within(document.body).getByRole('button',{name:'保存条目'}));await waitFor(()=>assert.ok(calls.some(c=>c.method==='patch')));const sent=JSON.parse(calls.find(c=>c.method==='patch').data);assert.equal(sent.expectedVersion,2);assert.equal(sent.expectedTypeVersion,4);await waitFor(()=>assert.ok(document.body.textContent?.includes('版本冲突')));assert.equal((within(document.body).getByLabelText('条目标签') as HTMLInputElement).value,'核实费用');}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
