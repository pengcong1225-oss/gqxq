const boundedPause=(setRelease:(release:()=>void)=>void)=>{let timer:ReturnType<typeof setTimeout>;return new Promise<void>(resolve=>{setRelease(resolve);timer=setTimeout(resolve,15000);timer.unref();}).finally(()=>clearTimeout(timer));};
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

test('late A refresh cannot overwrite B with equal codes and versions or write A values into B',async()=>{
 const {default:Manager}=await vite.ssrLoadModule('/src/views/DictManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];
 const user={userId:'actor-A',authorizationVersion:1,roles:['custom'],permissions:['system.dict.manage'],mustChangePassword:false};useAppStore.setState({token:'actor-A-token',userInfo:user});
 const types=['complaint_category','B'].map(code=>({code,name:code==='B'?'字典B':'字典A',version:4,published:true,status:'enabled',readOnly:false,fixedCodes:false}));
 const result=(code:string)=>({type:types.find(t=>t.code===code),items:[{itemId:code+'-shared',code:'shared',label:code==='B'?'B条目':'A条目',parentCode:null,version:2,status:'enabled',sort:0,published:true}]});
 let delay=false,release:(()=>void)|undefined;
 client.defaults.adapter=async(config:any)=>{calls.push(config);const data=config.url==='/dict-types'?types:config.url.includes('/B/')?result('B'):result('complaint_category');if(delay&&config.method==='get'&&config.url==='/dict-types/complaint_category/items'){delay=false;await boundedPause(r=>release=r);}return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');const ui=render(<Manager/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('A条目')));delay=true;fireEvent.click(within(ui.container).getByRole('button',{name:'刷新字典'}));await waitFor(()=>assert.ok(release));fireEvent.click(within(ui.container).getByRole('tab',{name:'字典B'}));await waitFor(()=>assert.ok(within(ui.container).getByText('B条目')));await act(async()=>release!());await waitFor(()=>assert.equal(Boolean(within(ui.container).queryByText('A条目')),false));
  fireEvent.click(within(ui.container).getByRole('button',{name:'编辑条目'}));await waitFor(()=>assert.ok(within(document.body).getByLabelText('条目标签')));fireEvent.change(within(document.body).getByLabelText('条目标签'),{target:{value:'B已核实'}});fireEvent.click(within(document.body).getByRole('button',{name:'保存条目'}));await waitFor(()=>assert.ok(calls.some(c=>c.method==='patch')));const sent=calls.find(c=>c.method==='patch');assert.equal(sent.url,'/dict-types/B/items/shared');assert.equal(JSON.parse(sent.data).label,'B已核实');assert.equal(JSON.parse(sent.data).expectedVersion,2);assert.equal(JSON.parse(sent.data).expectedTypeVersion,4);
 }finally{release?.();ui.unmount();cleanup();client.defaults.adapter=original;}
});

test('dictionary same-capability actor refresh discards old responses and editor ownership',async()=>{
 const {default:Manager}=await vite.ssrLoadModule('/src/views/DictManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;
 const user={userId:'actor-A',authorizationVersion:1,roles:['custom'],permissions:['system.dict.manage'],mustChangePassword:false};useAppStore.setState({token:'A-token',userInfo:user});
 const type={code:'complaint_category',name:'正式大小类',version:4,published:true,status:'enabled',readOnly:false,fixedCodes:false};let delay=false,release:(()=>void)|undefined;
 client.defaults.adapter=async(config:any)=>{const label=useAppStore.getState().userInfo.userId==='actor-A'?'A私有条目':'B授权条目';if(delay&&config.url.endsWith('/items')){delay=false;await boundedPause(r=>release=r);}return {data:{code:200,data:config.url==='/dict-types'?[type]:{type,items:[{itemId:'same',code:'same',label,version:2,status:'enabled',sort:0,published:true}]}},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');const ui=render(<Manager/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('A私有条目')));fireEvent.click(within(ui.container).getByRole('button',{name:'编辑条目'}));delay=true;fireEvent.click(within(ui.container).getByRole('button',{name:'刷新字典'}));await waitFor(()=>assert.ok(release));await act(async()=>useAppStore.setState({token:'B-token',userInfo:{...user,userId:'actor-B',authorizationVersion:2}}));await waitFor(()=>assert.ok(within(ui.container).getByText('B授权条目')));await act(async()=>release!());assert.equal(document.body.textContent?.includes('A私有条目'),false);assert.equal(within(document.body).queryByRole('button',{name:'保存条目'}),null);
 }finally{release?.();ui.unmount();cleanup();client.defaults.adapter=original;}
});

test('an earlier save response cannot close a later editor action in the same dictionary',async()=>{
 const {default:Manager}=await vite.ssrLoadModule('/src/views/DictManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;
 useAppStore.setState({token:'action-token',userInfo:{userId:'action-user',authorizationVersion:1,roles:['custom'],permissions:['system.dict.manage'],mustChangePassword:false}});
 const type={code:'complaint_category',name:'正式大小类',version:4,published:true,status:'enabled',readOnly:false,fixedCodes:false};const items=['first','second'].map(code=>({itemId:code,code,label:code,version:2,status:'enabled',sort:0,published:true}));let release:(()=>void)|undefined;
 client.defaults.adapter=async(config:any)=>{if(config.method==='patch')await boundedPause(r=>release=r);return {data:{code:200,data:config.url==='/dict-types'?[type]:{type,items}},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');const ui=render(<Manager/>);
 try{await waitFor(()=>assert.equal(within(ui.container).getAllByRole('button',{name:'编辑条目'}).length,2));fireEvent.click(within(ui.container).getAllByRole('button',{name:'编辑条目'})[0]);fireEvent.click(within(document.body).getByRole('button',{name:'保存条目'}));await waitFor(()=>assert.ok(release));fireEvent.click(within(document.body).getByRole('button',{name:/Cancel|取\s*消/}));fireEvent.click(within(ui.container).getAllByRole('button',{name:'编辑条目'})[1]);await waitFor(()=>assert.equal((within(document.body).getByLabelText('条目标签') as HTMLInputElement).value,'second'));await act(async()=>release!());assert.ok(within(document.body).getByRole('button',{name:'保存条目'}));assert.equal((within(document.body).getByLabelText('条目标签') as HTMLInputElement).value,'second');
 }finally{release?.();ui.unmount();cleanup();client.defaults.adapter=original;}
});

test('creating a dictionary refreshes the new selected type rather than the old captured tab',async()=>{
 const {default:Manager}=await vite.ssrLoadModule('/src/views/DictManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;const calls:any[]=[];
 useAppStore.setState({token:'create-token',userInfo:{userId:'create-user',authorizationVersion:1,roles:['custom'],permissions:['system.dict.manage'],mustChangePassword:false}});
 const types=[{code:'complaint_category',name:'正式大小类',version:1,published:true,status:'enabled',readOnly:false,fixedCodes:false}];
 client.defaults.adapter=async(config:any)=>{calls.push(config);if(config.method==='post')types.push({...types[0],code:'NEW',name:'新增字典',published:false});const code=config.url.includes('/NEW/')?'NEW':'complaint_category';return {data:{code:200,data:config.url==='/dict-types'?types:{type:types.find(t=>t.code===code),items:[]}},status:200,statusText:'OK',headers:{},config};};
 const {render,within,fireEvent,waitFor,cleanup}=await import('@testing-library/react');const ui=render(<Manager/>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByRole('button',{name:'新增字典项'})));fireEvent.click(within(ui.container).getByRole('button',{name:'新增字典类型'}));fireEvent.change(within(document.body).getByLabelText('类型编码'),{target:{value:'NEW'}});fireEvent.change(within(document.body).getByLabelText('类型名称'),{target:{value:'新增字典'}});fireEvent.click(within(document.body).getByRole('button',{name:'保存类型'}));await waitFor(()=>assert.ok(calls.some(c=>c.url==='/dict-types/NEW/items')));await waitFor(()=>assert.equal(within(ui.container).getByRole('tab',{name:'新增字典'}).getAttribute('aria-selected'),'true'));
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
