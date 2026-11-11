import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

test('manager offers empty coefficients, live tender preview and one save with actual effective date',async()=>{
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const key of ['window','document','HTMLElement','Element','SVGElement','Node','ShadowRoot','localStorage','MutationObserver'])globalThis[key]=key==='window'?dom.window:dom.window[key];
 Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
 const getStyle=dom.window.getComputedStyle.bind(dom.window);
 dom.window.getComputedStyle=(element)=>getStyle(element);globalThis.getComputedStyle=dom.window.getComputedStyle;
 dom.window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom'});
 try{
  const React=(await import('react')).default;
  const {MemoryRouter}=await import('react-router-dom');
  const {render,fireEvent,waitFor,cleanup}=await import('@testing-library/react');
  const {default:Manager}=await vite.ssrLoadModule('/src/views/HeatRuleManager.tsx');
  const {default:request}=await vite.ssrLoadModule('/src/api/request.ts');
  const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
  useAppStore.setState({userInfo:{permissions:['heatmap.manage'],roles:['admin']}});
  const writes=[];
  request.defaults.adapter=async config=>{
   let data;
   if(config.url==='/heat-rules/categories')data={dictionaryVersion:'1',items:[{code:'water',label:'供水',parentCode:null}]};
   else if(config.method==='get')data=[];
   else {const input=JSON.parse(config.data);writes.push(input);data={ruleId:'HR-1',editVersion:2,version:'HEAT-1',effectiveFrom:'2099-11-11',approvalStatus:'confirmed',input:{...input,ruleId:'HR-1',policyId:'TENDER_1_1_9_V1',policyVersion:1,effectiveFrom:'2099-11-11'}};}
   return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};
  };
  const view=render(React.createElement(MemoryRouter,{future:{v7_startTransition:true,v7_relativeSplatPath:true}},React.createElement(Manager)));
  await waitFor(()=>assert.equal(view.getByLabelText('诉求大类').options.length,2));
  for(const name of ['绿','蓝','黄','橙','红'])assert.equal(view.getByLabelText(name+'色系数').value,'');
  assert.equal(view.getByText('保存规则').closest('button').disabled,true);
  assert.equal(view.queryByText('系数锚点'),null);assert.equal(view.queryByText('政策编码'),null);
  fireEvent.change(view.getByLabelText('诉求大类'),{target:{value:'water'}});
  for(const [i,name] of ['绿','蓝','黄','橙','红'].entries())fireEvent.change(view.getByLabelText(name+'色系数'),{target:{value:['1','5','10','20','30'][i]}});
  assert.ok(view.getByText('橙色 · 450 件'));
  fireEvent.change(view.getByLabelText('预览诉求量'),{target:{value:'300'}});assert.ok(view.getByText('黄色 · 300 件'));
  fireEvent.click(view.getByText('保存规则'));
  await waitFor(()=>assert.ok(view.getByText(/规则已保存，将用于统计结束日在 2099-11-11/)));
  assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0]).sort(),['category','coefficients','expectedVersion']);
  await React.act(async()=>{useAppStore.setState({userInfo:{userId:'other-manager',authorizationVersion:2,permissions:['heatmap.manage'],roles:['admin']}});});
  await waitFor(()=>assert.equal(view.getByLabelText('绿色系数').value,''));
  assert.equal(view.queryByText(/规则已保存，将用于统计结束日在/),null);
  cleanup();
 }finally{await vite.close();dom.window.close();}
});
