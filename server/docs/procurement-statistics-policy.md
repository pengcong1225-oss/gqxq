# 可选采购统计口径

默认 `candidate-calendar-v1` 与 `statistics-draft` 固定报告保持原有范围。后台“统计口径”选择“标书采购范围”后使用 `procurement-source-completed-v2`，报告同时选用 `procurement-statistics` 模板；不会改写诉求或改变默认大屏口径。

## 纳入范围（标书 1.1.1）

仅纳入来源系统为宜接就办、业务为 water/gas、来源状态明确为 completed、保留有效 source_synced_at 且有有效来源录入日期的案件。closed、平台 closed_in_system、来源流程节点的完成日期不能代替来源 completed。期间按上海时区的来源录入日期筛选；缺日期不回退平台接收时间，排除原因在摘要中返回。

新入分析库的统计快照为 v2，冻结 sourceId/sourceSystem/sourceEventStatus/sourceSyncedAt。v1 快照继续按原默认统计读取，但采购口径因缺来源证据排除；不会用当前案件状态替旧快照补证。当前取值与入库时取值仍由用户明确选择。

## 满意度（标书 1.2.3）

只查询所选授权案件的 source_business_head 当前回访版本。持久化 followup_binding 必须与回访 sourceId、目标 complaintId、案件 sourceSystem/sourceId 一致；无绑定或身份漂移不计入。每诉求取唯一末次回访：没有时间、末次同时间多记录、未接通、没有 satisfied/dissatisfied 评价均排除，不能回退更早的好评。满意度 = 满意数 / 有效评价数；分母为零返回不可用。该末次规则与跨来源优先级仍标注待业务确认，不将未评价视为不满意。

## 固定报告（标书 1.1.14）

保留同步分支已有供水供气年季月分类型同比环比、趋势、热力、授权范围锁和冻结快照。采购模板另增满意度与回访排除说明。报告冻结本次计算考虑过的回访版本、可信绑定、选中证据和排除原因；下载不回查当前回访重新计算。当前旧模板 renderer /2 和 /3 继续支持，采购增强模板单独使用 procurement-statistics renderer /2。

## 验证

`server/tests/procurement-statistics.test.ts` 覆盖来源边界、v1/v2不补证、可信绑定、末次冲突、冻结证据以及 DOCX/XLSX 导出；`workflow-navigation.test.tsx` 验证默认模板与显式切换后提交的采购模板。既有 fixed-report、tender-statistics、screen-model、screen-routes 回归保留。
