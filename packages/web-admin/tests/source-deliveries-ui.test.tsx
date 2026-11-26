import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import type {ComplaintFollowupsView,FollowupView} from '../src/types/api';
let vite:ViteDevServer,dom:JSDOM,render:any,cleanup:any,waitFor:any,fireEvent:any,act:any,request:any,store:any;
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const key of ['window','document','navigator','HTMLElement','Element','SVGElement','Node','ShadowRoot','localStorage','MutationObserver'])Object.defineProperty(globalThis,key,{value:(dom.window as any)[key],configurable:true,writable:true});
 const style=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((el:Element)=>style(el)) as any;globalThis.getComputedStyle=dom.window.getComputedStyle;
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}})) as any;
 (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 ({render,cleanup,waitFor,fireEvent,act}=await import('@testing-library/react'));
 vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),cacheDir:'node_modules/.vite-source-delivery-tests',server:{middlewareMode:true,hmr:false},appType:'custom'});
 request=(await vite.ssrLoadModule('/src/api/request.ts')).default;store=(await vite.ssrLoadModule('/src/stores/appStore.ts')).useAppStore;
});
afterEach(()=>cleanup());after(async()=>{await vite.close();dom.window.close();});
function user(extra:string[]=[]){store.setState({token:'synthetic-session',userInfo:{id:'TEST-USER',username:'测试',roles:['readonly'],permissions:['complaint.read',...extra],mustChangePassword:false}});}
function response(config:any,data:any){return {data:{code:200,data},status:200,statusText:'OK',headers:{},config};}
test('external followup opens persisted revision details and clears rows on identity change',async()=>{
 user();const Component=(await vite.ssrLoadModule('/src/components/SynchronizedFollowups.tsx')).default;
 const row={id:'f1',sourceId:'test',sourceObjectId:'test-f1',sourceVersion:2,payload:{occurredAt:'2026-11-11T08:00:00+08:00',contacted:true,evaluation:'dissatisfied',dissatisfactionReason:'合成回访原因',operatorName:'已脱敏',notes:null}};
 let current=true;
 request.defaults.adapter=async(config:any)=>response(config,config.url==='/synchronized-followups/f1'?{...row,history:[row,{...row,sourceVersion:1}]}:{content:current?[row]:[],total:current?1:0});
 const view=render(<Component complaintId="TEST-C1"/>);await waitFor(()=>assert.ok(view.getByText('合成回访原因')));
 fireEvent.click(view.getByText('查看修订明细'));await waitFor(()=>assert.ok(document.body.textContent?.includes('外部回访修订历史')));
 assert.ok(document.body.textContent?.includes('合成回访原因'));
 current=false;await act(async()=>store.setState({userInfo:{id:'OTHER',username:'其他',roles:['readonly'],permissions:['complaint.read'],mustChangePassword:false}}));
 await waitFor(()=>assert.equal(view.queryByText('合成回访原因'),null));
});

const registeredFollowup:FollowupView={
 followupId:'FUP-1',complaintId:'TEST-C1',ownerId:'FOLLOWUP-ACCOUNT',version:1,order:1,action:'create',
 operatorId:'FOLLOWUP-ACCOUNT',operatorName:' 回访员甲 ',operatorAccount:'callback-login',contacted:true,occurredAt:'2026-11-11T00:00:00Z',
 evaluationCode:'satisfied',dissatisfactionReason:null,notes:null,reason:null,createdAt:'2026-11-11T00:05:00Z',
 revisedAt:'2026-11-11T00:05:00Z',conclusion:null,concludedBy:null,concludedAt:null,
};
const concludedFollowup:FollowupView={
 ...registeredFollowup,version:2,action:'conclude',operatorId:'SUPERVISOR-ACCOUNT',operatorName:'主管乙',operatorAccount:'supervisor-login',
 reason:'确认回访情况',revisedAt:'2026-11-11T00:20:00Z',conclusion:'已核实',
 concludedBy:'SUPERVISOR-ACCOUNT',concludedAt:'2026-11-11T00:20:00Z',
};

async function renderManualFollowups(records:FollowupView[],history:FollowupView[]) {
 user();
 const Component=(await vite.ssrLoadModule('/src/components/ComplaintFollowups.tsx')).default;
 const data:ComplaintFollowupsView={
  complaintId:'TEST-C1',records,history,
  sourceEvaluation:{state:'unavailable',label:null,reason:'暂无来源评价',provenance:'source'},
  formalEvaluation:{state:'unavailable',reason:'暂无正式评价'},
 };
 request.defaults.adapter=async(config:any)=>response(config,data);
 const view=render(<Component complaintId="TEST-C1"/>);
 await waitFor(()=>assert.ok(view.getByText('暂无正式评价')));
 return view;
}

test('人工回访保留首次登记的回访人，主管结论版本另列操作者',async()=>{
 const otherFollowup:FollowupView={
  ...registeredFollowup,followupId:'FUP-2',order:2,ownerId:'OTHER-ACCOUNT',
  operatorId:'OTHER-ACCOUNT',operatorName:'回访员丙',operatorAccount:'other-callback-login',contacted:false,evaluationCode:null,
 };
 const view=await renderManualFollowups([concludedFollowup,otherFollowup],[otherFollowup,concludedFollowup,registeredFollowup]);
 assert.ok(view.getByText(/满意 · 回访人 回访员甲 · 版本 2 · 版本操作者 主管乙/));
 assert.ok(view.getByText(/未接通 · 回访人 回访员丙 · 版本 1/));
 fireEvent.click(view.getByText('查看版本历史（3 条）'));
 const history=view.container.querySelector('details')?.textContent??'';
 assert.match(history,/FUP-1 · 版本 1 · 满意 · 版本操作者 回访员甲/);
 assert.match(history,/FUP-1 · 版本 2 · 满意 · 版本操作者 主管乙/);
 assert.doesNotMatch(view.container.textContent??'',/回访人 主管乙/);
});

test('首次登记姓名为空时显示登记账号，缺名的版本操作者显示操作账号',async()=>{
 const view=await renderManualFollowups(
  [{...concludedFollowup,operatorName:'',operatorAccount:null}],
  [{...registeredFollowup,operatorName:'   ',operatorAccount:null},{...concludedFollowup,operatorName:'',operatorAccount:null}],
 );
 assert.ok(view.getByText(/满意 · 登记账号 FOLLOWUP-ACCOUNT · 版本 2 · 版本操作账号 SUPERVISOR-ACCOUNT/));
 assert.match(view.container.querySelector('details')?.textContent??'',/FUP-1 · 版本 2 · 满意 · 版本操作账号 SUPERVISOR-ACCOUNT/);
});

test('旧回访只展示各版本保存的历史登录账号',async()=>{
 const legacyRegistration={...registeredFollowup,operatorName:'',operatorAccount:'old-callback-login'};
 const legacyConclusion={...concludedFollowup,operatorName:'',operatorAccount:'old-supervisor-login'};
 const view=await renderManualFollowups([legacyConclusion],[legacyRegistration,legacyConclusion]);
 assert.ok(view.getByText(/满意 · 登记账号 old-callback-login · 版本 2 · 版本操作账号 old-supervisor-login/));
 const history=view.container.querySelector('details')?.textContent??'';
 assert.match(history,/FUP-1 · 版本 1 · 满意 · 版本操作账号 old-callback-login/);
 assert.match(history,/FUP-1 · 版本 2 · 满意 · 版本操作账号 old-supervisor-login/);
});

test('旧接口在姓名字段返回登录账号时按账号展示',async()=>{
 const legacyRegistration={...registeredFollowup,operatorName:'old-callback-login',operatorAccount:undefined};
 const legacyConclusion={...concludedFollowup,operatorName:'old-supervisor-login',operatorAccount:undefined};
 const view=await renderManualFollowups([legacyConclusion],[legacyRegistration,legacyConclusion]);
 assert.ok(view.getByText(/满意 · 登记账号 old-callback-login · 版本 2 · 版本操作账号 old-supervisor-login/));
 assert.doesNotMatch(view.container.textContent??'',/回访人 old-callback-login|版本操作者 old-supervisor-login/);
});

test('缺少首次登记历史的存量回访按归属账号展示，初始版本可直接取登记姓名',async()=>{
 const firstVersion:FollowupView={
  ...registeredFollowup,followupId:'FUP-2',order:2,ownerId:'OTHER-ACCOUNT',
  operatorId:'OTHER-ACCOUNT',operatorName:'回访员丙',operatorAccount:'other-callback-login',contacted:false,evaluationCode:null,
 };
 const view=await renderManualFollowups([concludedFollowup,firstVersion],[concludedFollowup]);
 assert.ok(view.getByText(/满意 · 登记账号 FOLLOWUP-ACCOUNT · 版本 2 · 版本操作者 主管乙/));
 assert.ok(view.getByText(/未接通 · 回访人 回访员丙 · 版本 1/));
});

test('source process clears contacts on token-only session change and source permission revocation',async()=>{
 user(['source_document.read']);const Component=(await vite.ssrLoadModule('/src/components/SourceProcessTable.tsx')).default;
 const row={sourceSystem:'test',sourceId:'1',nodeId:'1',sourceSequence:1,sourceVersion:'1',revision:1,occurredAt:'2026-11-11T00:00:00Z',stage:'办理',department:'测试',contactName:'合成流程联系人',contactPhone:'合成电话',opinion:null,observedAt:null};
 let second=false,resolve:(value:any)=>void=()=>{};
 request.defaults.adapter=(config:any)=>second?new Promise(r=>{resolve=data=>r(response(config,data));}):Promise.resolve(response(config,{nodes:[row],revisions:[row],complete:true,state:'complete',cutoffAt:null,syncError:null,missingTimeNodeIds:[]}));
 const view=render(<Component complaintId="TEST-C1"/>);await waitFor(()=>assert.ok(view.getByText('合成流程联系人')));
 second=true;await act(async()=>store.setState({token:'synthetic-replacement-session'}));assert.equal(view.queryByText('合成流程联系人'),null);assert.equal(view.queryByText('合成电话'),null);
 await act(async()=>resolve({nodes:[row],revisions:[row],complete:true,state:'complete',cutoffAt:null,syncError:null,missingTimeNodeIds:[]}));
 await waitFor(()=>assert.ok(view.getByText('合成流程联系人')));
 await act(async()=>user());assert.equal(view.queryByText('合成流程联系人'),null);assert.equal(view.queryByText('合成电话'),null);
 await act(async()=>resolve({nodes:[],revisions:[],complete:false,state:'unavailable',cutoffAt:null,syncError:null,missingTimeNodeIds:[]}));
 await waitFor(()=>assert.ok(view.getByText('暂无已核实的来源节点')));
});
