# 诉求最小交付补齐实施计划

> **For agentic workers:** Use superpowers:executing-plans; 本轮由指定执行者原地实施，父代理复核，不再委派。

**Goal:** 补齐可信来源过程、来源日期、采购统计、固定报告和少量主数据字段。

**Architecture:** 复用已有签名来源通道、版本快照、统计冻结和只读界面。采购政策新增版本，旧统计快照和历史报告保持原事实与字节。

**Tech Stack:** Express / TypeScript / MySQL / React / Ant Design / docx / ExcelJS。

**Spec:** `docs/superpowers/specs/2026-10-14-bid-feature-completion-design.md`，并以 2026-10-15 最新技术方案及用户最小交付边界为准。

## Global Constraints

- 不触碰生产数据库、不部署、不推送；保护交接的六个界面改动。
- 外部办理、审批和回访保持来源只读；未知来源契约不得编造。
- 新本方接收契约仅代表可联调能力，不能宣称正式接入验收。
- 仅明确独立 `_test` 数据库可做写入测试；容量与未配置保护保留。

## Review Focus

- 旧入库快照缺来源状态证据：新政策排除，不借用当前状态补旧事实。
- 来源时间缺失或非法：排除并说明，不能回退接收时间。
- 回访当前版本更正为未接通、同时间多记录冲突：不计重复或旧评价。
- 来源签名与身份不符、乱序版本：拒绝覆盖可信事实。
- 历史报告下载：读取已冻结字节，新增模板不改写历史。

### Task 1: 来源事实与全过程

Files: sourceProcess domain/service/routes、complaintProjection、ComplaintDetail、rolePolicy。
- [x] 为接收校验、来源日期映射及只读范围补失败测试。
- [x] 复用签名认证接收完整过程快照和明确来源日期；挂载查询、权限及详情组件。
- [x] 跑来源规则、权限及前后端类型检查。

### Task 2: 采购统计与满意度

Files: statisticsQuery/Facts/Repo/Service/types、businessAssessmentService、相关测试。
- [x] 新政策只纳入宜接就办、来源已办结的供水供气，以来源录入日统计；缺证据可解释排除。
- [x] 新入库快照保存来源证据并兼容旧版读取；旧政策保持可解析。
- [x] 每诉求选取当前来源有效回访，冻结分子分母、所选记录和排除依据；冲突不猜优先级。
- [x] 跑定向统计、快照、研判及来源回访测试。

### Task 3: 主数据与固定报告

Files: enterprise / serviceGrid schemas、迁移、表单及导入映射；reportSnapshot/Renderer/Repo、报告界面。
- [x] 补企业大屏开关/显示名、网格管理人/电话并保持版本和导入一致。
- [x] 新增固定采购统计模板，包含分类分布、趋势、比较、满意度及数据质量说明；旧草稿仍可读取。
- [x] 运行模板生成与文档渲染检查，不能将模板可生成称为业务批准。

### Task 4: 验证和交付记录

- [x] 前后端 typecheck；运行可安全执行的项目测试，记录失败和跳过。
- [x] 交付说明列明本方契约、业务待确认项、真实联调依赖与剩余 CIM 范围。
- [x] git diff 检查，所有变更保留未提交交父代理审查。

验证与明确未验收项详见 `docs/2026-10-15-complaint-minimum-delivery.md`。测试库迁移/真实外部联调不属于本轮已验证项。
