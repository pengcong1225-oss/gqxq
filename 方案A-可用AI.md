# 方案 A：可用 AI 能力（云/本地模型）

## 适用场景
AI 服务可访问（云 API 或本地部署 GPU 服务器），模型文件可获取，互联网或内网 AI 服务可用。

---

## 已实现功能（现有代码）

### 前端（React 18 + TypeScript + Ant Design + ECharts）

| 页面 | 文件 | 现有功能 |
|------|------|---------|
| 数据大屏 | `views/Dashboard.tsx` | 聚合指标卡、供水/燃气趋势图、分类饼图、区域排名、告警统计 |
| 诉求管理 | `views/ComplaintList.tsx` | 分页列表、业务类型/状态/区域/关键词筛选 |
| 诉求详情 | `views/ComplaintDetail.tsx` | 诉求基本信息、处理记录时间线、GIS 散点图 |
| 数据分析 | `views/Analysis.tsx` | 趋势折线图、区域柱状图、分类饼图、热点问题表 |
| 敏感交办 | `views/DispatchOrders.tsx` | 交办单列表、手动创建交办、状态跟踪 |
| 企业管理 | `views/CompanyList.tsx` | 企业 CRUD、服务区域管理 |
| 网格管理 | `views/GridManager.tsx` | 网格 CRUD、GIS 边界绘制按钮 |
| 热力图 | `views/HeatmapView.tsx` | ECharts 散点热力图、时间筛选、热区详情表 |
| 停供管理 | `views/ShutdownList.tsx` | 停供单列表、类型/状态筛选 |
| 管道施工 | `views/PipelineList.tsx` | 施工项目列表、进度跟踪 |
| 分析报告 | `views/ReportView.tsx` | 报告列表、生成弹窗(日报/周报/月报/自定义)、预览、模拟下载 |
| 字典管理 | `views/DictManager.tsx` | 字典 CRUD、字典项管理 |
| 用户管理 | `views/UserManager.tsx` | 用户列表、角色分配 |
| 登录 | `views/Login.tsx` | 登录表单 |

### 后端（Express.js Mock Server）

| API | 现有功能 |
|-----|---------|
| `/api/v1/auth/login` | Mock 登录 |
| `/api/v1/complaints` | 200 条 Mock 诉求（列表/详情/筛选） |
| `/api/v1/dashboard/overview` | Mock 大屏数据 |
| `/api/v1/analysis/overview` | Mock 分析数据 |
| `/api/v1/companies` | 7 家 Mock 企业 |
| `/api/v1/grids` | 5 个 Mock 网格 |
| `/api/v1/shutdowns` | 15 条 Mock 停供单 |
| `/api/v1/pipeline-projects` | 10 个 Mock 施工项目 |
| `/api/v1/dispatch/orders` | Mock 敏感交办单 |
| `/api/v1/reports` | 3 条 Mock 报告 |
| `/api/v1/dicts/:code/items` | Mock 字典数据 |
| `/api/v1/heatmap/data` | 100 个随机热力点 |
| `/api/v1/users` | 15 个 Mock 用户 |

---

## 业务需求总体方案

### 流程一：业务主流程（宜接就办对接 + AI 预处理 + 地址纠偏）

```
宜接就办 → 推送诉求（单向，我方不回传）
    ↓
诉求接收/去重（按 sourceId）
    ↓
AI NLP 预处理（可用 AI 时的方案）
    ├── BERT/ERNIE 多标签文本分类 → 自动分派类型、紧急程度
    ├── BERT-BiLSTM-CRF NER 命名实体识别 → 抽取地址/企业/联系人
    ├── 敏感词 AC 自动机匹配 + 语义相似度向量检索 → 敏感标注
    └── 置信度评分（低置信度 → 人工复核）
    ↓
地址纠偏（内部处理，不回传宜接就办）
    ├── 天地图逆地理编码 API → 自动获取坐标
    ├── 置信度 < 0.7 → 入人工纠偏队列
    └── GIS 地图选点修正
    ↓
入库 + 从宜接就办拉取处理结果（仅拉取，不回传）
```

**新增/改造文件：**

| 类型 | 文件 | 说明 |
|------|------|------|
| 改造 | `views/ComplaintList.tsx` | 增加来源系统列、AI 分类结果列、纠偏状态列 |
| 改造 | `views/ComplaintDetail.tsx` | 增加 AI 预处理结果卡片、纠偏轨迹时间线 |
| 新建 | `views/AddressCorrection.tsx` | 地址纠偏工作台（待纠偏列表 + GIS 选点 + 批量修正） |
| 新建 | `views/nlp/NLPResultPreview.tsx` | NLP 预处理结果查看组件 |
| 新建 | `api/nlpApi.ts` | NLP 服务 API 调用 |
| 新建 | `api/externalApi.ts` | 宜接就办外部接口 |
| 改造 | `server/src/index.js` | 新增 NLP 预处理、纠偏 API |

**新增 API（我方提供）：**

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/v1/external/yijiejieban/appeal` | 接收宜接就办推送 |
| POST | `/api/v1/nlp/classify` | 文本分类（调用 NLP 服务） |
| POST | `/api/v1/nlp/extract-entities` | 实体抽取（调用 NLP 服务） |
| POST | `/api/v1/nlp/sensitive-detect` | 敏感词检测 |
| GET | `/api/v1/address-correction/pending` | 待纠偏列表 |
| POST | `/api/v1/address-correction/batch` | 提交纠偏结果 |

---

### 流程二：敏感交办（敏感词库 + 填报系统对接）

```
诉求入库
    ↓
敏感词库匹配（AI 增强版）
    ├── AC 自动机 → 多模式关键词匹配（第一层）
    ├── 语义相似度向量检索 → 同义词/近义词检测（第二层，AI 专属）
    └── 组合规则引擎 → 词+区域+时段联动升级（第三层）
    ↓
生成交办单（自动/手动）
    ├── 指派目标企业
    ├── 设定处理期限
    └── 推送至填报接收系统
    ↓
填报系统 → 企业处理 → 状态回调/webhook → 拉取反馈
    ↓
管理员确认 → 诉求归档
```

**新增/改造文件：**

| 类型 | 文件 | 说明 |
|------|------|------|
| 改造 | `views/DispatchOrders.tsx` | 增加敏感标注信息、同步状态、重推按钮、超时高亮 |
| 新建 | `views/DispatchArchive.tsx` | 归档交办列表 |
| 新建 | `views/SensitiveWordsManager.tsx` | 敏感词管理（增删改查、等级设置、命中统计） |
| 新建 | `api/sensitiveWordApi.ts` | 敏感词 API |
| 新建 | `api/dispatchApi.ts` | 交办 API |
| 改造 | `server/src/index.js` | 新增敏感词管理、交办推送/回调/归档 API |

**新增 API：**

| Method | Path | 说明 |
|--------|------|------|
| GET/POST/PUT/DELETE | `/api/v1/sensitive-words` | 敏感词 CRUD |
| GET | `/api/v1/sensitive-words/hit-stats` | 命中统计 |
| POST | `/api/v1/dispatch/orders` | 创建交办单 |
| POST | `/api/v1/dispatch/orders/:id/push` | 推送至填报系统 |
| POST | `/api/v1/dispatch/orders/:id/repush` | 重推 |
| POST | `/api/v1/external/tianbao/status-callback` | 填报系统状态回调 |
| POST | `/api/v1/dispatch/orders/:id/sync` | 拉取反馈 |
| POST | `/api/v1/dispatch/orders/:id/archive` | 归档 |

---

### 流程三：企业归属（双网融合）

```
城域中心 → 政府网格数据（GeoJSON/Excel）
    ↓
导入 → 空间叠加分析（PostGIS）
    ├── ST_Intersects → 计算重叠率
    ├── ≥80% → 自动匹配
    ├── 50-80% → 建议匹配
    └── <50% → 手动匹配
    ↓
双网融合结果 → 企业绑定到网格
```

**新增/改造文件：**

| 类型 | 文件 | 说明 |
|------|------|------|
| 改造 | `views/GridManager.tsx` | 增加双网融合 Tab、导入、匹配管理 |
| 改造 | `views/CompanyList.tsx` | 增加绑定网格信息列 |
| 新建 | `views/GridMatching.tsx` | 网格匹配管理页 |
| 新建 | `api/gridApi.ts` | 网格 API |
| 新建 | `components/GisMap/GridLayerOverlay.tsx` | 双网格图层叠加组件 |
| 改造 | `server/src/index.js` | 新增网格导入、匹配、绑定 API |

---

### 流程四：热力图增强

```
热力图 v2
    ├── 增强筛选：时间范围 + 业务类型 + 区域 + 纠偏质量
    ├── 趋势对比：两个时间段密度差异 + 热区漂移动画
    ├── 纠偏影响：纠偏前后热区变化 → "热区稳定性指数"
    └── 下钻：点击热区 → 弹出诉求列表
```

**新增/改造文件：**

| 类型 | 文件 | 说明 |
|------|------|------|
| 改造 | `views/HeatmapView.tsx` | 趋势对比、纠偏质量层、下钻抽屉、分辨率滑动条 |
| 新建 | `components/Heatmap/CorrectionOverlay.tsx` | 纠偏质量叠层 |
| 新建 | `components/Heatmap/DrillDownDrawer.tsx` | 下钻抽屉 |
| 新建 | `api/heatmapApi.ts` | 热力图 API |
| 新建 | `stores/heatmapStore.ts` | 热力图状态管理 |
| 改造 | `server/src/index.js` | 新增趋势对比、纠偏影响、区域下钻 API |

---

### 流程五 & 六：报告系统（AI 增强版）

**核心区别**：在可用 AI 场景下，报告生成使用 LLM 提示词驱动，而非纯模板填充。

```
报告生成流程（AI 版）
    ↓
用户选择：报告类型 + 时间范围 + 维度筛选
    ↓
后端收集统计数据（SQL 聚合 + ES 检索）
    ↓
构建提示词（预置模板 + 实际数据填充）
    ↓
调用 LLM API 生成分析文本
    ├── 原因分析报告：设施老化/施工破坏/管理疏漏/外部因素 深度分析
    ├── 责任认定报告：企业排名 + 超标识别 + 因果关系链
    ├── 处理建议报告：紧急/短期/中长期/系统性 四级建议
    ├── 预测预警报告：趋势外推 + 风险事件预测 + 防范建议
    └── 综合报告：以上内容合并
    ↓
LLM 返回结构化 JSON
    ↓
前端渲染：文字分析 + ECharts 图表 + 导出 PDF/Word
```

**报告系统架构（报告总览 + 4 子模块）：**

```
/reports         → ReportHub          报告总览（改造原 ReportView）
/reports/ai      → AIReportView        AI 智能分析（提示词驱动）
/reports/predict → PredictionReportView 预测预警（LLM 生成）
/reports/schedule→ ReportScheduler     定时任务
/reports/template→ ReportTemplates     提示词模板管理
```

**新增/改造文件（与方案 B 相同前端结构，区别在生成方式）：**

| 类型 | 文件 | 说明 |
|------|------|------|
| 新建 | `views/reports/ReportHub.tsx` | 报告总览 |
| 新建 | `views/reports/AIReportView.tsx` | AI 分析（LLM 驱动） |
| 新建 | `views/reports/PredictionReportView.tsx` | 预测预警（LLM 驱动） |
| 新建 | `views/reports/ReportScheduler.tsx` | 定时任务 |
| 新建 | `views/reports/ReportTemplates.tsx` | 提示词模板管理 |
| 新建 | `api/report.ts` | 报告 API |
| 新建 | `stores/reportStore.ts` | 报告状态 |
| 新建 | `components/reports/ReportPreview.tsx` | 报告预览 |
| 新建 | `components/reports/ExportButtons.tsx` | 导出按钮 |
| 新建 | `components/reports/PromptEditor.tsx` | 提示词编辑器 |
| 改造 | `views/ReportView.tsx` | 迁移至 ReportHub 后删除 |
| 改造 | `App.tsx` | 嵌套路由 |
| 改造 | `layouts/MainLayout.tsx` | SubMenu |
| 改造 | `server/src/index.js` | 报告 API |

---

## 技术架构（可用 AI）

```
┌─────────────────────────────────────────────────────┐
│                    前端 (React 18)                    │
│  Dashboard / Complaint / Analysis / Dispatch         │
│  Company / Grid / Heatmap / Report                   │
│  状态管理: Zustand  │  API: Axios                    │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────┐
│              后端网关 (Spring Boot 3.2)               │
│  Controller → Service → Repository → PostgreSQL      │
│                                                       │
│  ┌─────────────────┐  ┌─────────────────────────┐   │
│  │  NLP 预处理服务   │  │  AI 报告生成服务         │   │
│  │  (Python FastAPI)│  │  (Python FastAPI         │   │
│  │                  │  │   or 云 API)             │   │
│  │  - BERT/ERNIE     │  │                          │   │
│  │  - NER 实体抽取   │  │  - LLM 提示词驱动        │   │
│  │  - 语义相似度     │  │  - 结构化 JSON 输出      │   │
│  └─────────────────┘  └─────────────────────────┘   │
│                                                       │
│  ┌─────────────────┐  ┌─────────────────────────┐   │
│  │  外部系统对接     │  │  任务调度                │   │
│  │  - 宜接就办拉取   │  │  - XXL-JOB              │   │
│  │  - 填报系统推送   │  │  - 定时报告生成           │   │
│  └─────────────────┘  └─────────────────────────┘   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                    数据层                              │
│  PostgreSQL 15 + PostGIS 3.4   Redis 7               │
│  Elasticsearch 8               MinIO (文件存储)       │
└─────────────────────────────────────────────────────┘
```

---

## 外部系统对接清单

### 宜接就办平台（单向接收，不回传）

我方需要对方提供的接口：

| # | 接口 | 方向 | 用途 |
|---|------|------|------|
| 1 | POST 推送单条诉求 | 宜→我 | 实时接收 |
| 2 | POST 批量推送 | 宜→我 | 补偿接收 |
| 3 | GET 拉取诉求列表 | 我→宜 | 定时拉取 |
| 4 | GET 查询诉求详情 | 我→宜 | 查看详情 |
| 5 | GET 查询处理进度 | 我→宜 | 跟踪状态 |
| 6 | GET 拉取办结结果 | 我→宜 | 获取结果 |
| 7 | GET 健康检查 | 我→宜 | 监控 |

### 填报接收系统（交办出，反馈进）

我方需要对方提供的接口：

| # | 接口 | 方向 | 用途 |
|---|------|------|------|
| 1 | POST 下发交办单 | 我→填 | 推送任务 |
| 2 | GET 查询状态 | 我→填 | 轮询进度 |
| 3 | GET 拉取反馈 | 我→填 | 获取结果 |
| 4 | POST 撤回交办 | 我→填 | 异常撤回 |
| 5 | GET 获取企业列表 | 我→填 | 企业编码 |
| 6 | GET 健康检查 | 我→填 | 监控 |
| 7 | POST 状态回调 | 填→我 | 实时通知（强烈建议） |
