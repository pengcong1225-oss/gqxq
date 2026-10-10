import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import React from 'react';
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;
let useLocation: typeof import('react-router-dom').useLocation;
import {JSDOM} from 'jsdom';
import {createServer, type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
const storage = new Map<string,string>();
globalThis.localStorage = {getItem:k=>storage.get(k)??null,setItem:(k,v)=>{storage.set(k,v);},removeItem:k=>{storage.delete(k);}} as Storage;
let vite:ViteDevServer;
let dom:JSDOM;
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
  Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,
  Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true,
  ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}})) Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
 const computed=dom.window.getComputedStyle.bind(dom.window);
 dom.window.getComputedStyle=((element:Element)=>computed(element)) as any;
 Object.defineProperty(globalThis,'getComputedStyle',{value:dom.window.getComputedStyle,configurable:true});
 ({MemoryRouter,useLocation}=await import('react-router-dom'));
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-account-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();});
test('forced initial password redirects business URL to own password form',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 useAppStore.setState({token:'synthetic-token',userInfo:{id:1,userId:'u',username:'u',realName:'测试',roles:['readonly'],permissions:['dashboard.read'],mustChangePassword:true,authorizationVersion:1}});
 const {default:App}=await vite.ssrLoadModule('/src/App.tsx');
 const {render,within,cleanup,waitFor}=await import('@testing-library/react');
 const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/dashboard']}><App/></MemoryRouter>);
 try{await waitFor(()=>assert.ok(within(ui.container).getByText('修改口令')));assert.ok(within(ui.container).getByLabelText('当前口令'));assert.ok(within(ui.container).getByLabelText('新口令'));}finally{ui.unmount();cleanup();}
});
test('custom permissions govern button access and empty authorization never writes',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const {useWriteAccess}=await vite.ssrLoadModule('/src/stores/roleAccess.tsx');
 const {render,cleanup}=await import('@testing-library/react');
 function Probe(){const access=useWriteAccess('dispatch.create');return <button disabled={!access.can}>创建交办</button>;}
 for(const [roles,permissions,allowed] of [[['analyst'],['dispatch.create'],true],[['handler'],[],false],[[],[],false]] as const){
  useAppStore.setState({userInfo:{roles,permissions,mustChangePassword:false}});
  const ui=render(<Probe/>);
  assert.equal((ui.container.querySelector('button') as HTMLButtonElement).disabled,!allowed);
  ui.unmount();cleanup();
 }
});
test('password form submits API and clears revoked login only after successful change',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const {default:App}=await vite.ssrLoadModule('/src/App.tsx');
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');
 const original=client.defaults.adapter;let calls=0;
 client.defaults.adapter=async(config:any)=>{assert.equal(config.url,'/auth/change-password');const body=JSON.parse(config.data);assert.ok(body.currentPassword);assert.ok(body.newPassword);calls++;return {data:{code:200,data:{changed:true}},status:200,statusText:'OK',headers:{},config};};
 useAppStore.setState({token:'synthetic-token',userInfo:{id:1,userId:'u',username:'u',realName:'测试',roles:['readonly'],permissions:[],mustChangePassword:true,authorizationVersion:1}});
 const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');
 const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={['/change-password']}><App/></MemoryRouter>);
 try{
  const page=within(ui.container);
  fireEvent.change(page.getByLabelText('当前口令'),{target:{value:'Synthetic-Initial-1'}});
  fireEvent.change(page.getByLabelText('新口令'),{target:{value:'Synthetic-Changed-2'}});
  fireEvent.change(page.getByLabelText('确认新口令'),{target:{value:'Synthetic-Changed-2'}});
  fireEvent.submit(ui.container.querySelector('form')!);
  await waitFor(()=>assert.equal(calls,1));await waitFor(()=>assert.equal(useAppStore.getState().token,null));
  await waitFor(()=>assert.ok(page.getByPlaceholderText('用户名')));
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;}
});
test('login after completed password change ignores stale password return route and preserves business return',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const {default:App}=await vite.ssrLoadModule('/src/App.tsx');
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');
 const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');
 const original=client.defaults.adapter;
 function Path(){return <output data-testid="route-path">{useLocation().pathname}</output>;}
 try{
  for(const [from,forced,expected] of [['/change-password',false,'/dashboard'],['/change-password/?old=1',false,'/dashboard'],['/system/roles',false,'/system/roles'],['/system/roles',true,'/change-password']] as const){
   const user={id:1,userId:'u',username:'u',realName:'测试',roles:['readonly'],permissions:[],mustChangePassword:forced,authorizationVersion:2};
   client.defaults.adapter=async(config:any)=>({data:{code:200,data:config.url==='/auth/login'?{token:'new-session',userInfo:user}:config.url==='/auth/user-info'?user:[]},status:200,statusText:'OK',headers:{},config});
   useAppStore.setState({token:null,userInfo:null});localStorage.removeItem('token');
   const ui=render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}} initialEntries={[{pathname:'/login',state:{from}}]}><App/><Path/></MemoryRouter>);
   try{const page=within(ui.container);fireEvent.change(page.getByPlaceholderText('用户名'),{target:{value:'u'}});fireEvent.change(page.getByPlaceholderText('密码'),{target:{value:'Synthetic-Changed-2'}});fireEvent.submit(ui.container.querySelector('form')!);await waitFor(()=>assert.equal(page.getByTestId('route-path').textContent,expected));if(!forced)assert.equal(page.queryByLabelText('当前口令'),null);}finally{ui.unmount();cleanup();}
  }
 }finally{client.defaults.adapter=original;useAppStore.setState({token:null,userInfo:null});localStorage.removeItem('token');}
});

test('role manager creates a configured business role and excludes protected administrator grants',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const {default:RoleManager}=await vite.ssrLoadModule('/src/views/RoleManager.tsx');
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;let created=false;
 useAppStore.setState({token:'synthetic-token',userInfo:{roles:['admin'],permissions:['system.roles.manage'],mustChangePassword:false}});
 client.defaults.adapter=async(config:any)=>{
  let data:any=[];
  if(config.url==='/permissions')data=[{code:'complaint.read',name:'诉求查询',protected:false},{code:'system.users.manage',name:'平台账号管理',protected:true}];
  else if(config.url==='/roles'&&config.method==='post'){const body=JSON.parse(config.data);assert.equal(body.roleCode,'analyst');assert.equal(body.expectedVersion,0);assert.deepEqual(body.permissionCodes,['complaint.read']);created=true;data={...body,version:1};}
  return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};
 };
 const {message}=await import('antd');const success=message.success;message.success=(()=>Promise.resolve()) as any;
 const {render,within,fireEvent,cleanup,waitFor}=await import('@testing-library/react');const ui=render(<RoleManager/>);
 try{
  await waitFor(()=>assert.ok(within(ui.container).getByText('新增角色')));
  fireEvent.click(within(ui.container).getByText('新增角色'));
  const page=within(document.body);await waitFor(()=>assert.ok(page.getByLabelText('角色代码')));
  fireEvent.change(page.getByLabelText('角色代码'),{target:{value:'analyst'}});fireEvent.change(page.getByLabelText('角色名称'),{target:{value:'分析员'}});
  const checkbox=await page.findByRole('checkbox',{name:'诉求查询（complaint.read）'});fireEvent.click(checkbox);
  assert.equal(page.queryByRole('checkbox',{name:/平台账号管理/}),null);
  fireEvent.click(page.getByRole('button',{name:/保 存/}));await waitFor(()=>assert.equal(created,true));
 }finally{ui.unmount();cleanup();client.defaults.adapter=original;message.success=success;}
});
test('user scope editor is available only with current protected account capability',async()=>{
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const {default:UserManager}=await vite.ssrLoadModule('/src/views/UserManager.tsx');
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const original=client.defaults.adapter;
 client.defaults.adapter=async(config:any)=>({data:{code:200,data:config.url==='/roles'?[]:{content:[{userId:'target',username:'target',realName:'虚构',roles:['handler'],roleNames:['经办'],status:1,mustChangePassword:false,createdAt:null,lastLoginAt:null}],total:1,page:1,size:20,totalPages:1}},status:200,statusText:'OK',headers:{},config});
 const {render,within,waitFor,cleanup}=await import('@testing-library/react');
 try{
  useAppStore.setState({userInfo:{roles:['admin'],permissions:['system.users.manage'],mustChangePassword:false}});
  let ui=render(<UserManager/>);await waitFor(()=>assert.ok(within(ui.container).getByText('数据范围')));ui.unmount();cleanup();
  useAppStore.setState({userInfo:{roles:['admin'],permissions:[],mustChangePassword:false}});
  ui=render(<UserManager/>);assert.equal(within(ui.container).queryByText('数据范围'),null);ui.unmount();cleanup();
 }finally{client.defaults.adapter=original;}
});
