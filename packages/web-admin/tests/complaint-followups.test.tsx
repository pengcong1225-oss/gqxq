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
  Document:dom.window.Document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,HTMLBodyElement:dom.window.HTMLBodyElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,
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
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-c3-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();for(const channel of browserChannels){channel.port1.close();channel.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalMessageChannel,configurable:true,writable:true});});

const identity=(permissions:string[],accountType='internal')=>({userId:'owner',username:'owner',roles:['custom'],permissions,accountType,mustChangePassword:false,authorizationVersion:1});
const fact={followupId:'FUP-synthetic',complaintId:'C1',ownerId:'owner',version:2,order:1,contacted:true,occurredAt:'2026-10-09T00:30:00Z',evaluationCode:'satisfied',dissatisfactionReason:null,notes:'原备注',action:'revise',operatorId:'owner',operatorName:'owner',reason:'核实',createdAt:'2026-10-09T00:30:00Z',revisedAt:'2026-10-09T00:40:00Z',conclusion:'原主管结论',concludedBy:'manager',concludedAt:'2026-10-09T00:40:00Z'};
const payload=(complaintId='C1')=>({complaintId,records:[{...fact,complaintId}],history:[{...fact,complaintId,version:1,contacted:false,evaluationCode:null},{...fact,complaintId}],sourceEvaluation:{state:'available',label:'不满意',reason:null,provenance:'来源导出 metadata.坐席满意度'},formalEvaluation:{state:'unavailable',reason:'Q5 正式评价规则未确认'}});
async function modules(){return {Panel:(await vite.ssrLoadModule('/src/components/ComplaintFollowups.tsx')).default,store:(await vite.ssrLoadModule('/src/stores/appStore.ts')).useAppStore,client:(await vite.ssrLoadModule('/src/api/request.ts')).default};}

test('C3 actual followup panel exists for scoped independent facts',async()=>{let module:any;try{module=await vite.ssrLoadModule('/src/components/ComplaintFollowups.tsx');}catch{}assert.equal(typeof module?.default,'function','manual followup UI missing');});
test('denied capabilities hide controls, enterprise cannot see supervisor action, source and history stay separate',async()=>{
 const {Panel,store,client}=await modules();const original=client.defaults.adapter;client.defaults.adapter=async(config:any)=>({data:{code:200,data:payload()},status:200,statusText:'OK',headers:{},config});
 store.setState({userInfo:identity(['complaint.read'],'enterprise')});const {render,within,waitFor,cleanup,act}=await import('@testing-library/react');const ui=render(<Panel complaintId="C1"/>);
 try{await waitFor(()=>assert.ok(ui.container.textContent?.includes('原备注')));assert.equal(within(ui.container).queryByRole('button',{name:'登记回访'}),null);assert.equal(within(ui.container).queryByRole('button',{name:'填写主管结论'}),null);assert.ok(ui.container.textContent?.includes('正式评价规则未确认'));assert.equal(ui.container.textContent?.includes('Q5'),false);assert.ok(ui.container.textContent?.includes('未接通'));assert.ok(ui.container.textContent?.includes('来源坐席评价'));
 await act(async()=>store.setState({userInfo:identity(['complaint.read','followup.create','followup.conclude'],'enterprise')}));await waitFor(()=>assert.ok(within(ui.container).getByRole('button',{name:'登记回访'})));assert.equal(within(ui.container).queryByRole('button',{name:'填写主管结论'}),null);
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('dissatisfied reason is required; unchanged retries preserve key and changed content receives a new key',async()=>{
 const {Panel,store,client}=await modules();const original=client.defaults.adapter;const calls:any[]=[];let reject=true;
 client.defaults.adapter=async(config:any)=>{calls.push(config);if(config.method==='post'&&reject)throw new Error('合成网络失败');return {data:{code:200,data:config.method==='post'?fact:payload()},status:200,statusText:'OK',headers:{},config};};store.setState({userInfo:identity(['complaint.read','followup.create'])});
 const {render,within,fireEvent,waitFor,cleanup}=await import('@testing-library/react');const ui=render(<Panel complaintId="C1"/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByRole('button',{name:'登记回访'})));fireEvent.click(within(ui.container).getByRole('button',{name:'登记回访'}));fireEvent.change(within(ui.container).getByLabelText('是否接通'),{target:{value:'true'}});fireEvent.change(within(ui.container).getByLabelText('回访评价'),{target:{value:'dissatisfied'}});fireEvent.click(within(ui.container).getByRole('button',{name:'保存回访'}));await waitFor(()=>assert.ok(ui.container.textContent?.includes('不满意理由必填')));assert.equal(calls.filter(c=>c.method==='post').length,0);
 fireEvent.change(within(ui.container).getByLabelText('不满意理由'),{target:{value:'仍未解决'}});fireEvent.click(within(ui.container).getByRole('button',{name:'保存回访'}));await waitFor(()=>assert.ok(ui.container.textContent?.includes('合成网络失败')));const first=JSON.parse(calls.find(c=>c.method==='post').data);fireEvent.click(within(ui.container).getByRole('button',{name:'保存回访'}));await waitFor(()=>assert.equal(calls.filter(c=>c.method==='post').length,2));assert.equal(JSON.parse(calls.filter(c=>c.method==='post')[1].data).requestId,first.requestId);
 fireEvent.change(within(ui.container).getByLabelText('回访备注'),{target:{value:'新事实'}});reject=false;fireEvent.click(within(ui.container).getByRole('button',{name:'保存回访'}));await waitFor(()=>assert.equal(calls.filter(c=>c.method==='post').length,3));assert.notEqual(JSON.parse(calls.filter(c=>c.method==='post')[2].data).requestId,first.requestId);
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('supervisor submits independent conclusion endpoint and delayed old complaint responses do not repopulate',async()=>{
 const {Panel,store,client}=await modules();const original=client.defaults.adapter;const calls:any[]=[];let release!:(value:any)=>void;let delayed=false;
 client.defaults.adapter=async(config:any)=>{calls.push(config);if(delayed&&config.url==='/complaints/C1/followups')return new Promise(r=>release=r);return {data:{code:200,data:config.method==='patch'?{...fact,version:3}:payload(config.url.includes('C2')?'C2':'C1')},status:200,statusText:'OK',headers:{},config};};store.setState({userInfo:identity(['complaint.read','followup.conclude'])});
 const {render,within,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');const ui=render(<Panel complaintId="C1"/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByRole('button',{name:'填写主管结论'})));fireEvent.click(within(ui.container).getByRole('button',{name:'填写主管结论'}));fireEvent.change(within(ui.container).getByLabelText('主管结论'),{target:{value:'新主管结论'}});fireEvent.change(within(ui.container).getByLabelText('结论理由'),{target:{value:'主管核实'}});fireEvent.click(within(ui.container).getByRole('button',{name:'保存主管结论'}));await waitFor(()=>assert.ok(calls.some(c=>c.method==='patch')));const sent=calls.find(c=>c.method==='patch');assert.equal(sent.url,'/followups/FUP-synthetic/conclusion');assert.equal(JSON.parse(sent.data).expectedVersion,2);assert.equal(JSON.parse(sent.data).evaluationCode,undefined);
 delayed=true;fireEvent.click(within(ui.container).getByRole('button',{name:'刷新回访'}));await waitFor(()=>assert.equal(typeof release,'function'));ui.rerender(<Panel complaintId="C2"/>);await waitFor(()=>assert.ok(ui.container.textContent?.includes('C2')));await act(async()=>release({data:{code:200,data:{...payload('C1'),records:[{...fact,notes:'旧诉求秘密'}]}},status:200,statusText:'OK',headers:{},config:{}}));assert.equal(ui.container.textContent?.includes('旧诉求秘密'),false);
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});

test('account manager exposes explicit type maintenance and sends accountType without inferring from admin role',async()=>{
 const {store,client}=await modules();const Manager=(await vite.ssrLoadModule('/src/views/UserManager.tsx')).default;const original=client.defaults.adapter;const calls:any[]=[];
 const row={userId:'target',username:'target',realName:'合成人员',roles:['admin'],roleNames:['管理员'],accountType:'unknown',status:1,lastLoginAt:null,createdAt:null,mustChangePassword:false};
 store.setState({userInfo:{...identity(['system.users.manage','system.roles.manage']),roles:['admin'],userId:'manager'}});
 client.defaults.adapter=async(config:any)=>{calls.push(config);return {data:{code:200,data:config.method==='patch'?{user:{...row,accountType:'internal'},changed:['accountType']}:config.url==='/roles'?[{roleCode:'admin',name:'管理员',enabled:true,builtIn:true,version:1,permissionCodes:[]}]:{content:[row],page:1,size:20,total:1,totalPages:1}},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');const ui=render(<Manager/>);
 try{await waitFor(()=>assert.ok(ui.container.textContent?.includes('合成人员')));assert.ok(ui.container.textContent?.includes('未确认'));fireEvent.click(within(ui.container).getByRole('button',{name:'编辑'}));await waitFor(()=>assert.ok(within(document.body).getByLabelText('账号类型')));const input=within(document.body).getByLabelText('账号类型');fireEvent.mouseDown(input.closest('.ant-select-selector')!);await waitFor(()=>assert.ok(within(document.body).getByText('内部')));fireEvent.click(within(document.body).getByText('内部'));fireEvent.click(within(document.body).getByRole('button',{name:/保\s*存/}));await waitFor(()=>assert.ok(calls.some(c=>c.method==='patch')));assert.equal(JSON.parse(calls.find(c=>c.method==='patch').data).accountType,'internal');await waitFor(()=>assert.equal(within(document.body).queryByRole('dialog'),null));const {message}=await import('antd');await act(async()=>{message.destroy();await new Promise(resolve=>setTimeout(resolve,200));});
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});

test('actual complaint detail mounts the scoped manual followup entry and loads its own endpoint',async()=>{
 const {store,client}=await modules();const Detail=(await vite.ssrLoadModule('/src/views/ComplaintDetail.tsx')).default;const {Routes,Route}=await import('react-router-dom');const original=client.defaults.adapter;const calls:string[]=[];
 store.setState({userInfo:identity(['complaint.read'])});
 client.defaults.adapter=async(config:any)=>{calls.push(config.url);return {data:{code:200,data:config.url==='/complaints/C1/followups'?payload():config.url==='/complaints/C1'?{complaintId:'C1',complaintNo:'C1',title:'Synthetic',sourceAddress:'来源地址',effectiveAddress:'当前地址',address:'当前地址',sourceFieldReasons:{},sourceDeadlineAt:null,sourceCompletedAt:null,sourceSnapshotAt:null,businessTimeSource:'platform_received_at',receivedAt:'2026-10-09T00:00:00Z',locationClues:[],locationConflict:false,content:'合成正文'}:config.url==='/source-status'?{enabled:false,message:'disabled'}:{content:[],total:0}},status:200,statusText:'OK',headers:{},config};};
 const {render,within,waitFor,cleanup}=await import('@testing-library/react');const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/complaints/C1']}><Routes><Route path="/complaints/:id" element={<Detail/>}/></Routes></MemoryRouter>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('合成正文')));assert.ok(within(ui.container).queryByText('人工回访'),'detail must expose the actual manual followup entry');await waitFor(()=>assert.ok(calls.includes('/complaints/C1/followups')));await waitFor(()=>assert.ok(within(ui.container).getByText('备注：原备注')));
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});

for(const scenario of ['success-draft-retry','success-new-pending','conflict-new-pending'] as const)test('write lifecycle round trip preserves current editor/retry/submitting: '+scenario,async()=>{
 const {Panel,store,client}=await modules();const original=client.defaults.adapter;const posts:Array<{config:any;resolve:(v:any)=>void;reject:(e:any)=>void}>=[];let reads=0;
 const response=(config:any,data:any)=>({data:{code:200,data},status:200,statusText:'OK',headers:{},config});
 client.defaults.adapter=async(config:any)=>{if(config.method==='post')return new Promise((resolve,reject)=>{posts.push({config,resolve,reject});if(scenario==='success-draft-retry'&&posts.length===2)reject(new Error('当前操作可重试'));});reads++;return response(config,payload(config.url.includes('C2')?'C2':'C1'));};
 store.setState({userInfo:identity(['complaint.read','followup.create'])});const {render,within,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');const ui=render(<Panel complaintId="C1"/>);
 const open=async()=>{await waitFor(()=>assert.ok(within(ui.container).getByRole('button',{name:'登记回访'})));fireEvent.click(within(ui.container).getByRole('button',{name:'登记回访'}));};
 const save=()=>fireEvent.click(within(ui.container).getByRole('button',{name:'保存回访'}));
 try{await open();save();await waitFor(()=>assert.equal(posts.length,1));
  ui.rerender(<Panel complaintId="C2"/>);await waitFor(()=>assert.ok(ui.container.textContent?.includes('诉求：C2')));ui.rerender(<Panel complaintId="C1"/>);await open();fireEvent.change(within(ui.container).getByLabelText('回访备注'),{target:{value:'当前新草稿'}});save();await waitFor(()=>assert.equal(posts.length,2));
  if(scenario==='success-draft-retry')await waitFor(()=>assert.ok(ui.container.textContent?.includes('当前操作可重试')));
  const readsBefore=reads;await act(async()=>{if(scenario==='conflict-new-pending')posts[0].reject(Object.assign(new Error('旧操作版本冲突'),{response:{status:409,data:{code:'CONFLICT',message:'旧操作版本冲突'}}}));else posts[0].resolve(response(posts[0].config,fact));});
  assert.equal((within(ui.container).getByLabelText('回访备注') as HTMLTextAreaElement).value,'当前新草稿','old result must not close current editor');assert.equal(reads,readsBefore,'old completion must not start a current refresh');assert.equal(ui.container.textContent?.includes('回访记录已保存'),false);assert.equal(ui.container.textContent?.includes('版本或请求内容冲突'),false);
  if(scenario==='success-draft-retry'){assert.ok(ui.container.textContent?.includes('当前操作可重试'));save();await waitFor(()=>assert.equal(posts.length,3));assert.equal(JSON.parse(posts[2].config.data).requestId,JSON.parse(posts[1].config.data).requestId,'old success must not clear current retry key');}
  else {assert.equal(within(ui.container).queryByRole('status'),null,'old result must not replace current notice');assert.equal((within(ui.container).getByLabelText('回访备注') as HTMLTextAreaElement).disabled,true,'old finally must not release current submitting');}
  const current=posts[posts.length-1];assert.notEqual(JSON.parse(current.config.data).requestId,JSON.parse(posts[0].config.data).requestId);await act(async()=>current.resolve(response(current.config,fact)));await waitFor(()=>assert.equal(within(ui.container).queryByLabelText('回访备注'),null));await waitFor(()=>assert.equal(reads,readsBefore+1));assert.ok(ui.container.textContent?.includes('回访记录已保存'),'current success must still refresh normally');
 }finally{await act(async()=>{for(const pending of posts)pending.resolve(response(pending.config,fact));});ui.unmount();cleanup();client.defaults.adapter=original;}
});
