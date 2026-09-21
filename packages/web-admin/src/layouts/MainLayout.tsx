import React, { useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Avatar, Dropdown, Tag, theme } from 'antd';
import { useAppStore } from '../stores/appStore';
import { getUserInfo } from '../api/auth';
import { ROLE_ADMIN, ROLE_HANDLER, ROLE_READONLY, useRoleLabel, useRoles } from '../stores/roleAccess';
import type { AppRole } from '../types/api';
import {
  DashboardOutlined, FileTextOutlined, BarChartOutlined, WarningOutlined,
  TeamOutlined, AppstoreOutlined, FireOutlined, PauseCircleOutlined,
  ToolOutlined, FilePdfOutlined, DatabaseOutlined, SettingOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, LogoutOutlined, UserOutlined,
  EnvironmentOutlined, FolderOpenOutlined
} from '@ant-design/icons';

const { Header, Sider, Content } = Layout;

interface MenuEntry {
  key: string;
  icon: React.ReactNode;
  label: string;
  /** 可见档位；不给就是三档皆可见（读页面人人能看） */
  roles?: AppRole[];
}

const R_ALL: AppRole[] = [ROLE_ADMIN, ROLE_HANDLER, ROLE_READONLY];
const R_WRITE: AppRole[] = [ROLE_ADMIN, ROLE_HANDLER];
const R_ADMIN: AppRole[] = [ROLE_ADMIN];

/**
 * 菜单档位口径（docs/2026-09-21-角色权限映射.md §1、§3.4、§3.5）：
 *   * 纯操作入口（地址纠偏 / 敏感交办 / 交办归档）只读档看不到；
 *   * 字典管理与系统管理 admin 独占；
 *   * 其余是读页面，三档都留。
 *
 * 这道过滤**只是体验层**：真正的判定在后端 enforceRolePolicy()。
 * 只读用户手敲 URL 也进得来页面，但拿不到写权限（403 统一提示），
 * admin 独占的两条路由另有 App.tsx 的 RequireRole 挡住。
 */
const menuEntries: MenuEntry[] = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '数据大屏', roles: R_ALL },
  { key: '/complaints', icon: <FileTextOutlined />, label: '诉求管理', roles: R_ALL },
  { key: '/address-correction', icon: <EnvironmentOutlined />, label: '地址纠偏', roles: R_WRITE },
  { key: '/analysis', icon: <BarChartOutlined />, label: '数据分析', roles: R_ALL },
  { key: '/dispatch', icon: <WarningOutlined />, label: '敏感交办', roles: R_WRITE },
  { key: '/dispatch/archive', icon: <FolderOpenOutlined />, label: '交办归档', roles: R_WRITE },
  { key: '/companies', icon: <TeamOutlined />, label: '企业管理', roles: R_ALL },
  { key: '/grids', icon: <AppstoreOutlined />, label: '网格管理', roles: R_ALL },
  { key: '/heatmap', icon: <FireOutlined />, label: '热力图', roles: R_ALL },
  { key: '/shutdowns', icon: <PauseCircleOutlined />, label: '停供管理', roles: R_ALL },
  { key: '/pipelines', icon: <ToolOutlined />, label: '管道施工', roles: R_ALL },
  { key: '/reports', icon: <FilePdfOutlined />, label: '分析报告', roles: R_ALL },
  { key: '/dicts', icon: <DatabaseOutlined />, label: '字典管理', roles: R_ADMIN },
  { key: '/system/users', icon: <SettingOutlined />, label: '系统管理', roles: R_ADMIN },
];

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const logout = useAppStore((s) => s.logout);
  const userInfo = useAppStore((s) => s.userInfo);
  const setUserInfo = useAppStore((s) => s.setUserInfo);
  const tokenValue = useAppStore((s) => s.token);
  const roles = useRoles();
  const roleLabel = useRoleLabel();

  /**
   * 刷新后补水：token 在 localStorage，userInfo 只在内存里。
   * 不补的话"菜单全没了 / 按钮全灰"会被误判成系统坏了，所以拿 /auth/user-info 问回来。
   * 失败不用管：401 由响应拦截器清令牌并跳登录页。
   */
  useEffect(() => {
    if (tokenValue === null || tokenValue === '' || userInfo !== null) return;
    let cancelled = false;
    void getUserInfo()
      .then((info) => {
        if (!cancelled) setUserInfo(info);
      })
      .catch(() => {
        /* 令牌本身有问题，交给拦截器处理 */
      });
    return () => {
      cancelled = true;
    };
  }, [tokenValue, userInfo, setUserInfo]);

  const selectedKey = '/' + location.pathname.split('/').filter(Boolean).slice(0, 2).join('/');

  const menuItems = useMemo(
    () =>
      menuEntries
        .filter((e) => e.roles === undefined || e.roles.some((r) => roles.includes(r)))
        .map(({ key, icon, label }) => ({ key, icon, label })),
    [roles]
  );

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
              {/* 显示真实登录用户与档位：按钮为什么是灰的，这里给得出答案 */}
              <span>{userInfo !== null && userInfo !== undefined ? userInfo.realName : '未登录'}</span>
              <Tag color="blue">{roleLabel}</Tag>
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
