import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {JSDOM} from 'jsdom';
import {createServer,type ViteDevServer} from 'vite';
let vite:ViteDevServer,dom:JSDOM;
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Document:dom.window.Document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
 const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((e:Element)=>computed(e)) as any;Object.defineProperty(globalThis,'getComputedStyle',{value:dom.window.getComputedStyle,configurable:true});globalThis.localStorage=dom.window.localStorage;
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-complaint-import-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();});
const preview={batchId:'CIMP-test',name:'综合查询.xls',expiresAt:'2030-01-01T00:00:00Z',counts:{total:3,unique:2,duplicates:1,create:2,skip:0,error:0},canCommit:true};
const batch={preview,result:null,expired:false,details:[{row:3,sourceId:'DH-TEST',title:'虚构供水诉求',businessType:'water',complaintType:'complaint',districtName:'西陵区',action:'create',errors:[]}]};
test('a session-bound request cannot be rebound by the shared interceptor',async()=>{const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let calls=0;client.defaults.adapter=async()=>{calls++;throw Error('must not dispatch');};localStorage.setItem('token','new-actor');try{await assert.rejects(()=>client.post('/complaint-imports/preview',new ArrayBuffer(1),{headers:{Authorization:'Bearer old-actor'}}),/登录身份已改变/);assert.equal(calls,0);}finally{client.defaults.adapter=original;localStorage.removeItem('token');}});
async function setup(){
 assert.ok(existsSync(new URL('../src/components/ComplaintImportDialog.tsx',import.meta.url)),'complaint import dialog must exist');
 const {default:Dialog}=await vite.ssrLoadModule('/src/components/ComplaintImportDialog.tsx');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 useAppStore.setState({token:'test-A',userInfo:{userId:'A',permissions:['complaint.import','complaint.read'],roles:['admin'],authorizationVersion:1,mustChangePassword:false}});
 localStorage.setItem('token','test-A');const testing=await import('@testing-library/react');const file=new dom.window.File(['test'],'综合查询.xls');(file as any).arrayBuffer=async()=>new Uint8Array([1]).buffer;
 return {Dialog,client,useAppStore,testing,file};
}
test('complaint upload preview confirm refresh and same-key retry',async()=>{
 const {Dialog,client,testing,file}=await setup();const original=client.defaults.adapter;const keys:string[]=[];let refreshed=0,attempts=0;
 client.defaults.adapter=async(config:any)=>{let data:any=[];if(config.url.endsWith('/preview'))data=preview;else if(config.url.endsWith('/commit')){keys.push(JSON.parse(config.data).requestId);if(++attempts===1)throw new Error('模拟网络中断');data={batchId:preview.batchId,state:'succeeded',created:2,skipped:0,completedAt:'2026-10-10T00:00:00Z'};}else if(config.url!=='/complaint-imports')data=batch;return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};
 const ui=testing.render(<Dialog onImported={()=>refreshed++}/>);
 try{testing.fireEvent.click(testing.within(ui.container).getByRole('button',{name:/批量导入/}));const body=testing.within(document.body);testing.fireEvent.change(body.getByLabelText('诉求导入文件'),{target:{files:[file]}});testing.fireEvent.click(body.getByRole('button',{name:'校验预览'}));await testing.waitFor(()=>assert.ok(body.getByText('虚构供水诉求')));testing.fireEvent.click(body.getByRole('button',{name:'确认导入'}));await testing.waitFor(()=>assert.ok(body.getByText(/模拟网络中断/)));testing.fireEvent.click(body.getByRole('button',{name:'确认导入'}));await testing.waitFor(()=>assert.equal(refreshed,1));assert.equal(keys[0],keys[1]);assert.ok(body.getByText('导入完成：新增 2 件，跳过 0 件'));}finally{ui.unmount();testing.cleanup();client.defaults.adapter=original;}
});
test('late preview disappears across actor change; revoked entry stays disabled',async()=>{
 const {Dialog,client,useAppStore,testing,file}=await setup();const original=client.defaults.adapter;let release!:()=>void,started=false;const pending=new Promise<void>(r=>release=r);
 client.defaults.adapter=async(config:any)=>{let data:any=[];if(config.url.endsWith('/preview')){started=true;await pending;data=preview;}else if(config.url!=='/complaint-imports')data=batch;return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};const ui=testing.render(<Dialog onImported={()=>{throw Error('stale actor');}}/>);
 try{testing.fireEvent.click(testing.within(ui.container).getByRole('button',{name:/批量导入/}));const body=testing.within(document.body);testing.fireEvent.change(body.getByLabelText('诉求导入文件'),{target:{files:[file]}});testing.fireEvent.click(body.getByRole('button',{name:'校验预览'}));await testing.waitFor(()=>assert.equal(started,true));await testing.act(async()=>{useAppStore.setState({token:'test-B',userInfo:{userId:'B',permissions:['complaint.read'],roles:['readonly'],authorizationVersion:2,mustChangePassword:false}});release();await new Promise(r=>setTimeout(r,0));});assert.equal(body.queryByText('虚构供水诉求'),null);assert.equal((testing.within(ui.container).getByRole('button',{name:/批量导入/}) as HTMLButtonElement).disabled,true);}finally{release();ui.unmount();testing.cleanup();client.defaults.adapter=original;}
});
test('switching to another authorized actor during file reading never uploads the old file',async()=>{
 const {Dialog,client,useAppStore,testing,file}=await setup();const original=client.defaults.adapter;let release!:()=>void,started=false,uploads=0;const pending=new Promise<void>(r=>release=r);(file as any).arrayBuffer=async()=>{started=true;await pending;return new Uint8Array([1]).buffer;};
 client.defaults.adapter=async(config:any)=>{let data:any=[];if(config.url.endsWith('/preview')){uploads++;data=preview;}else if(config.url!=='/complaint-imports')data=batch;return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};const ui=testing.render(<Dialog onImported={()=>{}}/>);
 try{testing.fireEvent.click(testing.within(ui.container).getByRole('button',{name:/批量导入/}));const body=testing.within(document.body);testing.fireEvent.change(body.getByLabelText('诉求导入文件'),{target:{files:[file]}});testing.fireEvent.click(body.getByRole('button',{name:'校验预览'}));await testing.waitFor(()=>assert.equal(started,true));await testing.act(async()=>{useAppStore.setState({token:'test-B',userInfo:{userId:'B',permissions:['complaint.import','complaint.read'],roles:['admin'],authorizationVersion:2,mustChangePassword:false}});release();await new Promise(r=>setTimeout(r,20));});assert.equal(uploads,0);assert.equal(body.queryByText('虚构供水诉求'),null);}finally{release();ui.unmount();testing.cleanup();client.defaults.adapter=original;}
});
