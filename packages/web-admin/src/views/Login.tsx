import React, { useState } from 'react';
import { Form, Input, Button, Card, Alert } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { login as loginApi } from '../api/auth';
import { useAppStore } from '../stores/appStore';

/**
 * 登录页。
 *
 * 必须**先落令牌再跳转**：跳过去之后页面立刻会发受保护请求，
 * 若此时 localStorage 里还没有 token，就会 401 → 响应拦截器清 token 并跳回 /login，
 * 表现就是"登录进去又被弹出来"。
 */
const Login: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const setToken = useAppStore((s) => s.setToken);
  const setUserInfo = useAppStore((s) => s.setUserInfo);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await loginApi(values.username, values.password);
      setToken(result.token);
      setUserInfo(result.userInfo);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from !== undefined && from !== '' ? from : '/dashboard', { replace: true });
    } catch (err) {
      // 后端对"用户不存在"与"口令错误"返回同一句话，不泄露账号是否存在
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#f0f2f5' }}>
      <Card title="宜昌市供水燃气行业诉求分析平台" style={{ width: 400 }}>
        {error !== null && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
        )}
        <Form onFinish={onFinish} disabled={submitting}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" size="large" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" autoComplete="current-password" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default Login;
