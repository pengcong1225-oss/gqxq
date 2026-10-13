import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import React from 'react';
import {MemoryRouter} from 'react-router-dom';
import {JSDOM} from 'jsdom';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
let vite:ViteDevServer,dom:JSDOM;
before(async()=>{
 dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
 const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((e:Element)=>computed(e)) as any;Object.defineProperty(globalThis,'getComputedStyle',{value:dom.window.getComputedStyle,configurable:true});
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-location-workbench',import.meta.url)),server:{middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();});
async function fixture(){
 const {default:Page}=await vite.ssrLoadModule('/src/views/AddressCorrection.tsx'),{default:client}=await vite.ssrLoadModule('/src/api/request.ts'),{useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
 useAppStore.setState({token:null,userInfo:{userId:'reviewer',username:'reviewer',roles:['custom'],permissions:['complaint.read','complaint.correct'],authorizationVersion:1,mustChangePassword:false}});
 const original=client.defaults.adapter,writes:any[]=[];let saved=false;
 const detail=(id:string)=>({id:id==='C1'?1:2,complaintId:id,complaintNo:'SQ-'+id,title:id==='C1'?'合成花园供水问题':'第二条诉求',content:id==='C1'?'合成花园发生停水':'第二条诉求正文',districtCode:'D1',districtName:'合成区',address:'合成花园',locationLng:null,locationLat:null,editVersion:saved?2:1,adminGridCode:'A1',communityCode:'X1',locationCoordinateSystem:null,locationCoordinateSource:null,locationClues:[],locationConflict:false,addressCandidate:null});
 client.defaults.adapter=async(config:any)=>{
  let data:any;
  if(config.method==='post'){writes.push({url:config.url,body:JSON.parse(config.data)});saved=true;data={version:2,analysisEntered:false,analysisReason:'等待最终处理结果',location:{districtCode:'D1',districtName:'合成区',address:'合成花园',longitude:null,latitude:null,adminGridCode:'A1',communityCode:'X1',coordinateSystem:null,coordinateSource:null},validationDate:'2026-10-13',spatialStatus:'unknown',spatialReason:'尚无坐标',coverageEvidence:[],candidates:[]};}
  else if(config.url==='/corrections/pending-complaints')data={content:['C1','C2'].map(id=>({complaintId:id,complaintNo:'SQ-'+id,title:detail(id).title,pendingCount:4,hasDispatch:true})),total:2};
  else if(config.url.endsWith('/location-correction-options'))data={districts:[{code:'D1',name:'合成区'}],adminGrids:[{code:'A1',name:'合成网格',districtCode:'D1'}],communities:[{code:'X1',name:'合成花园',adminGridCode:'A1'}]};
  else if(config.url.endsWith('/corrections')){const id=config.url.split('/')[2];data=['address','location_lng','location_lat','district_name','summary'].map((fieldName,i)=>({id:i+1,correctionId:id+'-'+fieldName,complaintId:id,fieldName,fieldLabel:fieldName,oldValue:fieldName==='address'?'合成花园':null,effectiveValue:fieldName==='address'?'合成花园':null,status:saved&&id==='C1'&&fieldName!=='summary'?'confirmed':'pending',hasDispatch:true,editVersion:saved?2:1}));}
  else if(config.url.startsWith('/complaints/'))data=detail(config.url.split('/')[2]);else data={content:[],total:0};
  return {status:200,statusText:'OK',headers:{},config,data:{code:200,data}};
 };
 const testing=await import('@testing-library/react');const ui=testing.render(<MemoryRouter initialEntries={['/address-correction?complaintId=C1']}><Page/></MemoryRouter>);
 return {...testing,ui,writes,finish:()=>{ui.unmount();testing.cleanup();client.defaults.adapter=original;}};
}
test('location review is inline and successful confirmation advances to actual next complaint',async()=>{
 const f=await fixture();try{
  const body=f.within(document.body);
  await f.waitFor(()=>assert.ok(body.getByText('系统建议：合成花园')),{timeout:10000});
  await f.waitFor(()=>assert.equal((body.getByRole('button',{name:'确认位置并下一条'}) as HTMLButtonElement).disabled,false),{timeout:10000});
  assert.equal(body.queryByRole('button',{name:'打开位置组纠偏'}),null);
  assert.equal(document.querySelectorAll('.ant-modal').length,0);
  f.fireEvent.click(body.getByRole('button',{name:'确认位置并下一条'}));
  await f.waitFor(()=>assert.equal(f.writes.length,1));
  assert.equal(f.writes[0].url,'/complaints/C1/location-corrections');
  assert.equal(f.writes[0].body.communityCode,'X1');assert.equal(f.writes[0].body.expectedVersion,1);
  await f.waitFor(()=>assert.match(document.querySelector('.ant-drawer-title')?.textContent??'',/SQ-C2/));
 }finally{f.finish();}
});
