/** Stable endpoint capabilities. Only registered codes can be stored on a role. */
export const PERMISSION_CATALOG = [
  ['followup.create', '人工回访登记及本人更正'], ['followup.conclude', '主管独立回访结论'],
  ['complaint.read', '诉求查询'], ['complaint.assign', '责任单位匹配'],
  ['complaint.disposition', '诉求归库'], ['complaint.correct', '诉求纠偏'],
  ['complaint.close', '本系统办结'], ['complaint.source_sync', '来源状态回填'],
  ['enterprise.read', '企业查询'], ['enterprise.manage', '企业维护'],
  ['dashboard.read', '大屏查询'], ['dict.read', '字典查询'],
  ['dispatch.read', '交办查询及填报材料'], ['dispatch.create', '创建交办'],
  ['dispatch.cancel', '撤销交办'], ['dispatch.push', '推送交办'],
  ['dispatch.reconcile', '交办核对'], ['dispatch.archive', '交办归档'],
  ['analysis.read', '分析查询'], ['report.read', '报告查询'],
  ['report.generate', '报告生成'], ['report.download', '报告下载'],
  ['source_document.read', '来源文档查询'], ['source_status.read', '来源状态查询'],
  ['grid.read', '网格查询'], ['grid.manage', '网格维护'],
  ['shutdown.read', '停供查询'], ['pipeline.read', '施工查询'], ['heatmap.read', '热力图查询'],
  ['system.users.manage', '平台账号管理'], ['system.roles.manage', '角色授权管理'],
  ['system.audit.read', '审计查询'], ['system.dict.manage', '字典维护'],
  ['system.address.backfill', '地址候选补提取'], ['system.integration.manage', '旧集成管理'],
  ['masterdata.import', '基础数据导入（另需目标维护权限与范围）'],
] as const;
export type PermissionCode = (typeof PERMISSION_CATALOG)[number][0];
export const PROTECTED_PERMISSIONS: readonly PermissionCode[] = ['system.users.manage', 'system.roles.manage'];
export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_CATALOG.some(([code]) => code === value);
}
export interface EffectiveAuthorization {
  roleCodes: string[];
  permissionCodes: PermissionCode[];
  authorizationVersion: number;
}
export interface PlatformRole {
  roleCode: string;
  name: string;
  description: string;
  enabled: boolean;
  builtIn: boolean;
  version: number;
  permissionCodes: PermissionCode[];
}
