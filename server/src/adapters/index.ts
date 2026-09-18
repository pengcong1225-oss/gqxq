import { env } from '../config/env';
import type { SourceStatusAdapter } from '../domain/sourceAdapter';
import { DisabledSourceAdapter } from './disabledSourceAdapter';
import { FileSourceAdapter } from './fileSourceAdapter';

const disabled = new DisabledSourceAdapter();

/**
 * adapter=file 时复用同一个实例：快照只在首次调用时读一次并缓存。
 * 在模块加载期构造（而不是每次 resolve 都 new），否则每次请求都会重读一遍快照文件。
 * 读文件是**懒执行**的：文件缺失/损坏不会拖垮服务启动，
 * 而是在真正同步时由 fetchBySourceId 如实抛错（见 fileSourceAdapter.load）。
 */
const filePath = env.yijiejieban.file.trim();
const fileAdapter = filePath === '' ? null : new FileSourceAdapter(filePath);

export interface SourceAdapterResolution {
  adapter: SourceStatusAdapter;
  /** 配置里写了不受支持的形态 / 形态配置不完整 —— 该配置当前无效 */
  misconfigured: boolean;
  message: string;
}

/**
 * 有效形态只有两种：disabled（默认）与 file（读仓库外的快照 JSON）。
 *
 * 若有人把 GQXQ_YJJB_ADAPTER 配成别的值，这里**不会**去构造一个假适配器，
 * 而是继续用 disabled 并标记 misconfigured，让 /source-status 如实报出来。
 * 既不静默忽略配置，也不假装对接成功。
 *
 * file 形态但没配 GQXQ_YJJB_FILE 时同理：回退 disabled + misconfigured，
 * 把"缺哪个环境变量"直接写进 message，而不是起一个永远读不到快照的适配器。
 */
export function resolveSourceAdapter(): SourceAdapterResolution {
  const configured = env.yijiejieban.adapter.trim().toLowerCase();
  if (configured === '' || configured === 'disabled') {
    return { adapter: disabled, misconfigured: false, message: '来源适配器已关闭，来源状态保持「未接入」' };
  }
  if (configured === 'file') {
    if (fileAdapter === null) {
      return {
        adapter: disabled,
        misconfigured: true,
        message:
          '配置的适配器「file」缺少快照文件：请设置 GQXQ_YJJB_FILE 指向**仓库外**的状态快照 JSON' +
          '（结构 {"<案件公文号>": "<督办状态中文>"}，由 scripts/dump-source-status-snapshot.py 生成）。' +
          '未配置即回退为关闭状态，不会返回任何模拟数据',
      };
    }
    return {
      adapter: fileAdapter,
      misconfigured: false,
      message: '来源适配器为「file」：从快照 JSON 读取只读来源状态（' + fileAdapter.path + '）',
    };
  }
  return {
    adapter: disabled,
    misconfigured: true,
    message:
      '配置的适配器「' + configured + '」尚不可用：宜接就办真实接口契约未提供，已回退为关闭状态（不会返回任何模拟数据）',
  };
}
