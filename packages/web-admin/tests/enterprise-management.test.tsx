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

function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function detailRaceFixture(mode:'refresh'|'mapping-save') {
 const {default:Page}=await vite.ssrLoadModule('/src/views/CompanyList.tsx');
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');
 const original=client.defaults.adapter;const calls:any[]=[];const pending=deferred<void>();
 const A={id:1,enterpriseCode:'A',enterpriseName:'企业甲A',businessType:'water',status:'enabled',version:7,districtCode:null};
 const B={id:2,enterpriseCode:'B',enterpriseName:'企业乙B',businessType:'water',status:'enabled',version:21,districtCode:null};
 let aReads=0;let pendingStarted=false;
 useAppStore.setState({userInfo:{userId:'u',roles:['custom'],permissions:['enterprise.read','enterprise.manage'],mustChangePassword:false}});
 client.defaults.adapter=async(config:any)=>{
  calls.push(config);let data:any=[];
  if(config.url==='/enterprises')data={content:[A,B],total:2,page:1,size:20,totalPages:1};
  else if(config.url==='/enterprise-reference-options')data={businessTypes:[{value:'water',label:'供水'}],districts:[]};
  else if(config.url==='/enterprises/A'&&config.method==='get'){
   aReads++;if(mode==='refresh'&&aReads===2){pendingStarted=true;await pending.promise;}data={...A,version:aReads===1?7:8};
  }else if(config.url==='/enterprises/B'&&config.method==='get')data=B;
  else if(config.method==='post'){
   if(mode==='mapping-save'&&config.url==='/enterprises/A/department-mappings'){pendingStarted=true;await pending.promise;}data={changed:true};
  }
  return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};
 };
 const testing=await import('@testing-library/react');const {render,within,fireEvent,cleanup,waitFor}=testing;const ui=render(<Page/>);
 const open=async(name:string)=>{await waitFor(()=>assert.ok(within(ui.container).getByText(name)));const row=within(ui.container).getByText(name).closest('tr')!;fireEvent.click(within(row).getByRole('button',{name:'详情与历史'}));await waitFor(()=>assert.ok(within(document.body).getByRole('dialog',{name})));};
 const close=()=>{const dialog=within(document.body).getByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));};
 const fillHouse=(households:string)=>{fireEvent.click(within(document.body).getByRole('tab',{name:'服务户数历史'}));fireEvent.change(within(document.body).getByLabelText('服务户数（留空为未知）'),{target:{value:households}});fireEvent.change(within(document.body).getByLabelText('生效日'),{target:{value:'2027-01-01'}});};
 const fillMapping=(code:string)=>{fireEvent.click(within(document.body).getByRole('tab',{name:'来源部门映射'}));fireEvent.change(within(document.body).getByLabelText('来源系统'),{target:{value:'synthetic'}});fireEvent.change(within(document.body).getByLabelText('来源部门码'),{target:{value:code}});fireEvent.change(within(document.body).getByLabelText('来源部门名称'),{target:{value:'部门'+code}});};
 const posts=()=>calls.filter(c=>c.method==='post');
 return {...testing,ui,calls,pending,open,close,fillHouse,fillMapping,posts,pendingStarted:()=>pendingStarted,finish:()=>{ui.unmount();cleanup();client.defaults.adapter=original;}};
}

test('late A household refresh preserves B drafts and B submits its own key/version',async()=>{
 const f=await detailRaceFixture('refresh');const {within,fireEvent,waitFor,act}=f;
 try{
  await f.open('企业甲A');f.fillHouse('100');fireEvent.click(within(document.body).getByRole('button',{name:'新增户数版本'}));
  await waitFor(()=>assert.equal(f.pendingStarted(),true));const a=f.posts()[0];assert.equal(a.url,'/enterprises/A/households');assert.equal(JSON.parse(a.data).expectedVersion,7);
  f.close();await f.open('企业乙B');f.fillHouse('222');f.fillMapping('B-DRAFT');
  await act(async()=>{f.pending.resolve();await new Promise(done=>setTimeout(done,0));});
  assert.ok(within(document.body).getByRole('dialog',{name:'企业乙B'}));assert.equal((within(document.body).getByLabelText('来源部门码') as HTMLInputElement).value,'B-DRAFT');
  fireEvent.click(within(document.body).getByRole('tab',{name:'服务户数历史'}));assert.equal((within(document.body).getByLabelText('服务户数（留空为未知）') as HTMLInputElement).value,'222');
  fireEvent.click(within(document.body).getByRole('button',{name:'新增户数版本'}));await waitFor(()=>assert.ok(f.posts().some(c=>c.url==='/enterprises/B/households')));const b=f.posts().find(c=>c.url==='/enterprises/B/households');assert.equal(JSON.parse(b.data).expectedVersion,21);assert.equal(JSON.parse(b.data).households,222);
  await waitFor(()=>assert.equal(within(document.body).getByRole('button',{name:'新增户数版本'}).className.includes('ant-btn-loading'),false));
  fireEvent.click(within(document.body).getByRole('tab',{name:'来源部门映射'}));assert.equal((within(document.body).getByLabelText('来源部门码') as HTMLInputElement).value,'B-DRAFT');
  fireEvent.click(within(document.body).getByRole('button',{name:'保存部门映射'}));await waitFor(()=>assert.ok(f.posts().some(c=>c.url==='/enterprises/B/department-mappings')));const mapping=f.posts().find(c=>c.url==='/enterprises/B/department-mappings');const body=JSON.parse(mapping.data);assert.equal(body.expectedEnterpriseVersion,21);assert.equal(body.expectedVersion,0);assert.equal(body.sourceDepartmentCode,'B-DRAFT');
 }finally{f.pending.resolve();f.finish();}
});
test('late A mapping save completion cannot refresh A or erase a later B mapping draft',async()=>{
 const f=await detailRaceFixture('mapping-save');const {within,fireEvent,waitFor,act}=f;
 try{
  await f.open('企业甲A');f.fillMapping('A-DEPT');fireEvent.click(within(document.body).getByRole('button',{name:'保存部门映射'}));await waitFor(()=>assert.equal(f.pendingStarted(),true));
  const a=f.posts()[0];assert.equal(a.url,'/enterprises/A/department-mappings');assert.equal(JSON.parse(a.data).expectedEnterpriseVersion,7);assert.equal(JSON.parse(a.data).sourceDepartmentCode,'A-DEPT');
  f.close();await f.open('企业乙B');f.fillMapping('B-NEW');await act(async()=>{f.pending.resolve();await new Promise(done=>setTimeout(done,0));});
  assert.ok(within(document.body).getByRole('dialog',{name:'企业乙B'}));assert.equal((within(document.body).getByLabelText('来源部门码') as HTMLInputElement).value,'B-NEW');assert.equal(f.calls.filter(c=>c.method==='get'&&c.url==='/enterprises/A').length,1);
  fireEvent.click(within(document.body).getByRole('button',{name:'保存部门映射'}));await waitFor(()=>assert.ok(f.posts().some(c=>c.url==='/enterprises/B/department-mappings')));const b=f.posts().find(c=>c.url==='/enterprises/B/department-mappings');assert.equal(JSON.parse(b.data).expectedEnterpriseVersion,21);assert.equal(JSON.parse(b.data).sourceDepartmentCode,'B-NEW');
 }finally{f.pending.resolve();f.finish();}
});
test('closing A invalidates an in-flight save refresh and it never reopens the drawer',async()=>{
 const f=await detailRaceFixture('refresh');const {within,fireEvent,waitFor,act}=f;
 try{
  await f.open('企业甲A');f.fillHouse('100');fireEvent.click(within(document.body).getByRole('button',{name:'新增户数版本'}));await waitFor(()=>assert.equal(f.pendingStarted(),true));f.close();
  await act(async()=>{f.pending.resolve();await new Promise(done=>setTimeout(done,0));});await waitFor(()=>assert.ok(!within(document.body).queryByRole('dialog',{name:'企业甲A'}),'closed A drawer must stay closed'));
  assert.equal(f.posts().length,1);assert.equal(f.posts()[0].url,'/enterprises/A/households');assert.equal(JSON.parse(f.posts()[0].data).expectedVersion,7);
 }finally{f.pending.resolve();f.finish();}
});

test('late A enterprise save cannot close or clear a newer B editor and B sends its own version',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/CompanyList.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];const pending=deferred<void>();let started=false;
 const A={id:1,enterpriseCode:'A',enterpriseName:'企业甲A',businessType:'water',status:'enabled',version:7,districtCode:null};const B={id:2,enterpriseCode:'B',enterpriseName:'企业乙B',businessType:'water',status:'enabled',version:21,districtCode:null};
 useAppStore.setState({userInfo:{userId:'u',roles:['custom'],permissions:['enterprise.read','enterprise.manage'],mustChangePassword:false}});
 client.defaults.adapter=async(config:any)=>{calls.push(config);let data:any=[];if(config.url==='/enterprises')data={content:[A,B],total:2,page:1,size:20,totalPages:1};else if(config.url==='/enterprise-reference-options')data={businessTypes:[{value:'water',label:'供水'}],districts:[]};else if(config.method==='get'&&config.url==='/enterprises/A')data=A;else if(config.method==='get'&&config.url==='/enterprises/B')data=B;else if(config.method==='patch'){if(config.url==='/enterprises/A'){started=true;await pending.promise;}data={value:config.url==='/enterprises/A'?A:B};}return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react');const ui=render(<Page/>);
 const edit=async(name:string,code:string)=>{await waitFor(()=>assert.ok(within(ui.container).getByText(name)));fireEvent.click(within(within(ui.container).getByText(name).closest('tr')!).getByRole('button',{name:'编辑企业'}));await waitFor(()=>assert.equal((within(document.body).getByLabelText('登记编码') as HTMLInputElement).value,code));};
 try{
  await edit('企业甲A','A');fireEvent.change(within(document.body).getByLabelText('企业全称'),{target:{value:'A核实'}});fireEvent.click(within(document.body).getByRole('button',{name:'保存企业'}));await waitFor(()=>assert.equal(started,true));const a=calls.find(c=>c.method==='patch');assert.equal(a.url,'/enterprises/A');assert.equal(JSON.parse(a.data).expectedVersion,7);
  fireEvent.click(within(within(document.body).getByRole('dialog')).getByRole('button',{name:'Cancel'}));await edit('企业乙B','B');fireEvent.change(within(document.body).getByLabelText('企业全称'),{target:{value:'B草稿'}});
  await act(async()=>{pending.resolve();await new Promise(done=>setTimeout(done,0));});assert.ok(within(document.body).getByRole('dialog',{name:'编辑企业'}));assert.equal((within(document.body).getByLabelText('登记编码') as HTMLInputElement).value,'B');assert.equal((within(document.body).getByLabelText('企业全称') as HTMLInputElement).value,'B草稿');
  fireEvent.click(within(document.body).getByRole('button',{name:'保存企业'}));await waitFor(()=>assert.ok(calls.some(c=>c.method==='patch'&&c.url==='/enterprises/B')));const b=JSON.parse(calls.find(c=>c.method==='patch'&&c.url==='/enterprises/B').data);assert.equal(b.enterpriseCode,'B');assert.equal(b.expectedVersion,21);assert.equal(b.enterpriseName,'B草稿');
 }finally{pending.resolve();ui.unmount();cleanup();client.defaults.adapter=original;}
});
