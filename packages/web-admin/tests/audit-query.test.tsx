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
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-audit-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();for(const channel of browserChannels){channel.port1.close();channel.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalMessageChannel,configurable:true,writable:true});});
test('audit route and menu deny missing current capability without querying logs',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:App}=await vite.ssrLoadModule('/src/App.tsx');
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let auditCalls=0;
 const identity={userId:'u',username:'u',roles:['admin'],permissions:[],mustChangePassword:false};
 client.defaults.adapter=async(config:any)=>{if(config.url.startsWith('/audit-logs'))auditCalls++;return {data:{code:200,data:identity},status:200,statusText:'OK',headers:{},config};};
 useAppStore.setState({token:'synthetic-token',userInfo:identity});
 const {render,within,cleanup,waitFor}=await import('@testing-library/react');
 const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/system/audit-logs']}><App/></MemoryRouter>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('无权限，请联系管理员')));assert.equal(within(ui.container).queryByText('登录与操作日志'),null);assert.equal(within(ui.container).queryByText('查看详情'),null);assert.equal(auditCalls,0);}finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('audit page submits actor/business filters, pages safely and opens projected details',{timeout:20000},async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:App}=await vite.ssrLoadModule('/src/App.tsx');
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];
 const identity={userId:'u',username:'u',roles:['auditor'],permissions:['system.audit.read'],mustChangePassword:false};
 const row={auditId:'AUD-1',userId:'operator-1',category:'operation',module:'user',action:'USER_UPDATE',bizId:'virtual-target',businessNo:null,result:'success',originalResult:'success',createdAt:'2026-10-09T00:00:00Z',detail:{before:{roles:['handler']},after:{roles:['auditor']}}};
 client.defaults.adapter=async(config:any)=>{calls.push({url:config.url,params:config.params});return {data:{code:200,data:config.url==='/auth/user-info'?identity:config.url==='/audit-logs/AUD-1'?row:{content:[row],total:21,page:config.params?.page??1,size:20,totalPages:2}},status:200,statusText:'OK',headers:{},config};};
 useAppStore.setState({token:'synthetic-token',userInfo:identity});const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');
 const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/system/audit-logs']}><App/></MemoryRouter>);
 try{
  await waitFor(()=>assert.ok(within(ui.container).getByText('USER_UPDATE')));
  assert.ok(within(ui.container).getAllByText('登录与操作日志').length>=1);
  fireEvent.change(within(ui.container).getByLabelText('操作人'),{target:{value:'operator-1'}});fireEvent.change(within(ui.container).getByLabelText('业务编号'),{target:{value:'NO-C1'}});fireEvent.click(within(ui.container).getByRole('button',{name:/查\s*询/}));
  await waitFor(()=>assert.ok(calls.some(c=>c.url==='/audit-logs'&&c.params.actor==='operator-1'&&c.params.businessNo==='NO-C1'&&c.params.page===1)));
  fireEvent.click(ui.container.querySelector('.ant-pagination-item-2')!);await waitFor(()=>assert.ok(calls.some(c=>c.params?.page===2&&c.params.actor==='operator-1')));
  fireEvent.click(within(ui.container).getByRole('button',{name:'查看详情'}));await waitFor(()=>assert.ok(within(document.body).getByText('安全详情')));
  assert.ok(document.body.textContent?.includes('handler'));assert.ok(document.body.textContent?.includes('auditor'));assert.equal(document.body.textContent?.includes('SECRET'),false);
  assert.equal(within(ui.container).queryByRole('button',{name:'导出'}),null);assert.equal(within(ui.container).queryByRole('button',{name:'删除'}),null);
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
