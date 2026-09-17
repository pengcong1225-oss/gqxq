import { env } from '../config/env';
import type { SourceStatusAdapter } from '../domain/sourceAdapter';
import { DisabledSourceAdapter } from './disabledSourceAdapter';

const disabled = new DisabledSourceAdapter();

export interface SourceAdapterResolution {
  adapter: SourceStatusAdapter;
  /** 配置里写了非 disabled，但真实接口尚未提供 —— 该配置当前无效 */
  misconfigured: boolean;
  message: string;
}

/**
 * 目前只有 disabled 一种有效形态。
 *
 * 若有人把 GQXQ_YJJB_ADAPTER 配成别的值，这里**不会**去构造一个假适配器，
 * 而是继续用 disabled 并标记 misconfigured，让 /source-status 如实报出来。
 * 既不静默忽略配置，也不假装对接成功。
 */
export function resolveSourceAdapter(): SourceAdapterResolution {
  const configured = env.yijiejieban.adapter.trim().toLowerCase();
  if (configured === '' || configured === 'disabled') {
    return { adapter: disabled, misconfigured: false, message: '来源适配器已关闭，来源状态保持「未接入」' };
  }
  return {
    adapter: disabled,
    misconfigured: true,
    message:
      '配置的适配器「' + configured + '」尚不可用：宜接就办真实接口契约未提供，已回退为关闭状态（不会返回任何模拟数据）',
  };
}
