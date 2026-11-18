import type { ScreenSection, ScreenSections } from '../types/screen';
import type { TenderDataset } from '../types/tenderSupport';
import type { HouseholdEvidence } from '../types/statistics';
import type { SupportCommunity } from '../types/tenderSupport';
import type { buildScreen } from './screen';
function spatialSection(result: ReturnType<typeof buildScreen>, dataset: TenderDataset | null, spatialAllowed: boolean, permissions: readonly string[], communityPoints: SupportCommunity[]): ScreenSections['spatial'] {
  const communities = spatialAllowed ? (dataset ? dataset.communities : communityPoints) : [];
  const available = spatialAllowed && (dataset !== null || communities.length > 0);
  const reason = !spatialAllowed ? '缺少网格或热力权限' : dataset ? null : communities.length > 0 ? '网格边界未核验；小区点位为主数据定位结果，抖动坐标仅用于地图展示' : '正式空间资源尚未核验';
  return { state: available ? 'available' : 'unavailable', reason, data: { grids: spatialAllowed ? (dataset?.grids ?? []) : [], communities, events: spatialAllowed ? result.events : [], pipelines: spatialAllowed && permissions.includes('pipeline.read') ? (dataset?.pipelines ?? []) : [] } };
}

function section<T>(state: ScreenSection<T>['state'], reason: string | null, data: T): ScreenSection<T> { return { state, reason, data }; }
const emptyEvaluation = () => ({ evaluatedCount: null, satisfiedCount: null, unsatisfiedCount: null, unevaluatedCount: null, percent: null });
export function normalizeScreen(result: ReturnType<typeof buildScreen>, dataset: TenderDataset | null, permissions: readonly string[], households: HouseholdEvidence[] = [], communityPoints: SupportCommunity[] = []): ScreenSections {
  const demo = result.demonstration;
  const spatialAllowed = permissions.includes('grid.read') && permissions.includes('heatmap.read');
  const enterprisesAllowed = permissions.includes('enterprise.read');
  const prior = result.priorTop3;
  const enterpriseRates = enterprisesAllowed ? (demo ? demo.enterpriseRates.map((x: any) => ({ id: x.id, name: x.name, count: x.count, households: x.households, per10k: x.per10k, reason: x.households === null ? '无有效户数' : null, version: null, at: result.window.to })) :
    households.map(x => ({ id: x.enterpriseCode, name: x.displayName ?? null, count: result.details.filter(d => d.enterpriseCode === x.enterpriseCode).length, households: x.households, per10k: x.value, reason: x.reason, version: x.version, at: x.at }))) : [];
  const communityNames = new Map(communityPoints.map(x => [x.id, x.name]));
  const communities = spatialAllowed ? (demo ? demo.communities : result.charts.community.map((x, i) => ({ id: x.code, name: communityNames.get(x.code) ?? null, count: x.count, rank: i + 1 }))) : [];
  const duration = demo?.duration ?? ['le24', '24to48', '48to72', 'gt72'].map(key => ({ key, count: null, evaluation: emptyEvaluation() }));
  const unsatisfiedBusiness = demo?.unsatisfiedBusiness ?? ['water', 'gas'].map(businessType => ({ businessType, count: null, percent: null }));
  const seasons = demo?.seasons?.map((x: any) => ({ ...x, topGrids: spatialAllowed ? x.topGrids : [] })) ?? ['winter', 'summer'].map(kind => ({ kind, years: [], months: [], topGrids: [] }));
  const warningItems = demo?.warnings ?? ['winter', 'summer', 'planned', 'installation'].map(scenario => ({ scenario, from: null, to: null, count: null, triggered: null,threshold:null,days:null,enabled:null,ruleVersion:null }));
  const topItems = demo ? demo.priorTop3.map((x: any) => ({ code: x.name, count: x.count })) : prior.items;
  return {
    supply: section('partial', result.mode === 'real' ? '户数、空间覆盖及统计政策待确认' : '模拟样本', { enterpriseRates, communities, monthly: result.charts.monthly, regions: result.charts.district }),
    dynamic: section(result.mode === 'simulation' ? 'available' : 'partial', result.mode === 'real' ? '正式评价及完成时间政策待确认' : null, { evaluation: demo?.evaluation ?? emptyEvaluation(), unsatisfiedBusiness, duration, hourly: result.dynamicCharts.hourly, weekly: result.dynamicCharts.weekly, monthly: result.dynamicCharts.monthly }),
    top3: section('partial', result.mode === 'simulation' ? '模拟样本' : '历史数据覆盖尚未核验', { items: topItems, from: prior.from, to: prior.to, coverage: result.mode === 'simulation' ? '独立模拟样本' : '仅已接入并识别的正式来源，历史覆盖未知' }),
    warnings: section(demo ? 'available' : 'unavailable', demo ? null : '已发布预警规则及分类尚未核验', { items: warningItems }),
    research: section(demo ? 'available' : 'unavailable', demo ? null : '历史覆盖及季节政策尚未确认', { seasons }),
    spatial: spatialSection(result, dataset, spatialAllowed, permissions, communityPoints),
  };
}
