import type { SupportComplaint, SupportWarningRule, TenderDataset } from '../types/tenderSupport';

export type SeasonKind = 'winter' | 'summer';
export interface DayRange { from: string; to: string }
export interface ResearchSeason extends DayRange { year: number; fullTo: string; rows: SupportComplaint[] }
export interface SeasonResearch {
  kind: SeasonKind; years: ResearchSeason[]; current: ResearchSeason; previous: ResearchSeason;
  months: { month: number; label: string; currentRange: DayRange; previousRange: DayRange; currentRows: SupportComplaint[]; previousRows: SupportComplaint[] }[];
  topGrids: { id: string; name: string; rows: SupportComplaint[]; previousRows: SupportComplaint[] }[];
}
const DAY = 86400000;
const scenarios = ['winter', 'summer', 'planned', 'installation'] as const;
export function isLocalDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
/** API timestamps are converted to Asia/Shanghai dates, independent of browser timezone. */
export function localDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !isLocalDate(value.slice(0, 10))) return null;
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10);
}
export function addDays(day: string, amount: number): string { return new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY).toISOString().slice(0, 10); }
function previousYear(day: string): string {
  const year = Number(day.slice(0, 4)) - 1;
  const candidate = `${year}${day.slice(4)}`;
  return isLocalDate(candidate) ? candidate : `${year}-02-28`;
}
export function seasonWindow(kind: SeasonKind, year: number): DayRange {
  return kind === 'winter' ? { from: `${year - 1}-11-01`, to: `${year}-03-31` } : { from: `${year}-06-01`, to: `${year}-09-30` };
}
export function validateWarningRules(rules: SupportWarningRule[]): string | null {
  if (rules.length !== 4 || new Set(rules.map(r => r.scenario)).size !== 4 || scenarios.some(s => !rules.some(r => r.scenario === s))) return '必须完整配置冬季、夏季、计划停供、安装四类预警。';
  if (rules.some(r => !Number.isSafeInteger(r.threshold) || r.threshold <= 0 || !Number.isSafeInteger(r.days) || r.days <= 0 || r.days > 3660)) return '阈值与观察天数必须为正整数，观察天数不超过3660天。';
  if (rules.some(r => typeof r.enabled !== 'boolean' || !r.name.trim())) return '预警名称和启用状态无效。';
  return null;
}
function inRange(rows: SupportComplaint[], range: DayRange): SupportComplaint[] {
  return rows.filter(r => { const day = localDay(r.occurredAt); return day !== null && day >= range.from && day <= range.to; });
}
function buildSeason(data: TenderDataset, kind: SeasonKind, asOf: string): SeasonResearch {
  const year = Number(asOf.slice(0, 4)), month = Number(asOf.slice(5, 7));
  const latestYear = kind === 'winter' ? (month >= 11 ? year + 1 : year) : (month >= 6 ? year : year - 1);
  const pressureRows = data.complaints.filter(r => r.businessType === (kind === 'winter' ? 'gas' : 'water') && r.type === (kind === 'winter' ? '气压问题' : '水压问题'));
  const years = Array.from({ length: 5 }, (_, i): ResearchSeason => {
    const seasonYear = latestYear - 4 + i, full = seasonWindow(kind, seasonYear);
    const range = { from: full.from, to: full.to < asOf ? full.to : asOf };
    return { ...range, fullTo: full.to, year: seasonYear, rows: inRange(pressureRows, range) };
  });
  const current = years[4], previous = years[3];
  const monthNumbers = kind === 'winter' ? [11, 12, 1, 2, 3] : [6, 7, 8, 9];
  const monthRange = (seasonYear: number, m: number): DayRange => {
    const calendarYear = kind === 'winter' && m >= 11 ? seasonYear - 1 : seasonYear;
    const from = `${calendarYear}-${String(m).padStart(2, '0')}-01`;
    return { from, to: new Date(Date.UTC(calendarYear, m, 0)).toISOString().slice(0, 10) };
  };
  const months = monthNumbers.map(m => {
    const currentRange = monthRange(current.year, m), previousRange = monthRange(previous.year, m);
    return { month: m, label: `${m}月`, currentRange, previousRange, currentRows: inRange(current.rows, currentRange), previousRows: inRange(previous.rows, previousRange) };
  });
  const gridRows = new Map<string, SupportComplaint[]>();
  current.rows.forEach(r => gridRows.set(r.gridId, [...(gridRows.get(r.gridId) || []), r]));
  const topGrids = [...gridRows].map(([id, rows]) => ({ id, name: data.grids.find(g => g.id === id)?.name || `未匹配网格（${id || '空'}）`, rows, previousRows: previous.rows.filter(r => r.gridId === id) }))
    .sort((a, b) => b.rows.length - a.rows.length || a.id.localeCompare(b.id, 'en')).slice(0, 6);
  return { kind, years, current, previous, months, topGrids };
}
export function buildSupportResearch(data: TenderDataset, from: string, to: string, rules: SupportWarningRule[]) {
  const rangeValid = isLocalDate(from) && isLocalDate(to) && from <= to;
  // Invalid selections have no source records; callers show range validation feedback.
  const safeTo = isLocalDate(to) ? to : '2000-01-01';
  const source = rangeValid ? data : { ...data, complaints: [] };
  const priorRange = { from: previousYear(isLocalDate(from) ? from : safeTo), to: previousYear(safeTo) };
  const priorRows = inRange(source.complaints, priorRange);
  const grouped = new Map<string, SupportComplaint[]>();
  priorRows.forEach(r => grouped.set(r.type, [...(grouped.get(r.type) || []), r]));
  const priorTop3 = [...grouped].map(([name, rows]) => ({ name, rows })).sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 3);
  const warnings = rules.map(rule => {
    const valid = Number.isSafeInteger(rule.days) && rule.days > 0 && rule.days <= 3660 && Number.isSafeInteger(rule.threshold) && rule.threshold > 0;
    const range = { from: valid ? addDays(safeTo, 1 - rule.days) : safeTo, to: safeTo };
    const rows = valid ? inRange(source.complaints.filter(r => r.scenario === rule.scenario), range) : [];
    return { rule, ...range, rows, triggered: valid && rule.enabled && rows.length >= rule.threshold };
  });
  return { rangeValid, priorRange, priorTop3, warnings, winter: buildSeason(source, 'winter', safeTo), summer: buildSeason(source, 'summer', safeTo) };
}
