# D3 固定模板统计报告

`statistics-draft/v1` 是工程草稿。统计比较、户数、满意度与热力政策尚未获得正式业务核准，产物不代表审批、发布或对外发送。

## 使用

报告页面选择数据集、投影、月份/季度/年度截至日或自定义日期及编码筛选，选择 DOCX 或 XLSX 后生成。分析库必须显式选择 current 或 entry_snapshot。可显式选择热力数据；没有 heatmap.read 不提供该选项，服务端也拒绝该请求。Q7 未确认时显示不可用和实际原因。

生成后返回真实 pending 任务。页面每15秒刷新可见未完成任务，也可手动刷新。只有 succeeded 产物提供下载；生成失败显示稳定原因，可由有权操作者重试原快照。输入相同的 requestId 与载荷返回同一报告；改变载荷返回409。

分析库报告可显式关联选中的报告待办，待办必须属于本期实际冻结的分析集合。只在产物、成功状态与审计同时提交后标记 done。已有可核验成功产物的 first-link 保留；未知旧关联不自动覆盖。台账报告不能关联分析待办。

## 接口

| 方法 | `/api/v1` 路径 | 行为 |
|---|---|---|
| POST | `/reports` | 冻结真实统计/权限事实并创建任务 |
| GET | `/reports?size=20&continuation=...` | 全授权 SQL 后分页；content/hasMore/continuation，无隐藏 total |
| GET | `/reports/:reportId` | 读取状态与安全元数据 |
| GET | `/reports/:reportId/download` | 校验当前全部权限、完整范围及存储字节后下载 |
| POST | `/reports/:reportId/retry` | 空载荷，同一快照和 renderer 版本重试 |

创建载荷为 `{requestId,templateCode:"statistics-draft",templateVersion:"v1",query,format:"docx"|"xlsx",includeHeat:false,todoIds:[]}`。query 复用 D1 StatisticsQuery 严格格式。下载只接受服务端 reportId，固定服务端格式、文件名和 MIME，无文件路径或 URL 参数。

创建/重试/完成要求 report.generate、statistics.read、complaint.read 及 dashboard.read 或 analysis.read；重试还要求 report.retry。读取/列表要求 report.read 与全部冻结内容能力，下载另要求 report.download。实际冻结户数主档/网格/可选热力事实分别要求 enterprise.read/grid.read/heatmap.read。只读角色不能创建或重试。

首次迁移给已有 report.read 的内置角色增加 report.download，仅内置 admin 获 report.retry。自定义角色需显式授权；后续迁移不会恢复已撤销授权。

## 快照与范围

D1 capture 在一个只读 RR snapshot 中取得本期、比较期间、排除记录、分类名称/版本、历史户数值/版本、实际网格几何/版本、selectedBusinessDays 与原主档/诉求范围事实。选择热力时只调用一次 D2 captureHeatIn，冻结其同一 snapshot 中的统计、聚合数据、实际 ruleVersion 和完整规则/政策确认事实。产物没有诉求原件、逐条标题或隐私附录。

保存前另起 READ COMMITTED 事务，在 A5 授权 singleton 与当前对象锁下复核当前账号/能力、完整原查询域及所有原/当前对象。原查询域包括 normalized query、所有比较范围和此次 capture 使用的 normalized AND/OR 有效规则；空结果与空 OR 分支同样要求覆盖。入库投影或其他无法有限证明的范围采用保守拒绝。没有关联证明、对象已消失或缺少任何所需范围时拒绝整个旧产物，不删行保留旧总数。相同完整 SQL predicate 也约束 A6 报告审计与分页。

## 持续任务与存储

现有 report_record.id 主键、旧行与原字段不改写。新增 nullable UNIQUE d3_report_id 只标识同一行的新增报告；report_job/report_artifact 使用此1:1映射，report_todo.report_id 指向相同稳定业务标识。旧行保持 NULL，不伪造旧报告身份或成功关联。

snapshot 与最终二进制保存在有界 DB 表中。产物 hash/MIME/length 随 job succeeded、所选 todo done 和 audit 同事务提交。worker 启动扫描 persisted pending 或 DB 时间已过期的 generating 任务，使用 DB 时间租约、owner token 与递增 fence；旧 worker 不能完成新租约。完成前重新读取执行发起人当前 active identity/grants 和全部冻结范围，撤权后记录 AUTH_CHANGED，不产生成功产物或完成待办。有权操作者可显式成为新的 retry 执行发起人，数据快照保持不变。

成功下载始终返回存储的原字节。冻结 renderer 为 `statistics-draft-v1/docx9.9.0-exceljs4.4.0/2`，旧 renderer 不存在时明确 RENDERER_UNAVAILABLE，不自动重新捕获、升级或改版。DOCX 小数只在展示中取两位，XLSX 原数值保留实际精度。OOXML 时间和图片 docPr 编号按文档冻结；不修改实际聚合内容。

当前对象按 enterprise → admin → community → grid → complaint 顺序锁定，并重验探测到的父级关联。末尾 complaint 使用 SHARE NOWAIT，避免与既有责任单位确认的 complaint → enterprise 顺序形成等待环。相关诉求正在业务修改时，接口立即回滚并返回 `REPORT_BUSY`（409）；稍后刷新或由有权操作者重试。生成完成遇忙记录 `REPORT_BUSY` 失败原因，不写成功产物、不完成待办；显式重试仍使用原冻结快照。父对象锁保持正常等待，短时并发可能需要额外刷新或重试。

## 工程限额与迁移

当前及全部比较/排除期间去重最多20000对象，serialized snapshot 和单产物各16MiB，单 string 最多8192 UTF-8字节。有限证明最多100000项、100条授权规则、每维每规则最多200个编码；保留 D1/D2 更严格的资源拒绝。DB 实际 max_allowed_packet 更小时明确拒绝并提示缩小选择，不改 MySQL 全局参数，不截断假成功。

当前没有 canonical 外部完整 DDL。本次仅验证明确声明的相关 legacy component fixture 加真实增量 migrations，不是 M0/canonical PASS。170000迁移在任何 DDL 前检查旧 report_record 所需字段/类型、既有 auto numeric id/full unique、未知必填列、附加 UNIQUE 实际插入约束、report_todo.report_id，以及 owned/shared insert 依赖的类型、nullability、完整非 prefix identity/default。显式插入的 legacy 字段与已有 d3_report_id 若为 GENERATED/auto_increment，同样在任何 DDL 前拒绝。未知 mandatory/no-default 依赖或不兼容唯一约束直接失败；不会重建表或清历史。MySQL DDL 不提供跨语句原子回滚；down 明确拒绝自动删数据，保留状态供操作员处理。

重启证据来自仅运行报告任务的独立 synthetic 子进程，未启动生产应用、provider 或全库任务。最终样稿使用真实 stored artifacts，并经 DOCX 每页、XLSX 每 sheet 和原始 OOXML/图数独立检查。
