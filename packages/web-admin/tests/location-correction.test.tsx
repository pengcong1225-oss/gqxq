import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import React from 'react';import {MemoryRouter} from 'react-router-dom';import {JSDOM} from 'jsdom';import {createServer,type ViteDevServer} from 'vite';import {message} from 'antd';import {Simulate} from 'react-dom/test-utils';
let vite:ViteDevServer;
before(async()=>{
 globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}} as any;
 vite=await createServer({root:path.resolve(fileURLToPath(new URL('..',import.meta.url))),appType:'custom',server:{middlewareMode:true,hmr:false}});
 await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}))Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
 const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((e:Element)=>computed(e)) as any;Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,writable:true,value:dom.window.getComputedStyle});
});after(async()=>{await vite.close();});
for(const scenario of ['manual','conflict','denied'] as const)test('location group UI '+scenario,async()=>{
 const {default:request}=await vite.ssrLoadModule('/src/api/request.ts'),oldAdapter=request.defaults.adapter;
 const writes:any[]=[];let refreshed=false;
 request.defaults.adapter=async(config:any)=>{
  let data:any;
  if(config.method==='post'){
   writes.push({url:config.url,body:JSON.parse(config.data)});
   if(scenario==='conflict'){refreshed=true;const error:any=new Error('Synthetic 409');error.response={status:409,data:{code:'DUPLICATE_CONFLICT',message:'Synthetic 409'}};throw error;}
   data={version:2,analysisEntered:false,validationDate:'2026-10-09',spatialStatus:'unknown',spatialReason:'坐标系未核实',coverageEvidence:[],candidates:[]};
  }else if(config.url.endsWith('/location-correction-options'))data={districts:[{code:'D1',name:'合成区甲'}],adminGrids:[{code:'A1',name:'同名网格',districtCode:'D1'},{code:'A2',name:'同名网格',districtCode:'D1'}],communities:[{code:'X1',name:'同名小区',adminGridCode:'A1'},{code:'X2',name:'同名小区',adminGridCode:'A2'}]};
  else if(config.url==='/complaints/C1/corrections')data=['address','location_lng','location_lat','district_name'].map((fieldName,i)=>({id:i+1,correctionId:'COR-'+fieldName,complaintId:'C1',fieldName,fieldLabel:fieldName,oldValue:'old',effectiveValue:fieldName==='address'?refreshed?'winning address':'current address':fieldName==='location_lng'?'111':fieldName==='location_lat'?'30':'合成区甲',status:'pending',hasDispatch:false,editVersion:refreshed?2:1}));
  else if(config.url==='/complaints/C1')data={complaintId:'C1',complaintNo:'LOCAL-C1',title:'Synthetic',districtCode:'D1',districtName:'合成区甲',address:'current address',locationLng:111,locationLat:30,editVersion:1,adminGridCode:null,communityCode:null,locationCoordinateSystem:'unknown',locationCoordinateSource:null,locationClues:[],locationConflict:false};
  else data={content:[],total:0};
  return {data:{code:200,data},status:200,headers:{},config};
 };
 const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts'),oldUser=useAppStore.getState().userInfo;
 useAppStore.setState({userInfo:{id:1,userId:'synthetic',username:'synthetic',roles:['custom'],permissions:scenario==='denied'?['complaint.read']:['complaint.read','complaint.correct']}});
 const {default:Page}=await vite.ssrLoadModule('/src/views/AddressCorrection.tsx');const {render,within,fireEvent,waitFor,act,cleanup}=await import('@testing-library/react');
 const ui=render(<MemoryRouter initialEntries={['/address-correction?complaintId=C1']}><Page/></MemoryRouter>);
 try{
  const page=within(document.body);await waitFor(()=>assert.ok(page.getAllByText('LOCAL-C1').length));
  if(scenario==='denied'){assert.equal(Boolean(page.queryByRole('button',{name:'打开位置组纠偏'})),false);assert.equal(writes.length,0);return;}
  fireEvent.click(await waitFor(()=>page.getByRole('button',{name:'打开位置组纠偏'})));
  await waitFor(()=>assert.ok(page.getByRole('combobox',{name:'位置组区划'})));
  assert.match(document.body.textContent??'',/人工录入/);assert.equal((document.body.textContent??'').includes('VITE_TIANDITU'),false);
  const address=page.getByLabelText('位置组地址') as HTMLInputElement,basis=page.getByLabelText('位置组依据') as HTMLTextAreaElement;
  await act(async()=>{address.value='manual draft B';Simulate.change(address);basis.value='Synthetic manual verification';Simulate.change(basis);});
  fireEvent.click(page.getByRole('button',{name:'保存位置组'}));await waitFor(()=>assert.equal(writes.length,1));
  assert.equal(writes[0].url,'/complaints/C1/location-corrections');assert.equal(writes[0].body.expectedVersion,1);assert.equal(writes[0].body.coordinateSystem,'unknown');assert.equal(writes[0].body.address,'manual draft B');assert.equal(writes[0].body.districtCode,'D1');assert.equal(writes[0].body.adminGridCode,null);assert.ok(writes[0].body.coordinateSource);
  if(scenario==='conflict'){
   await waitFor(()=>assert.match(document.body.textContent??'',/未提交内容已保留/));assert.equal(address.value,'manual draft B');assert.equal(basis.value,'Synthetic manual verification');
   fireEvent.click(page.getAllByRole('button',{name:'刷新核对（保留草稿）'}).at(-1)!);await waitFor(()=>assert.match(document.body.textContent??'',/winning address/));assert.equal(address.value,'manual draft B');assert.equal(basis.value,'Synthetic manual verification');assert.equal(writes.length,1);
  }else await waitFor(()=>assert.equal(page.queryByLabelText('位置组地址'),null));
 }finally{await act(async()=>{message.destroy();ui.unmount();cleanup();});request.defaults.adapter=oldAdapter;useAppStore.setState({userInfo:oldUser});}
});
test('Tianditu synthetic search retains same-name candidates with unknown CRS provenance',async()=>{
 const {searchTiandituPlaces}=await vite.ssrLoadModule('/src/components/TiandituLocationPicker.tsx');
 const result=await searchTiandituPlaces('Synthetic','synthetic-unused-key',async()=>({ok:true,json:async()=>({pois:[{name:'同名',address:'合成甲',lonlat:'111,30'},{name:'同名',address:'合成乙',lonlat:'112,31'}]})}));
 assert.equal(result.length,2);assert.deepEqual(result.map((v:any)=>v.coordinateSystem),['unknown','unknown']);assert.ok(result.every((v:any)=>v.coordinateSource));
});
