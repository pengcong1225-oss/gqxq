import { AppError } from '../http/errors';
import type { SourceStatusAdapter, SourceStatusSnapshot } from '../domain/sourceAdapter';

/**
 * 默认适配器：**关闭**。
 *
 * 它不做任何网络调用，调用即抛 501 —— 这是刻意的：
 * 未接入时宁可明确报"未实现"，也不能返回看似正常的模拟状态。
 */
export class DisabledSourceAdapter implements SourceStatusAdapter {
  readonly name = 'disabled';
  readonly enabled = false;

  async fetchBySourceId(_sourceId: string): Promise<SourceStatusSnapshot | null> {
    throw AppError.notImplemented(
      '宜接就办来源适配器未启用（批次 G6）：真实接口待对方提供，本平台不展示模拟的来源进度',
      'G6'
    );
  }
}
