import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import React from 'react';import {JSDOM} from 'jsdom';import {createServer,type ViteDevServer} from 'vite';
let vite:ViteDevServer;
before(async()=>{
 globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}} as any;
 vite=await createServer({root:path.resolve(fileURLToPath(new URL('..',import.meta.url))),appType:'custom',server:{middlewareMode:true,hmr:false}});
 await vite.ssrLoadModule('/src/components/LocationReviewPanel.tsx');
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ShadowRoot:dom.window.ShadowRoot,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}))Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});
 dom.window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any;
 const computed=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=((e:Element)=>computed(e)) as any;Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,writable:true,value:dom.window.getComputedStyle});
});after(async()=>{await vite?.close();});
for(const scenario of ['confirm','failed','defer','readonly'] as const)test('inline location review '+scenario,async()=>{
 const {default:request}=await vite.ssrLoadModule('/src/api/request.ts'),old=request.defaults.adapter;const writes:any[]=[];const callbacks:any[]=[];
 request.defaults.adapter=async(config:any)=>{let data:any={districts:[{code:'D1',name:'甲区'}],adminGrids:[{code:'A1',name:'甲网格',districtCode:'D1'}],communities:[{code:'C1',name:'秋实小区',adminGridCode:'A1'}]};if(config.method==='post'){writes.push(JSON.parse(config.data));if(scenario==='failed')throw new Error('保存失败合成用例');data={version:2,analysisEntered:false};}return {data:{code:200,data},status:200,headers:{},config};};
 const {default:Panel}=await vite.ssrLoadModule('/src/components/LocationReviewPanel.tsx');const {render,within,fireEvent,waitFor,cleanup}=await import('@testing-library/react');
 const ui=render(<Panel detail={{complaintId:'C1',editVersion:1,title:'秋实小区停水',sourceAddress:'来源地址合成证据',content:'原始内容',locationClues:[],locationLng:111,locationLat:30} as any} items={[{fieldName:'address',status:'pending'}] as any} disabled={scenario==='readonly'} onSaved={(r:any,n:boolean)=>callbacks.push(n)} onDeferred={(n:boolean)=>callbacks.push(n)}/>);
 try{const page=within(document.body);await waitFor(()=>assert.ok(page.getByText('系统建议：秋实小区')));assert.equal(page.queryByRole('dialog'),null);assert.ok(page.getByText('来源地址合成证据',{exact:false}));
 if(scenario==='readonly'){assert.equal((page.getByRole('button',{name:'确认位置并下一条'}) as HTMLButtonElement).disabled,true);return;}
 if(scenario==='defer'){fireEvent.click(page.getByRole('button',{name:'暂无法确认'}));fireEvent.mouseDown(page.getByRole('combobox',{name:'暂缓原因'}));fireEvent.click(await waitFor(()=>page.getAllByText('原文信息不足').at(-1)!));fireEvent.click(page.getByRole('button',{name:'记录暂缓并下一条'}));}else fireEvent.click(page.getByRole('button',{name:'确认位置并下一条'}));
 await waitFor(()=>assert.equal(writes.length,1));assert.equal(writes[0].expectedVersion,1);
 if(scenario==='defer'){assert.equal(writes[0].basis,'原文信息不足');}else{assert.equal(writes[0].address,'秋实小区');assert.equal(writes[0].longitude,null);assert.equal(writes[0].communityCode,'C1');}
 if(scenario==='failed'){await waitFor(()=>assert.ok(page.getByText('保存失败合成用例')));assert.equal(callbacks.length,0);assert.ok(page.getByText('系统建议：秋实小区'));}else await waitFor(()=>assert.deepEqual(callbacks,[true]));
 }finally{ui.unmount();cleanup();request.defaults.adapter=old;}
});
for(const switchKind of ['complaint','actor','version'])test('switching '+switchKind+' rejects late save and duplicate clicks',async()=>{
 const {default:request}=await vite.ssrLoadModule('/src/api/request.ts'),old=request.defaults.adapter;let finish!:()=>void;const delayed=new Promise<void>(r=>finish=r);let writes=0,saved=0;
 request.defaults.adapter=async(config:any)=>{let data:any={districts:[],adminGrids:[],communities:[]};if(config.method==='post'){writes++;await delayed;data={version:2,analysisEntered:false};}return {data:{code:200,data},status:200,headers:{},config};};
 const {default:Panel}=await vite.ssrLoadModule('/src/components/LocationReviewPanel.tsx');const {render,within,fireEvent,waitFor,act,cleanup}=await import('@testing-library/react');
 const props={detail:{complaintId:'A',editVersion:1,title:'合成诉求',address:'现有地址',locationClues:[]} as any,items:[{fieldName:'address',status:'pending'}] as any,onSaved:()=>saved++,onDeferred:()=>{}};
 const ui=render(<Panel {...props}/>);
 try{const page=within(document.body);await waitFor(()=>assert.equal((page.getByRole('button',{name:'确认位置'}) as HTMLButtonElement).disabled,false));fireEvent.click(page.getByRole('button',{name:'确认位置'}));fireEvent.click(page.getByRole('button',{name:'确认位置'}));await waitFor(()=>assert.equal(writes,1));if(switchKind==='actor'){const {useAppStore}=await vite.ssrLoadModule('/src/stores/appStore.ts');await act(async()=>useAppStore.setState({token:'new-actor'}));}else ui.rerender(<Panel {...props} detail={{...props.detail,...(switchKind==='complaint'?{complaintId:'B'}:{editVersion:2})}}/>);await act(async()=>{finish();await delayed;});assert.equal(saved,0);assert.equal(writes,1);}finally{finish();ui.unmount();cleanup();request.defaults.adapter=old;}
});
test('map search refuses raw complaint prose and phone numbers before network',async()=>{
 const {searchTiandituPlaces}=await vite.ssrLoadModule('/src/components/TiandituLocationPicker.tsx');let calls=0;const request=async()=>{calls++;return {ok:true,json:async()=>({pois:[]})};};
 await assert.rejects(()=>searchTiandituPlaces('请联系13812345678解决停水','test',request),/地点/);assert.equal(calls,0);
});
for(const clearBeforeReverse of [false,true])test('map reverse suggestion never rewrites parent coordinates '+clearBeforeReverse,async()=>{
 const mapVite=await createServer({root:path.resolve(fileURLToPath(new URL('..',import.meta.url))),appType:'custom',define:{'import.meta.env.VITE_TIANDITU_TK':JSON.stringify('synthetic-unused')},server:{middlewareMode:true,hmr:{port:clearBeforeReverse?24892:24891}}});
 const originalFetch=globalThis.fetch;let resolve!:(v:any)=>void;const pending=new Promise<any>(r=>resolve=r);let click!:(event:any)=>void;let writes=0;
 (window as any).T={LngLat:class{constructor(public lng:number,public lat:number){}},Marker:class{},Map:class{centerAndZoom(){}panTo(){}addEventListener(_name:string,handler:any){click=handler;}addOverLay(){}removeOverLay(){}}};
 globalThis.fetch=(async()=>pending) as any;
 const {default:Picker}=await mapVite.ssrLoadModule('/src/components/TiandituLocationPicker.tsx');const {render,within,waitFor,act,cleanup}=await import('@testing-library/react');
 function Harness({cleared}:{cleared:boolean}){const [point,setPoint]=React.useState({lng:'',lat:''});return <Picker address="秋实小区" lng={cleared?'':point.lng} lat={cleared?'':point.lat} contextKey={cleared?'new-district':'old-district'} onPick={(p:any)=>{writes++;setPoint(p);}}/>;}
 const ui=render(<Harness cleared={false}/>);
 try{await waitFor(()=>assert.ok(click));await act(async()=>click({lnglat:{getLng:()=>111,getLat:()=>30}}));assert.equal(writes,1);if(clearBeforeReverse)ui.rerender(<Harness cleared/>);await act(async()=>{resolve({ok:true,json:async()=>({result:{formatted_address:'合成反查地址'}})});await pending;});assert.equal(writes,1);if(clearBeforeReverse)assert.equal(within(document.body).queryByText(/合成反查地址/),null);else await waitFor(()=>assert.ok(within(document.body).getByText(/合成反查地址/)));}
 finally{ui.unmount();cleanup();globalThis.fetch=originalFetch;delete (window as any).T;await mapVite.close();}
});

test('existing map address and changed address automatically resolve district and community parents',async()=>{
 const {default:request}=await vite.ssrLoadModule('/src/api/request.ts'),old=request.defaults.adapter;
 const writes:any[]=[];
 const options={districts:[{code:'420504',name:'点军区'},{code:'D1',name:'甲区'}],adminGrids:[{code:'A1',name:'甲网格',districtCode:'D1'}],communities:[{code:'C1',name:'秋实小区',adminGridCode:'A1'}]};
 request.defaults.adapter=async(config:any)=>{let data:any=options;if(config.method==='post'){writes.push(JSON.parse(config.data));data={version:2};}return {data:{code:200,data},status:200,headers:{},config};};
 const {default:Panel}=await vite.ssrLoadModule('/src/components/LocationReviewPanel.tsx');
 const {render,within,fireEvent,waitFor,act,cleanup}=await import('@testing-library/react');const {Simulate}=await import('react-dom/test-utils');
 const ui=render(<Panel detail={{complaintId:'address-auto',editVersion:1,title:'合成核验',address:'湖北省宜昌市点军区联棚乡卢家冲东南约62米',locationClues:[]} as any} items={[{fieldName:'address',status:'pending'}] as any} onSaved={()=>{}} onDeferred={()=>{}}/>);
 try{
 const page=within(document.body);
 await waitFor(()=>assert.ok(page.getByText(/区县：点军区；网格：待核实/)));
 fireEvent.click(page.getByRole('button',{name:'调整位置'}));
 assert.ok(page.getByText(/乡镇／街道线索：联棚乡/));
 const input=page.getByLabelText('核实后的地址') as HTMLInputElement;
 await act(async()=>{input.value='甲区秋实小区3号';Simulate.change(input);});
 await waitFor(()=>assert.ok(page.getByText(/区县：甲区；网格：甲网格；小区：秋实小区/)));
 const basis=page.getByLabelText('位置核对依据') as HTMLTextAreaElement;
 await act(async()=>{basis.value='现场核对';Simulate.change(basis);});
 fireEvent.click(page.getByRole('button',{name:'确认位置'}));
 await waitFor(()=>assert.equal(writes.length,1));
 assert.equal(writes[0].districtCode,'D1');assert.equal(writes[0].adminGridCode,'A1');assert.equal(writes[0].communityCode,'C1');assert.equal(writes[0].address,'甲区秋实小区3号');assert.equal(writes[0].longitude,null);
 }finally{ui.unmount();cleanup();request.defaults.adapter=old;}
});

test('address edited before dictionary load resolves the latest draft when options arrive',async()=>{
 const {default:request}=await vite.ssrLoadModule('/src/api/request.ts'),old=request.defaults.adapter;
 let release!:(v:any)=>void;const pending=new Promise<any>(r=>release=r);
 request.defaults.adapter=async(config:any)=>({data:{code:200,data:await pending},status:200,headers:{},config});
 const {default:Panel}=await vite.ssrLoadModule('/src/components/LocationReviewPanel.tsx');
 const {render,within,fireEvent,waitFor,act,cleanup}=await import('@testing-library/react');const {Simulate}=await import('react-dom/test-utils');
 const ui=render(<Panel detail={{complaintId:'slow-address',editVersion:1,title:'合成核验',address:'旧地点',locationClues:[]} as any} items={[{fieldName:'address',status:'pending'}] as any} onSaved={()=>{}} onDeferred={()=>{}}/>);
 try{const page=within(document.body);fireEvent.click(page.getByRole('button',{name:'调整位置'}));const input=page.getByLabelText('核实后的地址') as HTMLInputElement;
 await act(async()=>{input.value='湖北省宜昌市点军区联棚乡卢家冲东南约62米';Simulate.change(input);release({districts:[{code:'420504',name:'点军区'}],adminGrids:[],communities:[]});await pending;});
 await waitFor(()=>assert.ok(page.getByText(/区县：点军区；网格：待核实/)));assert.equal(input.value,'湖北省宜昌市点军区联棚乡卢家冲东南约62米');
 }finally{release({districts:[],adminGrids:[],communities:[]});ui.unmount();cleanup();request.defaults.adapter=old;}
});
