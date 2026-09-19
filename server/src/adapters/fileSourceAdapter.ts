import { readFileSync } from 'node:fs';
import { AppError } from '../http/errors';
import { mapSourceStatusDetail } from '../domain/sourceAdapter';
import type { SourceStatusAdapter, SourceStatusSnapshot } from '../domain/sourceAdapter';

/**
 * 文件来源适配器：把**来源系统导出的状态快照**当作来源系统来读。
 *
 * 为什么要有它：宜接就办的真实状态接口尚未提供（见 adapters/index.ts 里那条注释），
 * 但对方能导出「案件公文号 → 督办状态」的静态快照。把这份快照做成一个**正牌适配器**，
 * 而不是写脚本直接改库，好处是**不新增任何写路径**：
 *   POST /complaints/:idOrNo/source-sync
 *     -> sourceStatusService.syncComplaintSource（第 5 步）
 *     -> sourceSyncRepo.updateSourceEventStatus（只写 source_event_status / overtime_flag / source_synced_at）
 *     -> sync_log 留痕
 * 即：本文件只是"用手工导出的数据喂给既有同步路径"，写 source_event_status 与 overtime_flag
 * 的仍然只有那一条代码路径。
 *
 * 快照 JSON 结构（**就这一种**）：
 *   { "<来源案件公文号>": "<督办状态中文>" }
 * 例：
 *   { "DH202604060770": "正常结案", "HB202609113302": "正常在办" }
 *
 * 生成方式：`python scripts/dump-source-status-snapshot.py --out <仓库外的路径.json>`。
 * 快照含真实案卷号，**必须落在仓库外，不要提交**。
 *
 * 本适配器**不做码位改写**：返回的 rawStatus 永远是快照里的原文。
 * 中文 → （状态码 + 时效标记）由 domain/sourceAdapter.ts 的 mapSourceStatusDetail 完成（单一真源），
 * 由 sourceStatusService 第 4/5 步消费：
 *   * 正常在办 -> processing + overtime_flag 保持 NULL（来源没给时效结论，不谎报"未超期"）；
 *   * 正常结案 -> completed + 0；超期结案 -> completed + 1（超期是**时效**维度、不是状态维度）；
 *   * 其它值   -> 服务记 sync_log.result='unmapped'、**两轴都保留原值**、updated=false，绝不猜。
 * 所以这里遇到认不出的状态**既不抛错也不吞掉**：
 *   * 抛错会让整次同步失败（把"一条数据认不出"升级成"同步不可用"）；
 *   * 返回 null 会被服务记成「来源系统没有该事件」——那是另一句假话。
 */
export class FileSourceAdapter implements SourceStatusAdapter {
  readonly name = 'file';
  readonly enabled = true;

  private readonly filePath: string;
  /** 首次调用时读一次并缓存（快照在一次进程生命周期内不会变） */
  private statuses: Map<string, string> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath.trim();
  }

  /** 快照文件路径，供 /source-status 与日志展示 */
  get path(): string {
    return this.filePath;
  }

  /**
   * 读取并校验快照。**读不到 / 解析不了 / 结构不对一律抛错**，
   * 绝不返回空快照假装成功——那会变成"同步成功但什么都没同步"的静默失败。
   */
  private load(): Map<string, string> {
    if (this.statuses !== null) return this.statuses;

    if (this.filePath === '') {
      throw new AppError('SOURCE_ADAPTER_UNAVAILABLE', '来源快照未配置：GQXQ_YJJB_FILE 为空');
    }

    let text: string;
    try {
      text = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw new AppError(
        'SOURCE_ADAPTER_UNAVAILABLE',
        '来源快照文件读不到：' + this.filePath + '（' + (err instanceof Error ? err.message : String(err)) + '）',
        { cause: err }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AppError(
        'SOURCE_ADAPTER_UNAVAILABLE',
        '来源快照不是合法 JSON：' + this.filePath + '（' + (err instanceof Error ? err.message : String(err)) + '）',
        { cause: err }
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppError(
        'SOURCE_ADAPTER_UNAVAILABLE',
        '来源快照必须是 {"<案件公文号>": "<督办状态>"} 形式的 JSON 对象，实际为 ' +
          (Array.isArray(parsed) ? 'array' : typeof parsed)
      );
    }

    const record = parsed as Record<string, unknown>;
    const map = new Map<string, string>();
    const badValues: string[] = [];
    const badKeys: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (key.trim() === '') {
        badKeys.push(key);
        continue;
      }
      if (typeof value !== 'string' || value.trim() === '') {
        badValues.push(key);
        continue;
      }
      map.set(key.trim(), value);
    }
    if (badKeys.length > 0 || badValues.length > 0) {
      throw new AppError(
        'SOURCE_ADAPTER_UNAVAILABLE',
        '来源快照结构不合法：空键 ' + badKeys.length + ' 条、空/非字符串状态值 ' + badValues.length +
          ' 条（例：' + [...badKeys, ...badValues].slice(0, 3).join(', ') + '）'
      );
    }
    if (map.size === 0) {
      throw new AppError('SOURCE_ADAPTER_UNAVAILABLE', '来源快照是空对象，没有任何可同步的状态：' + this.filePath);
    }

    this.warnUnmappable(map);
    this.statuses = map;
    return map;
  }

  /**
   * 加载期一次性告警：把快照里**认不出**的状态集中报出来，
   * 免得"某天源改了状态名"只能靠逐条 sync_log 才发现。
   * 只告警、不改写：逐条的处理仍由 service 的 unmapped 分支负责（留痕 + 保留原状态）。
   */
  private warnUnmappable(map: Map<string, string>): void {
    const unknown = new Map<string, number>();
    for (const raw of map.values()) {
      if (mapSourceStatusDetail(raw) !== null) continue;
      const key = raw.trim();
      unknown.set(key, (unknown.get(key) ?? 0) + 1);
    }
    if (unknown.size === 0) return;
    const total = Array.from(unknown.values()).reduce((a, b) => a + b, 0);
    const detail = Array.from(unknown.entries())
      .map(([value, count]) => JSON.stringify(value) + '×' + count)
      .join('、');
    console.warn(
      '[source-adapter:file] 快照里有 ' + total + ' 条认不出的督办状态，将被跳过（保留原状态并记 sync_log.result=unmapped）：' + detail
    );
  }

  async fetchBySourceId(sourceId: string): Promise<SourceStatusSnapshot | null> {
    const map = this.load();
    const key = sourceId.trim();
    const rawStatus = map.get(key);
    // 快照里没有这个案卷号 -> 来源系统没有该事件（契约里的正常情况，不是错误）
    if (rawStatus === undefined) return null;
    return {
      sourceId: key,
      rawStatus,
      // 快照不带来源声明的时间：不编造，置 null（service 当前也不消费该字段）
      updatedAt: null,
      raw: { 案件公文号: key, 督办状态: rawStatus, 快照文件: this.filePath },
    };
  }
}
