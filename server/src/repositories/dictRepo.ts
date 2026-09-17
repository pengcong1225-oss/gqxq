// 字典读取：优先 dict_type / dict_item（库中已有 12 项），库中缺失时回退受控词汇表。
// 回退不是"假数据"：DICT 是 domain/enums.ts 里的受控词汇表（与校验用合法集合同源）。
import { pool, type Row } from '../db/pool';
import type { DictItem } from '../types/api';
import { DICT, type DictCode } from '../domain/enums';

/** 对外支持的字典编码。未在其中的一律 404（路由层判定）。 */
export const SUPPORTED_DICT_CODES = [
  'business_type',
  'complaint_type',
  'urgency_level',
  'correction_status',
  'supervision_status',
  'reporting_status',
  'source_event_status',
  'source_system',
  // district 由 M5 迁移登记（GB/T 2260 行政区划），comment 表用 district_code 过滤
  'district',
] as const;

export type SupportedDictCode = (typeof SUPPORTED_DICT_CODES)[number];

export function isSupportedDictCode(code: string): code is SupportedDictCode {
  return (SUPPORTED_DICT_CODES as readonly string[]).includes(code);
}

/** 库中无该字典类型时，退回 domain/enums.ts 的受控词汇表 */
function fallbackItems(code: SupportedDictCode): DictItem[] {
  if (!Object.prototype.hasOwnProperty.call(DICT, code)) return [];
  const table = DICT[code as DictCode] as Record<string, string>;
  return Object.entries(table).map(([value, label]) => ({ value, label }));
}

/**
 * source_system 既没有字典表、也没有枚举常量。
 * 退回"库中实际出现过的来源系统取值"——这是真实数据，不是编造。
 */
async function findObservedSourceSystems(): Promise<DictItem[]> {
  const [rows] = await pool.query<Row[]>(
    'select distinct c.source_system as value from complaint c' +
      " where coalesce(c.deleted, 0) = 0 and c.source_system is not null and c.source_system <> ''" +
      ' order by c.source_system asc'
  );
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    value: String(r.value),
    label: String(r.value),
  }));
}

export async function findDictItems(code: SupportedDictCode): Promise<DictItem[]> {
  const [rows] = await pool.query<Row[]>(
    "select item_value as value, item_label as label from dict_item where dict_type = ? and status = 'enabled' order by id asc",
    [code]
  );
  const items = (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    value: String(r.value),
    label: String(r.label ?? r.value),
  }));
  if (items.length > 0) return items;

  const fallback = fallbackItems(code);
  if (fallback.length > 0) return fallback;

  if (code === 'source_system') return findObservedSourceSystems();
  return [];
}
