import request from './request';
import type { DictCode, DictItem } from '../types/api';

/**
 * 字典项，形状 [{ value, label }]；字典类型为受控词汇表，未知 code 服务端返回 404。
 *
 * GET /dicts/:code/items
 */
export async function getDictItems(code: DictCode): Promise<DictItem[]> {
  return request.get<never, DictItem[]>(`/dicts/${encodeURIComponent(code)}/items`);
}
