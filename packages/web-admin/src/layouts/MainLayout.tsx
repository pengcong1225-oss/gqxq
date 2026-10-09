import React, { useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Avatar, Dropdown, Tag, theme } from 'antd';
import { useAppStore } from '../stores/appStore';
import { getUserInfo } from '../api/auth';
import { useRoleLabel } from '../stores/roleAccess';
import {
  DashboardOutlined, FileTextOutlined, BarChartOutlined, WarningOutlined,
  TeamOutlined, AppstoreOutlined, FireOutlined, PauseCircleOutlined,
  ToolOutlined, FilePdfOutlined, DatabaseOutlined, SettingOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, LogoutOutlined, UserOutlined,
  AuditOutlined, FolderOpenOutlined
} from '@ant-design/icons';

const NavigatePassword=()=>{const navigate=useNavigate();useEffect(()=>{navigate('/change-password',{replace:true});},[navigate]);return null;};
const { Header, Sider, Content } = Layout;

interface MenuEntry {
  key: string;
  icon: React.ReactNode;
  label: string;
  /** 页面对应的服务端功能权限 */
  permission: string;
}

/** Menus reflect backend permissions. Buttons use their endpoint capability;
 * the server always independently validates access. */
const menuEntries: MenuEntry[] = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '数据大屏', permission: 'dashboard.read' },
  { key: '/complaints', icon: <FileTextOutlined />, label: '诉求管理', permission: 'complaint.read' },
  { key: '/address-correction', icon: <AuditOutlined />, label: '整体纠偏', permission: 'complaint.correct' },
  { key: '/analysis', icon: <BarChartOutlined />, label: '数据分析', permission: 'analysis.read' },
  { key: '/dispatch', icon: <WarningOutlined />, label: '敏感交办', permission: 'dispatch.read' },
  { key: '/dispatch/archive', icon: <FolderOpenOutlined />, label: '交办归档', permission: 'dispatch.read' },
  { key: '/companies', icon: <TeamOutlined />, label: '企业管理', permission: 'enterprise.read' },
  { key: '/grids', icon: <AppstoreOutlined />, label: '网格管理', permission: 'grid.read' },
  { key: '/heatmap', icon: <FireOutlined />, label: '热力图', permission: 'heatmap.read' },
  { key: '/shutdowns', icon: <PauseCircleOutlined />, label: '停供管理', permission: 'shutdown.read' },
  { key: '/pipelines', icon: <ToolOutlined />, label: '管道施工', permission: 'pipeline.read' },
  { key: '/reports', icon: <FilePdfOutlined />, label: '分析报告', permission: 'report.read' },
  { key: '/dicts', icon: <DatabaseOutlined />, label: '字典管理', permission: 'system.dict.manage' },
  { key: '/system/users', icon: <SettingOutlined />, label: '账号管理', permission: 'system.users.manage' },
];

menuEntries.push({key:'/system/roles',icon:<SettingOutlined/>,label:'角色权限',permission:'system.roles.manage'});
menuEntries.push({key:'/system/audit-logs',icon:<AuditOutlined/>,label:'登录与操作日志',permission:'system.audit.read'});

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const logout = useAppStore((s) => s.logout);
  const userInfo = useAppStore((s) => s.userInfo);
  const setUserInfo = useAppStore((s) => s.setUserInfo);
  const tokenValue = useAppStore((s) => s.token);
  const permissions=userInfo?.permissions??[];
  const roleLabel = useRoleLabel();

  /**
   * 刷新后补水：token 在 localStorage，userInfo 只在内存里。
   * 不补的话"菜单全没了 / 按钮全灰"会被误判成系统坏了，所以拿 /auth/user-info 问回来。
   * 失败不用管：401 由响应拦截器清令牌并跳登录页。
   */
  useEffect(() => {
    if (!tokenValue) return;
    let cancelled=false;
    const refreshIdentity=()=>{void getUserInfo().then(info=>{if(!cancelled)setUserInfo(info);}).catch(()=>{/* 401 interceptor handles expired identity. */});};
    refreshIdentity();
    window.addEventListener('focus',refreshIdentity);
    return ()=>{cancelled=true;window.removeEventListener('focus',refreshIdentity);};
  }, [tokenValue,setUserInfo,location.pathname]);

  const selectedKey = '/' + location.pathname.split('/').filter(Boolean).slice(0, 2).join('/');

  const menuItems = useMemo(
    () =>
      menuEntries
        .filter(e=>permissions.includes(e.permission)&&!userInfo?.mustChangePassword)
        .map(({ key, icon, label }) => ({ key, icon, label })),
    [permissions,userInfo]
  );

  const userMenuItems = [
    { key: 'password', icon: <UserOutlined />, label: '修改口令' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
  ];

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider trigger={null} collapsible collapsed={collapsed} width={220}
        style={{ background: token.colorBgContainer, borderRight: '1px solid #f0f0f0' }}>
        <div style={{ height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderBottom: '1px solid #f0f0f0', fontWeight: 700, fontSize: collapsed ? 14 : 16, color: token.colorPrimary }}>
          {collapsed ? '水燃' : '宜昌水燃诉求分析平台'}
        </div>
        <Menu mode="inline" selectedKeys={[selectedKey]} items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0, marginTop: 8 }} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', borderBottom: '1px solid #f0f0f0', height: 64 }}>
          <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)} style={{ fontSize: 16 }} />
          <Dropdown
            menu={{
              items: userMenuItems,
              onClick: ({ key }) => {
                if(key==='password') navigate('/change-password');
                if (key === 'logout') {
                  logout();
                  navigate('/login', { replace: true });
                }
              },
            }}
          >
            <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar icon={<UserOutlined />} style={{ backgroundColor: token.colorPrimary }} />
              {/* 显示真实登录用户与档位：按钮为什么是灰的，这里给得出答案 */}
              <span>{userInfo !== null && userInfo !== undefined ? userInfo.realName : '未登录'}</span>
              <Tag color="blue">{roleLabel}</Tag>
            </div>
          </Dropdown>
        </Header>
        <Content style={{ margin: 16, padding: 24, background: '#fff', borderRadius: 8, overflow: 'auto' }}>
          {userInfo?.mustChangePassword ? <NavigatePassword/> : <Outlet />}
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
