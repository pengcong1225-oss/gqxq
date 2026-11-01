import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Result } from 'antd';
import { useAppStore } from './stores/appStore';
import { FORBIDDEN_MESSAGE, usePermissionAccess } from './stores/roleAccess';
import MainLayout from './layouts/MainLayout';
import Dashboard from './views/Dashboard';
import ComplaintList from './views/ComplaintList';
import ComplaintDetail from './views/ComplaintDetail';
import AddressCorrection from './views/AddressCorrection';
import Analysis from './views/Analysis';
import DispatchOrders from './views/DispatchOrders';
import DispatchArchive from './views/DispatchArchive';
import CompanyList from './views/CompanyList';
import GridManager from './views/GridManager';
import HeatmapView from './views/HeatmapView';
import HeatRuleManager from './views/HeatRuleManager';
import ShutdownList from './views/ShutdownList';
import PipelineList from './views/PipelineList';
import ShutdownFeedback from './views/ShutdownFeedback';
import SynchronizedFollowups from './components/SynchronizedFollowups';
import GridComparison from './views/GridComparison';
import AppealAssessment from './views/AppealAssessment';
import SeasonalAssessment from './views/SeasonalAssessment';
import DataAlerts from './views/DataAlerts';
import BusinessRuleManager from './views/BusinessRuleManager';
import BusinessSourceStatus from './views/BusinessSourceStatus';
import ReportView from './views/ReportView';
import DictManager from './views/DictManager';
import UserManager from './views/UserManager';
import RoleManager from './views/RoleManager';
import AuditLogView from './views/AuditLogView';
import ImportBatchList from './views/ImportBatchList';
import ChangePassword from './views/ChangePassword';
import Login from './views/Login';

/**
 * 未登录直接跳登录页。
 *
 * 没有这层守卫时，未登录访问 /dashboard 会先把页面渲染出来、再发请求拿到 401，
 * 由响应拦截器硬跳 /login —— 表现为页面闪一下再被弹走。守卫把这一步提前到发请求之前。
 */
const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const token = useAppStore((s) => s.token);
  const userInfo = useAppStore(s=>s.userInfo);
  const location = useLocation();
  if (token === null || token === '') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if(userInfo?.mustChangePassword&&location.pathname!=='/change-password') return <Navigate to="/change-password" replace/>;
  return <>{children}</>;
};

/**
 * admin 独占路由的入口守卫（只做体验层，不做权限树/动态路由那套）。
 *
 * 菜单已经按档位过滤过，这里是防"手敲 URL 进来看到一堆点了就 403 的按钮"。
 * 判定本身仍以后端为准（策略表 U1–U3 + requireRole('admin')）：
 * 就算有人绕过这层，接口也不会给他写成功。
 */
const RequireRole: React.FC<{ permission: string; children: React.ReactNode }> = ({ permission, children }) => {
  const access = usePermissionAccess(permission);
  const userInfo = useAppStore((s) => s.userInfo);
  // 刷新后 userInfo 还在路上（MainLayout 正在拉 /auth/user-info），此刻不判定，避免闪一屏 403
  if (userInfo === null) return null;
  if (access.can) return <>{children}</>;
  return (
    <Result
      status="403"
      title={FORBIDDEN_MESSAGE}
      subTitle="请联系管理员开通权限。"
    />
  );
};

const LegacyCorrectionRedirect = () => {
  const location=useLocation();
  const id=new URLSearchParams(location.search).get('complaintId');
  return <Navigate replace to={'/complaints/corrections'+(id?'?complaintId='+encodeURIComponent(id):'')}/>;
};

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<RequireAuth><ChangePassword/></RequireAuth>}/>
      <Route path="/" element={<RequireAuth><MainLayout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="complaints" element={<ComplaintList />} />
        <Route path="complaints/corrections" element={<AddressCorrection />} />
        <Route path="complaints/:id" element={<ComplaintDetail />} />
        <Route path="address-correction" element={<LegacyCorrectionRedirect />} />
        <Route path="analysis" element={<Analysis />} />
        <Route path="dispatch" element={<DispatchOrders />} />
        <Route path="dispatch/archive" element={<DispatchArchive />} />
        <Route path="companies" element={<CompanyList />} />
        <Route path="grids" element={<GridManager />} />
        <Route path="heatmap" element={<HeatmapView />} />
        <Route path="heat-rules" element={<RequireRole permission="heatmap.manage"><HeatRuleManager/></RequireRole>} />
        <Route path="shutdowns" element={<RequireRole permission="shutdown.read"><ShutdownList /></RequireRole>} />
        <Route path="pipelines" element={<RequireRole permission="pipeline.read"><PipelineList /></RequireRole>} />
        <Route path="shutdown-feedback" element={<RequireRole permission="shutdown.read"><ShutdownFeedback/></RequireRole>}/>
        <Route path="followups" element={<RequireRole permission="complaint.read"><SynchronizedFollowups/></RequireRole>}/>
        <Route path="grid-comparison" element={<RequireRole permission="assessment.read"><GridComparison/></RequireRole>}/>
        <Route path="appeal-assessment" element={<RequireRole permission="assessment.read"><AppealAssessment/></RequireRole>}/>
        <Route path="seasonal-assessment" element={<RequireRole permission="assessment.read"><SeasonalAssessment/></RequireRole>}/>
        <Route path="data-alerts" element={<RequireRole permission="alert.read"><DataAlerts/></RequireRole>}/>
        <Route path="business-rules" element={<RequireRole permission="business.rules.manage"><BusinessRuleManager/></RequireRole>}/>
        <Route path="business-source-status" element={<RequireRole permission="source_status.read"><BusinessSourceStatus/></RequireRole>}/>
        <Route path="reports" element={<ReportView />} />
        <Route path="dicts" element={<RequireRole permission="system.dict.manage"><DictManager /></RequireRole>} />
        <Route path="system/roles" element={<RequireRole permission="system.roles.manage"><RoleManager/></RequireRole>} />
        <Route path="system/audit-logs" element={<RequireRole permission="system.audit.read"><AuditLogView/></RequireRole>} />
        <Route path="master-data/imports" element={<RequireRole permission="masterdata.import"><ImportBatchList/></RequireRole>} />
        <Route path="system/users" element={<RequireRole permission="system.users.manage"><UserManager /></RequireRole>} />
      </Route>
    </Routes>
  );
};

export default App;
