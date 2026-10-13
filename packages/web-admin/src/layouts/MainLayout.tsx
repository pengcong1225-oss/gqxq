import React, { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Avatar, Breadcrumb, Dropdown, Tag } from 'antd';
import { useAppStore } from '../stores/appStore';
import { getUserInfo } from '../api/auth';
import { useRoleLabel } from '../stores/roleAccess';
import {
  DashboardOutlined, FileTextOutlined, BarChartOutlined, WarningOutlined,
  TeamOutlined, AppstoreOutlined, FireOutlined,
  FilePdfOutlined, DatabaseOutlined, SettingOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, LogoutOutlined, UserOutlined,
  AuditOutlined, FolderOpenOutlined, CustomerServiceOutlined, SafetyCertificateOutlined
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
  {key:'/master-data/imports',icon:<DatabaseOutlined/>,label:'导入批次',permission:'masterdata.import'},
  { key: '/dashboard', icon: <DashboardOutlined />, label: '数据概览', permission: 'dashboard.read' },
  { key: '/complaints', icon: <FileTextOutlined />, label: '诉求管理', permission: 'complaint.read' },
  { key: '/address-correction', icon: <AuditOutlined />, label: '整体纠偏', permission: 'complaint.correct' },
  { key: '/analysis', icon: <BarChartOutlined />, label: '数据分析', permission: 'analysis.read' },
  { key: '/dispatch', icon: <WarningOutlined />, label: '敏感交办', permission: 'dispatch.read' },
  { key: '/dispatch/archive', icon: <FolderOpenOutlined />, label: '交办归档', permission: 'dispatch.read' },
  { key: '/companies', icon: <TeamOutlined />, label: '企业管理', permission: 'enterprise.read' },
  { key: '/grids', icon: <AppstoreOutlined />, label: '网格管理', permission: 'grid.read' },
  {key:'/heat-rules',icon:<FireOutlined/>,label:'五档热力规则',permission:'heatmap.manage'},
  { key: '/heatmap', icon: <FireOutlined />, label: '热力图', permission: 'heatmap.read' },
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

  const currentEntry = menuEntries
    .filter(entry => location.pathname === entry.key || location.pathname.startsWith(entry.key + '/'))
    .sort((a, b) => b.key.length - a.key.length)[0];
  const selectedKey = currentEntry?.key;

  const menuItems = useMemo(() => {
    const available = menuEntries.filter(e => permissions.includes(e.permission) && !userInfo?.mustChangePassword &&
      (e.key !== '/master-data/imports' || ['enterprise.manage', 'grid.manage', 'system.dict.manage'].some(code => permissions.includes(code))));
    const groups = [
      { label: '诉求办理', keys: ['/complaints', '/dispatch', '/address-correction', '/dispatch/archive'] },
      { label: '统计与报告', keys: ['/dashboard', '/analysis', '/heatmap', '/reports'] },
      { label: '基础资料', keys: ['/companies', '/grids', '/heat-rules', '/master-data/imports', '/dicts'] },
      { label: '系统管理', keys: ['/system/users', '/system/roles', '/system/audit-logs'] },
    ];
    const visible = groups.map(group => ({ key: group.label, type: 'group' as const, label: group.label,
      children: group.keys.flatMap(key => available.filter(entry => entry.key === key).map(({key, icon, label}) => ({key, icon, label})))
    })).filter(group => group.children.length);
    return collapsed ? visible.flatMap(group => group.children) : visible;
  }, [permissions, userInfo, collapsed]);

  const userMenuItems = [
    { key: 'password', icon: <UserOutlined />, label: '修改密码' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
  ];

  return (
    <Layout className="app-layout">
      <Sider trigger={null} collapsible collapsed={collapsed} width={220} collapsedWidth={72}
        theme="light" className="app-sider" breakpoint="lg" onBreakpoint={setCollapsed}>
        <Link to="/dashboard" className="app-brand" aria-label="诉求平台首页">
          <span className="brand-mark"><CustomerServiceOutlined /></span>
          {!collapsed && <span>宜昌水燃诉求分析</span>}
        </Link>
        {!collapsed && <div className="nav-caption">业务工作台</div>}
        <nav className="app-navigation" aria-label="业务导航">
        <Menu mode="inline" selectedKeys={selectedKey ? [selectedKey] : []} items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
        </nav>
        {!collapsed && <div className="sider-footer"><SafetyCertificateOutlined /> 诉求 · 协同 · 分析</div>}
      </Sider>
      <Layout className="main-layout">
        <Header className="app-header">
          <div className="header-left">
          <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            aria-label={collapsed ? '展开导航' : '收起导航'}
            onClick={() => setCollapsed(!collapsed)} style={{ fontSize: 16 }} />
          <Breadcrumb items={[{ title: '供水燃气诉求' }, { title: currentEntry?.label ?? '工作台' }]} />
          </div>
          <Dropdown trigger={['click']}
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
            <button type="button" className="user-menu" aria-label="账户菜单">
              <Avatar size="small" icon={<UserOutlined />} />
              {/* 显示真实登录用户与档位：按钮为什么是灰的，这里给得出答案 */}
              <span>{userInfo !== null && userInfo !== undefined ? userInfo.realName : '未登录'}</span>
              <Tag color="blue">{roleLabel}</Tag>
            </button>
          </Dropdown>
        </Header>
        <Content className="workspace">
          <div className="workspace-heading"><span>供水燃气行业诉求管理</span><span>业务管理端</span></div>
          <section className="page-content" aria-label={currentEntry?.label ?? '工作台'}>
          {userInfo?.mustChangePassword ? <NavigatePassword/> : <Outlet />}
          </section>
          <footer className="workspace-footer">宜昌市供水燃气行业诉求分析平台</footer>
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
