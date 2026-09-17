import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAppStore } from './stores/appStore';
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
import ShutdownList from './views/ShutdownList';
import PipelineList from './views/PipelineList';
import ReportView from './views/ReportView';
import DictManager from './views/DictManager';
import UserManager from './views/UserManager';
import Login from './views/Login';

/**
 * 未登录直接跳登录页。
 *
 * 没有这层守卫时，未登录访问 /dashboard 会先把页面渲染出来、再发请求拿到 401，
 * 由响应拦截器硬跳 /login —— 表现为页面闪一下再被弹走。守卫把这一步提前到发请求之前。
 */
const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const token = useAppStore((s) => s.token);
  const location = useLocation();
  if (token === null || token === '') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
};

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><MainLayout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="complaints" element={<ComplaintList />} />
        <Route path="complaints/:id" element={<ComplaintDetail />} />
        <Route path="address-correction" element={<AddressCorrection />} />
        <Route path="analysis" element={<Analysis />} />
        <Route path="dispatch" element={<DispatchOrders />} />
        <Route path="dispatch/archive" element={<DispatchArchive />} />
        <Route path="companies" element={<CompanyList />} />
        <Route path="grids" element={<GridManager />} />
        <Route path="heatmap" element={<HeatmapView />} />
        <Route path="shutdowns" element={<ShutdownList />} />
        <Route path="pipelines" element={<PipelineList />} />
        <Route path="reports" element={<ReportView />} />
        <Route path="dicts" element={<DictManager />} />
        <Route path="system/users" element={<UserManager />} />
      </Route>
    </Routes>
  );
};

export default App;
