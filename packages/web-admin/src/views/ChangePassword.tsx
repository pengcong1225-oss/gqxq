import React,{useState} from 'react';
import {Alert,Button,Card,Form,Input} from 'antd';
import {useNavigate} from 'react-router-dom';
import {changePassword} from '../api/auth';
import {useAppStore} from '../stores/appStore';
export default function ChangePassword(){
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [form]=Form.useForm();
 const user=useAppStore(s=>s.userInfo);const logout=useAppStore(s=>s.logout);const navigate=useNavigate();
 const submit=async(values:{currentPassword:string;newPassword:string})=>{
  setBusy(true);setError('');try{await changePassword(values.currentPassword,values.newPassword);form.resetFields();logout();navigate('/login',{replace:true});}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 };
 return <Card title="修改口令" style={{maxWidth:520,margin:'64px auto'}}>
 {user?.mustChangePassword&&<Alert type="warning" showIcon message="初始或重置口令须修改后才能使用业务功能" style={{marginBottom:16}}/>}
 {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
 <Form form={form} layout="vertical" onFinish={submit} disabled={busy}>
 <Form.Item name="currentPassword" label="当前口令" rules={[{required:true}]}><Input.Password autoComplete="current-password"/></Form.Item>
 <Form.Item name="newPassword" label="新口令" extra="至少 8 个字符，UTF-8 编码不超过 72 字节" rules={[{required:true},{min:8},{validator:(_,v)=>!v||new TextEncoder().encode(v).length<=72?Promise.resolve():Promise.reject(new Error('不能超过 72 字节'))}]}><Input.Password autoComplete="new-password"/></Form.Item>
 <Form.Item name="confirmPassword" label="确认新口令" dependencies={['newPassword']} rules={[{required:true},({getFieldValue})=>({validator:(_,v)=>!v||v===getFieldValue('newPassword')?Promise.resolve():Promise.reject(new Error('两次新口令不一致'))})]}><Input.Password autoComplete="new-password"/></Form.Item>
 <Button type="primary" htmlType="submit" loading={busy}>保存并重新登录</Button>
 </Form></Card>;
}
