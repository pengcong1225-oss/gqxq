import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import React from 'react';
import {JSDOM} from 'jsdom';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
let vite:ViteDevServer,dom:JSDOM;
before(async()=>{
  dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
  const computed=dom.window.getComputedStyle.bind(dom.window);Object.defineProperty(globalThis,'getComputedStyle',{value:computed,configurable:true});
  vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),appType:'custom',cacheDir:fileURLToPath(new URL('../node_modules/.vite-confirmation-test',import.meta.url)),server:{port:0,middlewareMode:true,hmr:false}});
});
after(async()=>{await vite.close();dom.window.close();});
async function fixture(pending=0,approved=true,allowed=true){
  const {default:Confirmation}=await vite.ssrLoadModule('/src/components/ComplaintClosureConfirmation.tsx');
  const {default:client}=await vite.ssrLoadModule('/src/api/request.ts');
  const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');
  useAppStore.setState({token:null,userInfo:{userId:'tester',roles:['handler'],permissions:allowed?['complaint.read','complaint.close']:['complaint.read'],authorizationVersion:1,mustChangePassword:false}});
  const original=client.defaults.adapter,writes:any[]=[];let saved=0;
  client.defaults.adapter=async(config:any)=>{
    if(config.method==='post')writes.push({url:config.url,body:JSON.parse(config.data)});
    return {status:200,statusText:'OK',headers:{},config,data:{code:200,data:config.method==='post'?{closedInSystem:true}:Array.from({length:pending},(_,i)=>({correctionId:String(i),status:'pending'}))}};
  };
  const t=await import('@testing-library/react');
  const ui=t.render(<Confirmation detail={{complaintId:'C1',closedInSystem:false,reportingStatusCode:approved?'approved':'submitted'} as any} onSaved={()=>{saved++;}}/>);
  return {...t,ui,writes,saved:()=>saved,finish:()=>{ui.unmount();t.cleanup();client.defaults.adapter=original;}};
}
test('manual confirmation keeps approval and permission prerequisites',async()=>{
  let f=await fixture(0,false);try{assert.equal((f.ui.getByRole('button',{name:'确认本系统办结'}) as HTMLButtonElement).disabled,true);assert.equal(f.writes.length,0);}finally{f.finish();}
  f=await fixture(0,true,false);try{assert.equal(f.ui.queryByRole('button',{name:'确认本系统办结'}),null);}finally{f.finish();}
});
test('pending overall corrections prevent manual closure',async()=>{
  const f=await fixture(2);try{
    f.fireEvent.click(f.ui.getByRole('button',{name:'确认本系统办结'}));
    const body=f.within(document.body);
    await f.waitFor(()=>assert.ok(body.getByText(/仍有 2 项纠偏未处理/)));
    f.fireEvent.change(body.getByLabelText('本系统办结依据'),{target:{value:'已核对'}});
    assert.equal((body.getByRole('button',{name:'确认办结',exact:true}) as HTMLButtonElement).disabled,true);
    assert.equal(f.writes.length,0);
  }finally{f.finish();}
});
test('closure requires explicit confirmation and records basis through the existing endpoint',async()=>{
  const f=await fixture();try{
    f.fireEvent.click(f.ui.getByRole('button',{name:'确认本系统办结'}));
    const body=f.within(document.body);
    await f.waitFor(()=>assert.ok(body.getByText('全部纠偏项已处理。')));
    assert.equal(f.writes.length,0);
    f.fireEvent.change(body.getByLabelText('本系统办结依据'),{target:{value:'审批及整体纠偏均已核对'}});
    f.fireEvent.click(body.getByRole('button',{name:'确认办结',exact:true}));
    await f.waitFor(()=>assert.equal(f.saved(),1));
    assert.deepEqual(f.writes,[{url:'/complaints/C1/close',body:{basis:'审批及整体纠偏均已核对'}}]);
  }finally{f.finish();}
});
