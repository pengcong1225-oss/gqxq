import {namedLabel,sourceLabel} from '../utils/chineseDisplay';
import MasterDataImportDialog from '../components/MasterDataImportDialog';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Descriptions,Drawer,Form,Input,InputNumber,Modal,Result,Select,Space,Switch,Table,Tabs,Tag} from 'antd';
import {listEnterprises,getEnterprise,saveEnterprise,listHouseholds,saveHouseholds,listDepartmentMappings,saveDepartmentMapping,getEnterpriseReferenceOptions} from '../api/enterprises';
import {usePermissionAccess,useWriteAccess} from '../stores/roleAccess';
import type {EnterpriseDetail,EnterpriseListItem,EnterpriseWriteInput,HouseholdVersion,DepartmentMapping,DictItem} from '../types/api';
const errorText=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'请求失败，请重试';
const CompanyList:React.FC=()=>{
 const read=usePermissionAccess('enterprise.read'),write=useWriteAccess('enterprise.manage');
 const [items,setItems]=useState<EnterpriseListItem[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[keyword,setKeyword]=useState(''),[search,setSearch]=useState('');
 const [loading,setLoading]=useState(false),[editorSaving,setEditorSaving]=useState(false),[detailSaving,setDetailSaving]=useState(false),[error,setError]=useState<string|null>(null),[reload,setReload]=useState(0);
 const [editing,setEditing]=useState<EnterpriseDetail|null>(null),[editorOpen,setEditorOpen]=useState(false),[selected,setSelected]=useState<EnterpriseDetail|null>(null);
 const [households,setHouseholds]=useState<HouseholdVersion[]>([]),[mappings,setMappings]=useState<DepartmentMapping[]>([]),[businessTypes,setBusinessTypes]=useState<DictItem[]>([]),[districts,setDistricts]=useState<DictItem[]>([]);
 const [form]=Form.useForm<EnterpriseWriteInput>(),[houseForm]=Form.useForm(),[mappingForm]=Form.useForm();
 const detailSelection=useRef({code:null as string|null,generation:0});
 const detailRequest=useRef(0);
 const detailFormsMounted=useRef({households:false,mapping:false});
 const editorSelection=useRef({key:null as string|null,generation:0});
 const currentDetail=useCallback((owner:{code:string|null;generation:number})=>
  owner.code!==null&&owner.code===detailSelection.current.code&&owner.generation===detailSelection.current.generation,[]);
 const currentEditor=useCallback((owner:{key:string|null;generation:number})=>
  owner.key!==null&&owner.key===editorSelection.current.key&&owner.generation===editorSelection.current.generation,[]);
 const resetDetailForms=useCallback(()=>{
  if(detailFormsMounted.current.households)houseForm.resetFields();
  if(detailFormsMounted.current.mapping)mappingForm.resetFields();
 },[houseForm,mappingForm]);
 const closeDetail=useCallback(()=>{
  detailSelection.current={code:null,generation:detailSelection.current.generation+1};
  detailRequest.current++;
  resetDetailForms();setSelected(null);setHouseholds([]);setMappings([]);setDetailSaving(false);setLoading(false);
 },[resetDetailForms]);
 const closeEditor=useCallback(()=>{
  editorSelection.current={key:null,generation:editorSelection.current.generation+1};
  setEditorOpen(false);setEditing(null);setEditorSaving(false);form.resetFields();
 },[form]);
 useEffect(()=>()=>{
  detailSelection.current={code:null,generation:detailSelection.current.generation+1};
  detailRequest.current++;
  editorSelection.current={key:null,generation:editorSelection.current.generation+1};
 },[]);

 useEffect(()=>{
  if(!read.can){setItems([]);closeDetail();return;}
  let cancelled=false;setLoading(true);setError(null);
  void listEnterprises({page,size:20,keyword}).then(v=>{if(!cancelled){setItems(v.content);setTotal(v.total);}}).catch(e=>{if(!cancelled){setItems([]);setTotal(0);setError(errorText(e));}}).finally(()=>{if(!cancelled)setLoading(false);});
  return ()=>{cancelled=true;};
 },[read.can,page,keyword,reload,closeDetail]);
 useEffect(()=>{if(!write.can){closeEditor();return;}let cancelled=false;
  void getEnterpriseReferenceOptions().then(v=>{if(!cancelled){setBusinessTypes(v.businessTypes);setDistricts(v.districts);}}).catch(e=>{if(!cancelled)setError(errorText(e));});return ()=>{cancelled=true;};
 },[write.can,closeEditor]);

 // A request belongs to one selection generation, even when the same code is reopened.
 const refreshDetail=useCallback(async(owner:{code:string|null;generation:number})=>{
  if(!owner.code||!currentDetail(owner))return false;
  const request=++detailRequest.current;
  const [detail,h,m]=await Promise.all([getEnterprise(owner.code),listHouseholds(owner.code),listDepartmentMappings(owner.code)]);
  if(!currentDetail(owner)||request!==detailRequest.current)return false;
  setSelected(detail);setHouseholds(h);setMappings(m);return true;
 },[currentDetail]);
 const openDetail=async(code:string)=>{
  const owner={code,generation:detailSelection.current.generation+1};
  detailSelection.current=owner;detailRequest.current++;
  resetDetailForms();setSelected(null);setHouseholds([]);setMappings([]);setDetailSaving(false);setError(null);setLoading(true);
  try{await refreshDetail(owner);}catch(e){if(currentDetail(owner))setError(errorText(e));}
  finally{if(currentDetail(owner))setLoading(false);}
 };
 const edit=async(code?:string)=>{
  if(!write.can)return;
  const owner={key:code??'$new',generation:editorSelection.current.generation+1};
  editorSelection.current=owner;
  setEditorOpen(false);setEditing(null);setEditorSaving(false);setError(null);form.resetFields();
  try{
   const detail=code?await getEnterprise(code):null;
   if(!currentEditor(owner))return;
   setEditing(detail);
   form.setFieldsValue(detail?{...detail,status:detail.status==='disabled'?'disabled':'enabled',expectedVersion:detail.version}:{status:'enabled',expectedVersion:0,districtCode:null});
   setEditorOpen(true);
  }catch(e){if(currentEditor(owner))setError(errorText(e));}
 };
 const save=async()=>{
  if(!write.can)return;
  const owner={...editorSelection.current};const target=editing;
  if(!currentEditor(owner))return;
  try{
   const values=await form.validateFields();
   if(!currentEditor(owner))return;
   setEditorSaving(true);
   await saveEnterprise({...values,expectedVersion:target?.version??0,districtCode:values.districtCode??null,uscc:values.uscc||null});
   setReload(v=>v+1);
   if(currentEditor(owner))closeEditor();
  }catch(e){if(currentEditor(owner)&&!(e&&typeof e==='object'&&'errorFields' in e))setError(errorText(e));}
  finally{if(currentEditor(owner))setEditorSaving(false);}
 };
 const addHousehold=async()=>{
  const owner={...detailSelection.current};const target=selected;
  if(!target||!write.can||owner.code!==target.enterpriseCode||!currentDetail(owner))return;
  try{
   const values=await houseForm.validateFields();
   if(!currentDetail(owner))return;
   setDetailSaving(true);
   await saveHouseholds(target.enterpriseCode,{households:values.households??null,validFrom:values.validFrom,validTo:values.validTo||null,expectedVersion:target.version!});
   if(await refreshDetail(owner))houseForm.resetFields();
  }catch(e){if(currentDetail(owner))setError(errorText(e));}
  finally{if(currentDetail(owner))setDetailSaving(false);}
 };
 const addMapping=async()=>{
  const owner={...detailSelection.current};const target=selected;
  if(!target||!write.can||owner.code!==target.enterpriseCode||!currentDetail(owner))return;
  try{
   const values=await mappingForm.validateFields();
   if(!currentDetail(owner))return;
   const existing=mappings.find(m=>m.sourceSystem===values.sourceSystem&&m.sourceDepartmentCode===values.sourceDepartmentCode);
   setDetailSaving(true);
   await saveDepartmentMapping(target.enterpriseCode,{...values,entityType:'enterprise',aliases:(values.aliases??'').split(/[\n,，]/).map((v:string)=>v.trim()).filter(Boolean),verified:Boolean(values.verified),expectedVersion:existing?.version??0,expectedEnterpriseVersion:target.version!});
   if(await refreshDetail(owner))mappingForm.resetFields();
  }catch(e){if(currentDetail(owner))setError(errorText(e));}
  finally{if(currentDetail(owner))setDetailSaving(false);}
 };
 if(!read.can)return <Result status="403" title="无权限，请联系管理员"/>;
 return <Card title="企业档案" extra={<Space><MasterDataImportDialog kinds={['enterprise','department_mapping','household']} onImported={()=>setReload(v=>v+1)}/>{write.can&&<Button type="primary" onClick={()=>void edit()}>新增企业</Button>}</Space>}>

  {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
  <Space style={{marginBottom:16}}><Input aria-label="企业搜索" value={search} onChange={e=>setSearch(e.target.value)} placeholder="登记编码或名称"/><Button onClick={()=>{setPage(1);setKeyword(search);}}>查询</Button><Button onClick={()=>setReload(v=>v+1)}>刷新</Button></Space>
  <Table<EnterpriseListItem> rowKey="enterpriseCode" dataSource={items} loading={loading} pagination={{current:page,pageSize:20,total,onChange:setPage}} locale={{emptyText:error?'查询失败':'当前范围暂无企业'}} columns={[
   {title:'登记编码',dataIndex:'enterpriseCode'},{title:'企业名称',dataIndex:'enterpriseName'},{title:'业务类型',dataIndex:'businessTypeName',render:(v,r)=>namedLabel(r.businessType,v,'business_type')},{title:'联系人',dataIndex:'contactPerson',render:v=>v??'—'},{title:'电话',dataIndex:'contactPhone',render:v=>v??'—'},
   {title:'状态',dataIndex:'status',render:v=><Tag color={v==='enabled'?'green':'default'}>{v==='enabled'?'启用':'停用'}</Tag>},
   {title:'操作',render:(_,r)=><Space><Button onClick={()=>void openDetail(r.enterpriseCode)}>详情与历史</Button>{write.can&&<Button onClick={()=>void edit(r.enterpriseCode)}>编辑企业</Button>}</Space>}
  ]}/>
  <Modal title={editing?'编辑企业':'新增企业'} open={editorOpen&&write.can} onCancel={closeEditor} onOk={()=>void save()} okText="保存企业" confirmLoading={editorSaving} forceRender>
   {error&&<Alert type="error" message={error}/>}
   <Form form={form} layout="vertical">
    <Form.Item name="enterpriseCode" label="登记编码" rules={[{required:true}]}><Input maxLength={64} disabled={Boolean(editing)}/></Form.Item>
    <Form.Item name="enterpriseName" label="企业全称" rules={[{required:true}]}><Input maxLength={128}/></Form.Item>
    <Form.Item name="businessType" label="业务类型" rules={[{required:true}]}><Select options={businessTypes.map(v=>({value:v.value,label:v.label}))}/></Form.Item>
    <Form.Item name="districtCode" label="档案管理归属区县"><Select allowClear options={districts.map(v=>({value:v.value,label:v.label}))}/></Form.Item>
    <Form.Item name="uscc" label="统一社会信用代码"><Input maxLength={18}/></Form.Item>
    <Form.Item name="legalPerson" label="法定代表人"><Input maxLength={64}/></Form.Item>
    <Form.Item name="contactPerson" label="联系人"><Input maxLength={64}/></Form.Item>
    <Form.Item name="contactPhone" label="联系电话"><Input maxLength={64}/></Form.Item>
    <Form.Item name="address" label="注册地址"><Input maxLength={500}/></Form.Item>
    <Form.Item name="serviceArea" label="服务范围说明"><Input.TextArea maxLength={500}/></Form.Item>
    <Form.Item name="status" label="状态" rules={[{required:true}]}><Select options={[{value:'enabled',label:'启用'},{value:'disabled',label:'停用'}]}/></Form.Item>
    <Form.Item name="disableReason" label="停用依据（停用时必填，历史引用保留）"><Input maxLength={500}/></Form.Item>
   </Form>
  </Modal>
  <Drawer title={selected?.enterpriseName} open={Boolean(selected)} width={760} onClose={closeDetail}>
   {error&&<Alert type="error" message={error}/>}
   {selected&&<><Descriptions column={2} items={[{key:'code',label:'登记编码',children:selected.enterpriseCode},{key:'version',label:'档案版本',children:selected.version},{key:'district',label:'管理归属区县',children:selected.districtCode??'未登记'},{key:'score',label:'年度评分',children:selected.annualScore??'未知'},{key:'contact',label:'联系人',children:selected.contactPerson??'—'},{key:'phone',label:'联系电话',children:selected.contactPhone??'—'},{key:'address',label:'注册地址',children:selected.address??'—'},{key:'area',label:'服务范围说明',children:selected.serviceArea??'—'}]}/>
   <Tabs items={[{key:'households',label:'服务户数历史',children:<>

    <Table<HouseholdVersion> rowKey="version" dataSource={households} pagination={false} columns={[{title:'户数',dataIndex:'households',render:v=>v??'未知'},{title:'生效日',dataIndex:'validFrom'},{title:'截止日（不含）',dataIndex:'validTo',render:v=>v??'持续有效'},{title:'版本',dataIndex:'version'}]}/>
    {write.can&&<Form ref={instance=>{if(instance)detailFormsMounted.current.households=true;}} form={houseForm} layout="vertical" onFinish={()=>void addHousehold()}><Form.Item name="households" label="服务户数（留空为未知）"><InputNumber min={0} precision={0}/></Form.Item><Form.Item name="validFrom" label="生效日" rules={[{required:true}]}><Input type="date"/></Form.Item><Form.Item name="validTo" label="截止日（可空）"><Input type="date"/></Form.Item><Button htmlType="submit" loading={detailSaving}>新增户数版本</Button></Form>}
   </>},{key:'mapping',label:'来源部门映射',children:<>

    <Table<DepartmentMapping> rowKey={m=>m.sourceSystem+':'+m.sourceDepartmentCode} dataSource={mappings} pagination={false} columns={[{title:'来源系统',dataIndex:'sourceSystem',render:value=>sourceLabel(value,'system')},{title:'部门码',dataIndex:'sourceDepartmentCode'},{title:'名称',dataIndex:'sourceDepartmentName'},{title:'别名',dataIndex:'aliases',render:v=>Array.isArray(v)?v.join('、'):'—'},{title:'核验',dataIndex:'verified',render:v=>v?'已核验':'待核验'},{title:'操作',render:(_,m)=>write.can&&<Button onClick={()=>mappingForm.setFieldsValue({...m,verified:Boolean(m.verified),aliases:m.aliases.join('\n')})}>核验或编辑</Button>}]}/>
    {write.can&&<Form ref={instance=>{if(instance)detailFormsMounted.current.mapping=true;}} form={mappingForm} layout="vertical" onFinish={()=>void addMapping()}><Form.Item name="sourceSystem" label="来源系统" rules={[{required:true}]}><Input maxLength={64}/></Form.Item><Form.Item name="sourceDepartmentCode" label="来源部门码" rules={[{required:true}]}><Input maxLength={64}/></Form.Item><Form.Item name="sourceDepartmentName" label="来源部门名称" rules={[{required:true}]}><Input maxLength={128}/></Form.Item><Form.Item name="aliases" label="人工核验别名（每行一个）"><Input.TextArea/></Form.Item><Form.Item name="verified" label="已人工核验" valuePropName="checked"><Switch/></Form.Item><Button htmlType="submit" loading={detailSaving}>保存部门映射</Button></Form>}
   </>} ]}/></>}
  </Drawer>
 </Card>;
};
export default CompanyList;
