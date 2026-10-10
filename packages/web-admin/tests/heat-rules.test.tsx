import assert from 'node:assert/strict';import test,{before,after} from 'node:test';import React from 'react';import {JSDOM} from 'jsdom';import {createServer,type ViteDevServer} from 'vite';import {fileURLToPath} from 'node:url';import {MemoryRouter} from 'react-router-dom';
import {Simulate} from 'react-dom/test-utils';
let vite:ViteDevServer,dom:JSDOM;const originalChannel=globalThis.MessageChannel;const channels:MessageChannel[]=[];
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}} as any;
before(async()=>{dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Document:dom.window.Document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,localStorage:dom.window.localStorage,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}))Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((element:Element)=>computed(element)) as any;Object.defineProperty(globalThis,'getComputedStyle',{value:dom.window.getComputedStyle,configurable:true});Object.defineProperty(globalThis,'MessageChannel',{value:class extends originalChannel{constructor(){super();channels.push(this);}},configurable:true,writable:true});vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',ssr:{noExternal:['echarts-for-react']},plugins:[{name:'heat-test-chart',enforce:'pre',resolveId(id){if(id==='echarts-for-react')return 'virtual:heat-chart';},load(id){if(id==='virtual:heat-chart')return 'export default function Chart(){return null}';}}],cacheDir:fileURLToPath(new URL('../node_modules/.vite-heat-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});});
after(async()=>{await vite.close();dom.window.close();for(const c of channels){c.port1.close();c.port2.close();}Object.defineProperty(globalThis,'MessageChannel',{value:originalChannel,configurable:true,writable:true});});
test('review1 heat data rejects delayed old authorization and actor responses with identical capabilities',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/HeatmapView.tsx');
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 const permissions=['heatmap.read','statistics.read','dashboard.read'];
 const actor=(userId:string,authorizationVersion:number)=>({userId,authorizationVersion,roles:['custom'],permissions});
 useAppStore.setState({userInfo:actor('ACTOR-A',1)});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const adapter=client.defaults.adapter;
 const pending:{config:any;resolve:(value:any)=>void}[]=[];
 client.defaults.adapter=(config:any)=>new Promise(resolve=>pending.push({config,resolve}));
 const answer=(index:number,code:string)=>{const {config,resolve}=pending[index];resolve({data:{code:200,data:{query:config.params,total:1,unlocatedCount:1,selectionDate:'2026-10-10',dataCutoffAt:'2026-10-10',days:1,nonAdditive:true,grids:[{code,count:1,level:null,reason:'CATEGORY_SELECTION_REQUIRED',coverages:[]}],points:[]}},status:200,statusText:'OK',headers:{},config});};
 const {render,waitFor,act,cleanup}=await import('@testing-library/react');const ui=render(<Page/>);
 try{
  await waitFor(()=>assert.equal(pending.length,1));await act(async()=>answer(0,'OLD-EPOCH'));
  await waitFor(()=>assert.ok(ui.container.textContent?.includes('OLD-EPOCH')));
  await act(async()=>useAppStore.setState({userInfo:actor('ACTOR-A',2)}));
  await waitFor(()=>assert.equal(pending.length,2,'authorization version must invalidate visible data'));
  assert.equal(ui.container.textContent?.includes('OLD-EPOCH'),false);
  await act(async()=>useAppStore.setState({userInfo:actor('ACTOR-A',3)}));
  await waitFor(()=>assert.equal(pending.length,3,'authorization version must invalidate and reload'));
  assert.equal(ui.container.textContent?.includes('OLD-EPOCH'),false);
  await act(async()=>answer(1,'OLD-DELAYED'));assert.equal(ui.container.textContent?.includes('OLD-DELAYED'),false);
  await act(async()=>answer(2,'CURRENT-EPOCH'));await waitFor(()=>assert.ok(ui.container.textContent?.includes('CURRENT-EPOCH')));
  await act(async()=>useAppStore.setState({userInfo:actor('ACTOR-B',3)}));
  await waitFor(()=>assert.equal(pending.length,4,'actor identity must invalidate visible data'));
  assert.equal(ui.container.textContent?.includes('CURRENT-EPOCH'),false);
  await act(async()=>useAppStore.setState({userInfo:actor('ACTOR-C',3)}));
  await waitFor(()=>assert.equal(pending.length,5,'actor identity must invalidate and reload'));
  assert.equal(ui.container.textContent?.includes('CURRENT-EPOCH'),false);
  await act(async()=>answer(3,'PREVIOUS-ACTOR'));assert.equal(ui.container.textContent?.includes('PREVIOUS-ACTOR'),false);
  await act(async()=>answer(4,'CURRENT-ACTOR'));await waitFor(()=>assert.ok(ui.container.textContent?.includes('CURRENT-ACTOR')));
 }finally{ui.unmount();cleanup();client.defaults.adapter=adapter;for(let i=0;i<pending.length;i++)answer(i,'CLEANUP');}
});

test('review1 manager sends displayed saved revision and shows conflict instead of a newer preview',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/HeatRuleManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['heatmap.manage']}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const adapter=client.defaults.adapter;
 const input={ruleId:'REVIEW-DRAFT',category:{majorCode:'fee',minorCode:null,dictionaryVersion:'10'},coefficients:['1','5','10','20','30'],policyId:'P1',policyVersion:1,policy:{},effectiveFrom:'2026-10-10',expectedVersion:0};let received:any;
 client.defaults.adapter=async(config:any)=>{let data:any;if(config.url.endsWith('/categories'))data={dictionaryVersion:'10',items:[]};else if(config.url.endsWith('/preview')){received=typeof config.data==='string'?JSON.parse(config.data):config.data;if(received.expectedVersion!==undefined&&received.expectedVersion!==2)throw Error('草稿版本已变化');data={candidate:true,level:'orange',ruleVersion:'draft:2'};}else data=[{ruleId:input.ruleId,editVersion:1,input,approvalStatus:'unconfirmed'}];return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};};
 const {render,within,waitFor,fireEvent,act,cleanup}=await import('@testing-library/react');const ui=render(<Page/>);
 try{
  const p=within(ui.container);await waitFor(()=>assert.ok(p.getByRole('button',{name:'编辑草稿'})));fireEvent.click(p.getByRole('button',{name:'编辑草稿'}));
  for(const [label,value] of [['样本数量','450'],['样本天数','30']])await act(async()=>{const el=p.getByLabelText(label) as HTMLInputElement;el.value=value;Simulate.change(el);});
  fireEvent.click(p.getByRole('button',{name:'样本预览'}));await waitFor(()=>assert.ok(received));assert.equal(received.expectedVersion,1);
  await waitFor(()=>assert.match(ui.container.textContent??'',/草稿版本已变化/));assert.equal(ui.container.textContent?.includes('orange'),false);
 }finally{ui.unmount();cleanup();client.defaults.adapter=adapter;}
});
test('heat page loads actual aggregate counts and clears stale rows after error/revocation',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/HeatmapView.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['heatmap.read','statistics.read','dashboard.read']}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const adapter=client.defaults.adapter;let failing=false;const calls:any[]=[];client.defaults.adapter=async(config:any)=>{calls.push(config);if(failing)throw Error('Synthetic heat failure');return {data:{code:200,data:{query:config.params,total:2,unlocatedCount:1,selectionDate:'2026-10-10',dataCutoffAt:'2026-10-10',days:30,nonAdditive:true,grids:[{code:'SYNTHETIC-GRID',count:1,level:null,reason:'CATEGORY_SELECTION_REQUIRED',coverages:[]}],points:[]}},status:200,statusText:'OK',headers:{},config};};
 const {render,within,waitFor,fireEvent,act,cleanup}=await import('@testing-library/react');const ui=render(<Page/>);try{
  await waitFor(()=>assert.ok(ui.container.textContent?.includes('SYNTHETIC-GRID'),'heat page did not load actual API'));assert.equal(calls[0].url,'/heatmap/data');assert.equal(calls[0].params.dataset,'ledger');assert.match(ui.container.textContent??'',/未定位/);assert.match(ui.container.textContent??'',/选择类别/);assert.match(ui.container.textContent??'',/非加和/);assert.equal(ui.container.textContent?.includes('设施点位'),false);assert.equal(within(ui.container).queryByRole('button',{name:'管理热力规则'}),null);
  await waitFor(()=>assert.equal(within(ui.container).getByRole('button',{name:/应用统计筛选/}).classList.contains('ant-btn-loading'),false));failing=true;fireEvent.click(within(ui.container).getByRole('button',{name:'应用统计筛选'}));await waitFor(()=>assert.match(ui.container.textContent??'',/Synthetic heat failure/));assert.equal(ui.container.textContent?.includes('SYNTHETIC-GRID'),false);
  await act(async()=>useAppStore.setState({userInfo:{roles:['custom'],permissions:['heatmap.read']}}));assert.equal(ui.container.textContent?.includes('SYNTHETIC-GRID'),false);
 }finally{ui.unmount();cleanup();client.defaults.adapter=adapter;}
});
test('rule manager hides mutation without manage and labels candidates, no approved defaults',async()=>{
 const {existsSync}=await import('node:fs');assert.ok(existsSync(fileURLToPath(new URL('../src/views/HeatRuleManager.tsx',import.meta.url))),'heat rule manager is missing');const {default:Page}=await vite.ssrLoadModule('/src/views/HeatRuleManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['heatmap.read']}});
 const {render,within,cleanup}=await import('@testing-library/react');const ui=render(<Page/>);try{assert.equal(within(ui.container).queryByRole('button',{name:'保存草稿'}),null);}finally{ui.unmount();cleanup();}
});



test('saved draft preview cannot claim unsaved edited coefficients and revoked manager clears state',async()=>{
 const {default:Page}=await vite.ssrLoadModule('/src/views/HeatRuleManager.tsx');const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');useAppStore.setState({userInfo:{roles:['custom'],permissions:['heatmap.manage']}});
 const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');const adapter=client.defaults.adapter;const input={ruleId:'DRAFT-A',category:{majorCode:'fee',minorCode:null,dictionaryVersion:'10'},coefficients:['1','5','10','20','30'],policyId:'P1',policyVersion:1,policy:{anchor:'upper',endpointOwner:'lower',zero:'green',belowFirst:'green',top:'red',day:'shanghai_inclusive',classFallback:'exact_only',noRule:'null',ruleSelection:'query_end'},effectiveFrom:'2026-10-10',expectedVersion:0};
 client.defaults.adapter=async(config:any)=>({data:{code:200,data:config.url.endsWith('/categories')?{dictionaryVersion:'10',items:[{code:'fee',label:'Synthetic fee',parentCode:null}]}:config.url.endsWith('/preview')?{candidate:true,level:'orange',ruleVersion:'draft:1'}:[{ruleId:'DRAFT-A',editVersion:1,input,approvalStatus:'unconfirmed'}]},status:200,statusText:'OK',headers:{},config});
 const {render,within,waitFor,fireEvent,act,cleanup}=await import('@testing-library/react');const ui=render(<Page/>);try{const p=within(ui.container);await waitFor(()=>assert.ok(p.getByRole('button',{name:'编辑草稿'})));fireEvent.click(p.getByRole('button',{name:'编辑草稿'}));
  for(const [label,value] of [['样本数量','450'],['样本天数','30']])await act(async()=>{const el=p.getByLabelText(label) as HTMLInputElement;el.value=value;Simulate.change(el);});fireEvent.click(p.getByRole('button',{name:'样本预览'}));await waitFor(()=>assert.match(ui.container.textContent??'',/orange/));
  await act(async()=>{const el=p.getByLabelText('绿系数') as HTMLInputElement;el.value='2';Simulate.change(el);});assert.equal((p.getByRole('button',{name:'样本预览'}) as HTMLButtonElement).disabled,true,'unsaved editor must not preview different persisted coefficients');assert.equal(ui.container.textContent?.includes('orange'),false);
  await act(async()=>useAppStore.setState({userInfo:{roles:['custom'],permissions:[]}}));assert.equal(ui.container.textContent?.includes('DRAFT-A'),false);
 }finally{ui.unmount();cleanup();client.defaults.adapter=adapter;}
});
