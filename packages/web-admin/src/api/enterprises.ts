import request from './request';
import type {
  Csv,
  EnterpriseDetail,
  EnterpriseListItem,
  EnterpriseParams,
  Paged,
} from '../types/api';

/** 协议要求多值参数为「逗号分隔字符串」；此处同时接受数组，统一在 api 层序列化。 */
function toCsv<T extends string>(value: Csv<T> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(',');
}

/**
 * 企业主数据列表（服务端分页 / 筛选）。
 *
 * 用途：匹配责任单位与发起交办时的企业选择。
 * 不允许前端硬编码企业清单——手抄的 enterprise_code 一旦与登记值不一致，
 * 后续交办就会匹配不到同一主体。
 *
 * GET /enterprises
 */
export async function listEnterprises(
  params: EnterpriseParams = {}
): Promise<Paged<EnterpriseListItem>> {
  const query = {
    page: params.page,
    size: params.size,
    keyword: params.keyword,
    businessType: toCsv(params.businessType),
    status: params.status,
  };
  return request.get<never, Paged<EnterpriseListItem>>('/enterprises', { params: query });
}

/**
 * 企业详情。
 *
 * GET /enterprises/:enterpriseCode
 */
export async function getEnterprise(enterpriseCode: string): Promise<EnterpriseDetail> {
  return request.get<never, EnterpriseDetail>(
    '/enterprises/' + encodeURIComponent(enterpriseCode)
  );
}

export async function listEnterpriseOptions(params:EnterpriseParams={}) {
 const content=await request.get<never,import('../types/api').EnterpriseOption[]>('/enterprise-options',{params:{keyword:params.keyword}});
 return {content,total:content.length,page:1,size:100,totalPages:1};
}
export function saveEnterprise(input:import('../types/api').EnterpriseWriteInput) {
 return input.expectedVersion ? request.patch<never,{value:EnterpriseDetail}>('/enterprises/'+encodeURIComponent(input.enterpriseCode),input) : request.post<never,{value:EnterpriseDetail}>('/enterprises',input);
}
export function listHouseholds(code:string){return request.get<never,import('../types/api').HouseholdVersion[]>('/enterprises/'+encodeURIComponent(code)+'/households');}
export function saveHouseholds(code:string,input:{households:number|null;validFrom:string;validTo:string|null;expectedVersion:number}){return request.post('/enterprises/'+encodeURIComponent(code)+'/households',input);}
export function listDepartmentMappings(code:string){return request.get<never,import('../types/api').DepartmentMapping[]>('/enterprises/'+encodeURIComponent(code)+'/department-mappings');}
export function saveDepartmentMapping(code:string,input:Omit<import('../types/api').DepartmentMapping,'version'|'enterpriseCode'> & {expectedVersion:number;expectedEnterpriseVersion:number}){return request.post('/enterprises/'+encodeURIComponent(code)+'/department-mappings',input);}

export function getEnterpriseReferenceOptions(){return request.get<never,{businessTypes:import('../types/api').DictItem[];districts:import('../types/api').DictItem[]}>('/enterprise-reference-options');}
