import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {JSDOM} from 'jsdom';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer,type ViteDevServer} from 'vite';
let vite:ViteDevServer;
let React:typeof import('react');
let MemoryRouter:typeof import('react-router-dom')['MemoryRouter'];
// DOM must precede importing react-dom/client; otherwise React selects the legacy
// input polyfill and fireEvent.change cannot exercise the textarea event handler.
before(async()=>{
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,
 Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,
 MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}};
 for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false;}})) as typeof dom.window.matchMedia;
 const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((element:Element)=>computed(element)) as typeof dom.window.getComputedStyle;
 Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,writable:true,value:dom.window.getComputedStyle});
 React=await import('react');({MemoryRouter}=await import('react-router-dom'));
 const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
 vite=await createServer({root,cacheDir:path.join(root,'node_modules','.vite-alert-ui-test'),appType:'custom',server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();});

test('真实主账预警可查看证据诉求并保存有依据的处理记录', async () => {
  const {default:request}=await vite.ssrLoadModule('/src/api/request.ts');
  const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
  const originalAdapter=request.defaults.adapter,originalUser=useAppStore.getState().userInfo;
  const writes:unknown[]=[];
  const row={alertId:'A1',ruleId:'R1',ruleVersion:2,from:'2026-11-01',to:'2026-11-10',enterpriseCode:'E1',districtCode:'D1',adminGridCode:'G1',quantity:3,threshold:2,state:'open',createdAt:'2026-11-10T04:00:00Z',scene:'gas_three_piece',ruleName:'真实燃气规则',definitionBasis:'经确认分类映射',complaintIds:['CPL-TEST'],dataCutoffAt:'2026-11-10T04:00:00Z'};
  request.defaults.adapter=async(config:{url:string;method:string;data?:string})=>{
    let data:unknown;
    if(config.url==='/business-alerts')data=[row];
    else if(config.url==='/business-alerts/A1/history')data=[];
    else if(config.url==='/business-alerts/A1/actions'){writes.push(JSON.parse(config.data!));row.state='acknowledged';data={state:row.state};}
    else throw Error('Unexpected test API '+config.url);
    return {data:{code:200,data},status:200,headers:{},config};
  };
  useAppStore.setState({userInfo:{id:1,userId:'tester',username:'tester',realName:'经办',roles:['handler'],permissions:['alert.read','alert.handle','complaint.read']}});
  const {default:DataAlerts}=await vite.ssrLoadModule('/src/views/DataAlerts.tsx');
  const {render,within,fireEvent,waitFor,cleanup}=await import('@testing-library/react');
  const ui=render(React.createElement(MemoryRouter,null,React.createElement(DataAlerts)));
  try{
    const page=within(document.body);await page.findByText('真实燃气规则');
    fireEvent.click(page.getByRole('button',{name:'详情'}));
    const evidence=await page.findByRole('link',{name:'CPL-TEST'});assert.equal(evidence.getAttribute('href'),'/complaints/CPL-TEST');
    fireEvent.click(page.getByRole('button',{name:'Close'}));
    fireEvent.click(page.getByRole('button',{name:'确 认',exact:true}));
    const modal=within(await page.findByRole('dialog',{name:'确认预警'}));
    assert.equal((modal.getByRole('button',{name:'保存处理记录'}) as HTMLButtonElement).disabled,true);
    fireEvent.change(modal.getByRole('textbox',{name:'预警处理说明'}),{target:{value:'已核查来源和分类，转业务办理'}});
    fireEvent.click(modal.getByRole('button',{name:'保存处理记录'}));
    await waitFor(()=>assert.deepEqual(writes,[{action:'acknowledge',notes:'已核查来源和分类，转业务办理'}]));
    assert.match(document.body.textContent??'',/真实诉求总账中来源明确办结/);
    fireEvent.click(page.getByRole('button',{name:'详情'}));
    await page.findByRole('link',{name:'CPL-TEST'});
    const {act}=await import('@testing-library/react');
    await act(async()=>useAppStore.setState({userInfo:{id:2,userId:'other',username:'other',realName:'另一账号',roles:['readonly'],permissions:[]}}));
    assert.equal(page.queryByRole('link',{name:'CPL-TEST'}),null);
    assert.doesNotMatch(document.body.textContent??'',/真实燃气规则|经确认分类映射|CPL-TEST/);

  }finally{ui.unmount();cleanup();request.defaults.adapter=originalAdapter;useAppStore.setState({userInfo:originalUser});}
});
