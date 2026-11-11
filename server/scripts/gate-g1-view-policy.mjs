/** Reviewed data provenance for every view. New/renamed views fail until classified.
 * real: backend data only; mixed/demo: rendered disclosure required, no automatic
 * mock-rule exemption for mixed pages. Sources name the API-bearing implementation.
 */
export const VIEW_DATA_POLICY = {
  BusinessRuleManager: {mode:'real', source:'views/BusinessRuleManager.tsx', api:'../api/businessFeatures'},
  DataAlerts: {mode:'real', source:'views/DataAlerts.tsx', api:'../api/businessFeatures'},
  AppealAssessment: {mode:'real', source:'views/AppealAssessment.tsx', api:'../api/businessFeatures'},
  SeasonalAssessment: {mode:'real', source:'views/SeasonalAssessment.tsx', api:'../api/businessFeatures'},
  GridComparison: {mode:'real', source:'views/GridComparison.tsx', api:'../api/businessFeatures'},

  AddressCorrection: {mode:'real', source:'views/AddressCorrection.tsx', api:'../api/corrections'},
  Analysis: {mode:'real', source:'components/TenderStatisticsPanel.tsx', api:'../api/tenderStatistics'},
  AuditLogView: {mode:'real', source:'views/AuditLogView.tsx', api:'../api/auditLogs'},
  ChangePassword: {mode:'real', source:'views/ChangePassword.tsx', api:'../api/auth'},
  CompanyList: {mode:'real', source:'views/CompanyList.tsx', api:'../api/enterprises'},
  ComplaintDetail: {mode:'real', source:'views/ComplaintDetail.tsx', api:'../api/complaints'},
  ComplaintList: {mode:'real', source:'views/ComplaintList.tsx', api:'../api/complaints'},
  Dashboard: {mode:'real', source:'components/TenderStatisticsPanel.tsx', api:'../api/tenderStatistics'},
  DictManager: {mode:'real', source:'views/DictManager.tsx', api:'../api/masterData'},
  DispatchArchive: {mode:'real', source:'views/DispatchArchive.tsx', api:'../api/archive'},
  DispatchOrders: {mode:'real', source:'views/DispatchOrders.tsx', api:'../api/dispatch'},
  FixedReportPanel: {mode:'real', source:'views/FixedReportPanel.tsx', api:'../api/reports'},
  GridManager: {mode:'real', source:'views/GridManager.tsx', api:'../api/grids'},
  HeatmapView: {mode:'mixed', source:'views/HeatmapView.tsx', api:'../api/administrativeHeat', notices:['宜昌模拟网格 · 非真实行政边界','演示数据，非真实行政边界']},
  HeatRuleManager: {mode:'real', source:'views/HeatRuleManager.tsx', api:'../api/heatRules'},
  ImportBatchList: {mode:'real', source:'views/ImportBatchList.tsx', api:'../api/masterDataImports'},
  Login: {mode:'real', source:'views/Login.tsx', api:'../api/auth'},
  PipelineList: {mode:'real', source:'utility/UtilityEventList.tsx', api:'./api'},
  ReportView: {mode:'real', source:'views/ReportView.tsx', api:'../api/analysis'},
  RoleManager: {mode:'real', source:'views/RoleManager.tsx', api:'../api/roles'},
  ShutdownList: {mode:'real', source:'utility/UtilityEventList.tsx', api:'./api'},
  TenderSupportView: {mode:'mixed', source:'views/TenderSupportView.tsx', api:'../tenderSupport/api', notices:['模拟数据专区：边界、小区、管线、事件、评价、办结和户数均为模拟']},
  UserManager: {mode:'real', source:'views/UserManager.tsx', api:'../api/users'},
  UtilityTimeoutView: {mode:'real', source:'views/UtilityTimeoutView.tsx', api:'../utility/api'},
};

// Ignore comments: importing or mentioning a notice is not a rendered disclosure.
export const withoutComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
export function hasRenderedDemoNotice(content) {
  return /<DemoDataNotice\b[^>]*\/>/.test(withoutComments(content));
}
export function validateViewPolicy(name, content, policy, readSource) {
  if (!policy || !['real','mixed','demo'].includes(policy.mode)) return ['页面缺少有效的数据来源声明（real/mixed/demo）'];
  const errors = [], clean = withoutComments(content);
  if (policy.mode !== 'demo') {
    const source = policy.source && readSource(policy.source);
    const importedModules = source ? [...withoutComments(source).matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map(match => match[1]) : [];
    if (!policy.api || !importedModules.includes(policy.api)) errors.push('声明的真实 API 来源缺失：' + policy.source);
    if (policy.source !== 'views/' + name + '.tsx') {
      const component = policy.source?.split('/').pop().replace(/\.tsx$/, '');
      if (!component || !new RegExp('<' + component + '\\b').test(clean)) errors.push('页面未渲染声明的数据来源组件');
    }
  }
  if (policy.mode === 'demo' && !hasRenderedDemoNotice(content)) errors.push('模拟页面缺少渲染的 DemoDataNotice');
  if (policy.mode === 'mixed') {
    // These are visible Alert/Tag disclosures, not imports or dormant string constants.
    const rendered = [...clean.matchAll(/<Alert\b[^>]*>|<Tag\b[^>]*>[^<]*<\/Tag>/g)].map(m => m[0]).join('\n');
    if (!policy.notices?.length) errors.push('混合页面缺少模拟标识声明');
    for (const notice of policy.notices ?? []) if (!rendered.includes(notice)) errors.push('混合页面缺少可见模拟标识：' + notice);
  }
  return errors;
}
