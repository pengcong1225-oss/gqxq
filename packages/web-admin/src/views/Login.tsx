import React, { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Alert, Tag, Typography } from 'antd';
import { UserOutlined, LockOutlined, CustomerServiceOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { getOidcStatus, login as loginApi, oidcStartUrl, readOidcSession } from '../api/auth';
import { BASE_PATH } from '../api/request';
import { useAppStore } from '../stores/appStore';

/**
 * 登录页。
 *
 * 必须**先落令牌再跳转**：跳过去之后页面立刻会发受保护请求，
 * 若此时 会话存储里还没有 token，就会 401 → 响应拦截器清 token 并跳回 /login，
 * 表现就是"登录进去又被弹出来"。
 */
const Login: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const setToken = useAppStore((s) => s.setToken);
  const setUserInfo = useAppStore((s) => s.setUserInfo);
  const token = useAppStore((s) => s.token);
  const userInfo = useAppStore((s) => s.userInfo);
  const portalError = useAppStore((s) => s.portalError);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oidcUrl, setOidcUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams(location.search);
    const result = query.get('oidc');
    void getOidcStatus().then(({ enabled, startUrl }) => {
      if (active) setOidcUrl(enabled ? startUrl ?? oidcStartUrl : null);
    }).catch(() => {});
    if (result === 'denied') setError('当前住新账号尚未开通诉求应用，或尚未绑定有效的诉求账号');
    if (result === 'unavailable') setError('住新平台授权暂不可用，请稍后重试');
    if (result === 'complete') {
      setSubmitting(true);
      void readOidcSession().then((session) => {
        if (!active) return;
        setUserInfo(session.userInfo);
        setToken(session.token);
        if (query.get('view') === 'screen' && !session.userInfo.mustChangePassword) {
          window.sessionStorage.setItem('gqxq-token', session.token);
          window.location.replace(`${BASE_PATH}/screen/`);
        }
      }).catch((err) => {
        if (active) setError(err instanceof Error ? err.message : '住新统一登录会话已失效');
      }).finally(() => { if (active) setSubmitting(false); });
    }
    return () => { active = false; };
  }, [location.search, setToken, setUserInfo]);

  useEffect(() => {
    if (!token || !userInfo) return;
    const query = new URLSearchParams(location.search);
    if (query.get('oidc') === 'complete' && query.get('view') === 'screen' && !userInfo.mustChangePassword) return;
    const from = (location.state as { from?: unknown } | null)?.from;
    const returnPath = typeof from === 'string' && /^\/(?!\/)/.test(from)
      ? from.split(/[?#]/, 1)[0].replace(/\/+$/, '')
      : '';
    // Logging out after a successful change can leave the old password page
    // in router state. Only the current server flag may require another change.
    const destination = returnPath && !['/login', '/change-password'].includes(returnPath.toLowerCase())
      ? from as string
      : '/dashboard';
    navigate(userInfo.mustChangePassword ? '/change-password' : destination, { replace: true });
  }, [token, userInfo, location.search, location.state, navigate]);

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await loginApi(values.username, values.password);
      setToken(result.token);
      setUserInfo(result.userInfo);
    } catch (err) {
      // 后端对"用户不存在"与"口令错误"返回同一句话，不泄露账号是否存在
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <header className="login-brand">
        <span className="brand-symbol"><CustomerServiceOutlined /></span>
        <div>
          <strong>宜昌市供水燃气行业诉求分析平台</strong>
          <p>城镇供水 · 燃气服务 · 诉求管理</p>
        </div>
      </header>
      <main className="login-main">
        <section className="login-intro">
          <Tag color="blue">供水燃气诉求管理</Tag>
          <h1>诉求有回应<br />处置可追溯</h1>
          <p>连接诉求接收、敏感交办与结果核验，<br />让每一条诉求的流转和分析有据可查。</p>
          <div className="login-features">
            <span><CheckCircleOutlined /> 诉求信息统一管理</span>
            <span><CheckCircleOutlined /> 交办结果协同跟踪</span>
            <span><CheckCircleOutlined /> 纠偏分析完整留痕</span>
          </div>
        </section>
        <Card className="login-card" bordered={false}>
          <Typography.Title level={3}>登录管理平台</Typography.Title>
          <Typography.Text type="secondary">请使用已授权的账号登录</Typography.Text>
          {(error ?? portalError) !== null && (
            <Alert type="error" showIcon message={error ?? portalError} style={{ marginBottom: 16 }} />
          )}
          {oidcUrl && (
            <Button href={oidcUrl} target="_top" block size="large" style={{ margin: '16px 0' }}>
              使用住新平台账号登录
            </Button>
          )}
          <Form layout="vertical" requiredMark={false} onFinish={onFinish} disabled={submitting}>
            <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" size="large" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" autoComplete="current-password" />
            </Form.Item>
            <Form.Item className="login-submit">
              <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
                登录
              </Button>
            </Form.Item>
          </Form>
        </Card>
      </main>
      <footer className="login-footer">宜昌市供水燃气行业诉求分析平台</footer>
    </div>
  );
};

export default Login;
