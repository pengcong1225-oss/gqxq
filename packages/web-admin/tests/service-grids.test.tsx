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
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-grid-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();for(const channel of browserChannels){channel.port1.close();channel.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalMessageChannel,configurable:true,writable:true});});

const A={code:'A',serviceGridCode:'A',enterpriseCode:'E1',businessType:'water',version:'7',adminGridCodes:['AG'],communityCodes:['X'],validFrom:'2026-01-01',validTo:null,geometry:null,coordinateSystem:null,geometrySources:[],coverageState:'maintained'};
const B={...A,code:'B',serviceGridCode:'B',version:'21'};
const options={enterprises:[{enterpriseCode:'E1',enterpriseName:'合成企业',businessType:'water',status:'enabled'}],adminGrids:[{code:'AG',name:'合成行政',districtCode:'D1',version:1}],communities:[{code:'X',name:'合成小区',adminGridCode:'AG',version:1}],businessTypes:[{value:'water',label:'供水'}],districts:[{value:'D1',label:'合成区'}],businessTypeVersion:1,districtVersion:1};
async function fixture(manage:boolean,late:'detail'|'save'|null=null){
 const {default:Page}=await vite.ssrLoadModule('/src/views/GridManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];let resolve!:()=>void;const pending=new Promise<void>(done=>resolve=done);let started=false;
 useAppStore.setState({userInfo:{userId:'u',roles:['custom'],permissions:manage?['grid.read','grid.manage']:['grid.read'],mustChangePassword:false}});
 client.defaults.adapter=async(config:any)=>{calls.push(config);let data:any=[];if(config.url==='/grids')data={content:[A,B],total:2,page:1,size:20,totalPages:1};else if(config.url==='/grid-reference-options')data=options;else if(config.url.endsWith('/history'))data=[config.url.includes('/A/')?A:B];else if(config.url==='/grids/A'&&config.method==='get'){if(late==='detail'){started=true;await pending;}data=A;}else if(config.url==='/grids/B'&&config.method==='get')data=B;else if(config.method==='patch'){if(late==='save'&&config.url==='/grids/A'){started=true;await pending;}data={value:config.url==='/grids/A'?A:B};}return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};
 const testing=await import('@testing-library/react');const ui=testing.render(<Page/>);const open=async(code:string,edit=true)=>{await testing.waitFor(()=>assert.ok(testing.within(ui.container).getByText(code)));const row=testing.within(ui.container).getByText(code).closest('tr')!;testing.fireEvent.click(testing.within(row).getByRole('button',{name:edit?'编辑覆盖':'详情与历史'}));};
 return {...testing,ui,calls,open,resolve,started:()=>started,finish:()=>{resolve();ui.unmount();testing.cleanup();client.defaults.adapter=original;}};
}
test('grid page loads real API values hides revoked management and states missing geometry',async()=>{const f=await fixture(false);try{await f.open('A',false);await f.waitFor(()=>assert.ok(f.within(document.body).getAllByText('无授权边界数据').length>0));assert.equal(f.within(f.ui.container).queryByRole('button',{name:'新增服务网格'}),null);assert.equal(f.within(f.ui.container).queryByRole('button',{name:'编辑覆盖'}),null);assert.ok(f.calls.some(c=>c.url==='/grids'));assert.equal(f.ui.container.textContent?.includes('演示数据'),false);}finally{f.finish();}});
test('late A detail cannot replace B key/version draft',async()=>{const f=await fixture(true,'detail');try{await f.open('A');await f.waitFor(()=>assert.equal(f.started(),true));f.fireEvent.click(f.within(document.body).getByRole('button',{name:/取\s*消/}));await f.open('B');await f.waitFor(()=>assert.equal((f.within(document.body).getByLabelText('服务网格编码') as HTMLInputElement).value,'B'));f.fireEvent.change(f.within(document.body).getByLabelText('生效日'),{target:{value:'2027-01-01'}});await f.act(async()=>{f.resolve();await new Promise(done=>setTimeout(done,0));});assert.equal((f.within(document.body).getByLabelText('服务网格编码') as HTMLInputElement).value,'B');assert.equal((f.within(document.body).getByLabelText('生效日') as HTMLInputElement).value,'2027-01-01');f.fireEvent.click(f.within(document.body).getByRole('button',{name:'保存覆盖'}));await f.waitFor(()=>assert.ok(f.calls.some(c=>c.method==='patch')));const sent=f.calls.find(c=>c.method==='patch');assert.equal(sent.url,'/grids/B');assert.equal(JSON.parse(sent.data).expectedVersion,21);}finally{f.finish();}});
test('late A save completion cannot close B or erase its draft',async()=>{const f=await fixture(true,'save');try{await f.open('A');await f.waitFor(()=>assert.equal((f.within(document.body).getByLabelText('服务网格编码') as HTMLInputElement).value,'A'));f.fireEvent.change(f.within(document.body).getByLabelText('生效日'),{target:{value:'2027-01-01'}});f.fireEvent.click(f.within(document.body).getByRole('button',{name:'保存覆盖'}));await f.waitFor(()=>assert.equal(f.started(),true));assert.equal(JSON.parse(f.calls.find(c=>c.method==='patch').data).expectedVersion,7);f.fireEvent.click(f.within(document.body).getByRole('button',{name:/取\s*消/}));await f.open('B');await f.waitFor(()=>assert.equal((f.within(document.body).getByLabelText('服务网格编码') as HTMLInputElement).value,'B'));f.fireEvent.change(f.within(document.body).getByLabelText('生效日'),{target:{value:'2028-01-01'}});await f.act(async()=>{f.resolve();await new Promise(done=>setTimeout(done,0));});assert.equal((f.within(document.body).getByLabelText('生效日') as HTMLInputElement).value,'2028-01-01');assert.equal(f.calls.filter(c=>c.method==='get'&&c.url==='/grids/A').length,1);}finally{f.finish();}});
test('boundary preview renders source-labelled geometry without pretending a map supplier exists',async()=>{const {default:Preview}=await vite.ssrLoadModule('/src/components/GridBoundaryPreview.tsx');const {render,within,cleanup}=await import('@testing-library/react');const ui=render(<Preview coverage={{...A,coordinateSystem:'WGS84',geometrySources:['synthetic fixture'],geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'AG'},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}]}}}/>);try{assert.ok(within(ui.container).getByRole('img',{name:'授权边界几何预览'}));assert.ok(ui.container.textContent?.includes('synthetic fixture'));assert.ok(ui.container.textContent?.includes('网格边界'));assert.ok(ui.container.textContent?.includes('全球大地坐标系'));assert.equal(ui.container.textContent?.includes('WGS84'),false);}finally{ui.unmount();cleanup();}});

