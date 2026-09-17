import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Avatar, Dropdown, theme } from 'antd';
import { useAppStore } from '../stores/appStore';
import {
  DashboardOutlined, FileTextOutlined, BarChartOutlined, WarningOutlined,
  TeamOutlined, AppstoreOutlined, FireOutlined, PauseCircleOutlined,
  ToolOutlined, FilePdfOutlined, DatabaseOutlined, SettingOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, LogoutOutlined, UserOutlined,
  EnvironmentOutlined, FolderOpenOutlined
} from '@ant-design/icons';

const { Header, Sider, Content } = Layout;

const menuItems = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '数据大屏' },
  { key: '/complaints', icon: <FileTextOutlined />, label: '诉求管理' },
  { key: '/address-correction', icon: <EnvironmentOutlined />, label: '地址纠偏' },
  { key: '/analysis', icon: <BarChartOutlined />, label: '数据分析' },
  { key: '/dispatch', icon: <WarningOutlined />, label: '敏感交办' },
  { key: '/dispatch/archive', icon: <FolderOpenOutlined />, label: '交办归档' },
  { key: '/companies', icon: <TeamOutlined />, label: '企业管理' },
  { key: '/grids', icon: <AppstoreOutlined />, label: '网格管理' },
  { key: '/heatmap', icon: <FireOutlined />, label: '热力图' },
  { key: '/shutdowns', icon: <PauseCircleOutlined />, label: '停供管理' },
  { key: '/pipelines', icon: <ToolOutlined />, label: '管道施工' },
  { key: '/reports', icon: <FilePdfOutlined />, label: '分析报告' },
  { key: '/dicts', icon: <DatabaseOutlined />, label: '字典管理' },
  { key: '/system/users', icon: <SettingOutlined />, label: '系统管理' },
];

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const logout = useAppStore((s) => s.logout);
  const userInfo = useAppStore((s) => s.userInfo);

  const selectedKey = '/' + location.pathname.split('/').filter(Boolean).slice(0, 2).join('/');

  const userMenuItems = [
    { key: 'profile', icon: <UserOutlined />, label: '个人中心' },
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
                if (key === 'logout') {
                  logout();
                  navigate('/login', { replace: true });
                }
              },
            }}
          >
            <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar icon={<UserOutlined />} style={{ backgroundColor: token.colorPrimary }} />
              {/* 显示真实登录用户，不再写死"系统管理员" */}
              <span>{userInfo !== null && userInfo !== undefined ? userInfo.realName : '未登录'}</span>
            </div>
          </Dropdown>
        </Header>
        <Content style={{ margin: 16, padding: 24, background: '#fff', borderRadius: 8, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
