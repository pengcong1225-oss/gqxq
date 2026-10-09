import React,{useEffect,useState} from 'react';
import {Alert,Button,Checkbox,Form,Input,Modal,Select,Space,Switch,Table,Tag,message} from 'antd';
import {listRoles,getPermissions,saveRole,type PlatformRole,type PermissionItem} from '../api/roles';
import {usePermissionAccess} from '../stores/roleAccess';

export default function RoleManager(){
 const access=usePermissionAccess('system.roles.manage');
 const [roles,setRoles]=useState<PlatformRole[]>([]);const [catalog,setCatalog]=useState<PermissionItem[]>([]);
 const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [open,setOpen]=useState(false);
 const [editing,setEditing]=useState<PlatformRole|null>(null);const [saving,setSaving]=useState(false);const [form]=Form.useForm();
 const load=async()=>{setLoading(true);try{const [r,p]=await Promise.all([listRoles(),getPermissions()]);setRoles(r);setCatalog(p);setError('');}catch(e){setError((e as Error).message);}finally{setLoading(false);}};
 useEffect(()=>{if(access.can)void load();},[access.can]);
 const begin=(role:PlatformRole|null)=>{setEditing(role);form.resetFields();form.setFieldsValue(role??{enabled:true,permissionCodes:[]});setOpen(true);};
 const submit=async()=>{
  let values;try{values=await form.validateFields();}catch{return;}
  setSaving(true);try{
   const {roleCode,...body}=values;
   if(editing?.roleCode==='admin'){delete body.permissionCodes;delete body.enabled;}
   await saveRole(editing?.roleCode??roleCode,{...body,expectedVersion:editing?.version??0},!editing);
   setOpen(false);form.resetFields();message.success('角色已保存，后续请求使用当前授权');await load();
  }catch(e){message.error((e as Error).message);}finally{setSaving(false);}
 };
 return <div><h2>角色权限管理</h2><Alert type="info" showIcon message="一人一个业务角色。账号与角色管理权限受保护；只读角色仅可查询和修改本人口令。" style={{marginBottom:16}}/>
 {error&&<Alert type="error" showIcon message={error}/>}
 <Space style={{marginBottom:16}}><Button onClick={()=>void load()} loading={loading}>刷新</Button><Button type="primary" disabled={!access.can} onClick={()=>begin(null)}>新增角色</Button></Space>
 <Table rowKey="roleCode" dataSource={roles} loading={loading} pagination={false} columns={[
 {title:'代码',dataIndex:'roleCode'},{title:'名称',dataIndex:'name'},{title:'说明',dataIndex:'description'},
 {title:'状态',render:(_,r)=><Tag color={r.enabled?'success':'default'}>{r.enabled?'启用':'停用'}{r.builtIn?' · 内置':''}</Tag>},
 {title:'权限数',render:(_,r)=>r.permissionCodes.length},{title:'操作',render:(_,r)=><Button type="link" disabled={!access.can} onClick={()=>begin(r)}>编辑授权</Button>}]} />
 <Modal title={editing?'编辑角色':'新增角色'} open={open} okText="保存" cancelText="取消" onOk={()=>void submit()} confirmLoading={saving} onCancel={()=>{setOpen(false);form.resetFields();}} width={720} destroyOnHidden>
 <Form form={form} layout="vertical" disabled={saving}>
 {!editing&&<><Form.Item name="roleCode" label="角色代码" rules={[{required:true},{pattern:/^[a-z][a-z0-9_.-]{1,63}$/,message:'2–64 位小写字母、数字、点、横线或下划线，以字母开头'}]}><Input/></Form.Item>
 <Form.Item name="copyFrom" label="复制业务角色" extra="选择后可继续调整权限"><Select allowClear options={roles.filter(r=>r.enabled&&r.roleCode!=='admin').map(r=>({value:r.roleCode,label:r.name}))} onChange={code=>{form.setFieldsValue({permissionCodes:roles.find(r=>r.roleCode===code)?.permissionCodes.filter(p=>!catalog.find(c=>c.code===p)?.protected)??[]});}}/></Form.Item></>}
 <Form.Item name="name" label="角色名称" rules={[{required:true},{max:64}]}><Input/></Form.Item>
 <Form.Item name="description" label="说明" rules={[{max:500}]}><Input.TextArea/></Form.Item>
 <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch disabled={editing?.roleCode==='admin'}/></Form.Item>
 <Form.Item name="permissionCodes" label="功能权限"><Checkbox.Group disabled={editing?.roleCode==='admin'} options={catalog.filter(p=>!p.protected||editing?.roleCode==='admin').map(p=>({value:p.code,label:p.name+'（'+p.code+'）'}))}/></Form.Item>
 </Form></Modal></div>;
}
