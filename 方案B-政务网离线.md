# 方案 B：政务网离线环境（无 AI 依赖）

## 适用场景
政务网部署，内外网隔离。无法访问云 AI API。GPU 资源受限或无 GPU。模型文件导入需走安全审批流程（周期 2-4 周）。

**核心原则**：所有功能用纯代码逻辑实现（规则引擎 + 模板填充 + 统计算法），零外网依赖，零模型文件需求。

---

## 已实现功能（现有代码）

与方案 A 相同，现有代码处于 Mock 阶段，所有页面和 API 见方案 A 第 2-3 节。

---

## 业务需求总体方案

### 流程一：业务主流程（宜接就办对接 + 规则引擎预处理 + 地址纠偏）

```
宜接就办 → 推送诉求（单向，我方不回传）
    ↓
诉求接收/去重（按 sourceId）
    ↓
规则引擎预处理（无 AI 方案）
    ├── 关键词规则分类 → 投诉/咨询/建议/举报、供水/燃气/LPG
    │   预置 ~50 条分类规则，格式：[关键词列表] → [分类结果]
    │   例: ["投诉","举报","不处理","推诿"] → complaintType: 投诉
    │
    ├── 正则+字典实体抽取 → 地址/企业名称/联系电话
    │   · 行政区划字典（湖北省→宜昌市→各区县→街道）
    │   · 企业名称字典（7 家供水燃气企业 + 别名映射）
    │   · 地址正则：[省市区县]+[街道镇]+[路街巷]+[号]+[栋幢单元室]
    │
    ├── AC 自动机敏感词匹配 → 敏感标注
    │   · 预置 ~30 个敏感词（供水/燃气/通用三类）
    │   · 组合规则引擎（词+区域+时段）
    │   · 纯算法 O(n) 时间，无外网依赖
    │
    └── 置信度评分 → 低于阈值 → 人工复核
    ↓
地址纠偏（内部处理，不回传宜接就办）
    ├── 天地图政务版 API（政务网可通）
    ├── 置信度 < 0.7 → 入人工纠偏队列
    └── GIS 地图选点修正
    ↓
入库 + 从宜接就办拉取处理结果（仅拉取）
```

### 文本分类规则引擎 — 具体实现

```
分类规则配置文件 (categories.json):

{
  "complaintType": {
    "投诉": ["投诉", "举报", "不处理", "推诿", "敷衍", "不作为", "反映多次", "不解决"],
    "咨询": ["咨询", "请问", "如何", "查询", "收费标准", "办理流程", "需要什么材料"],
    "建议": ["建议", "希望", "能否", "能不能", "改进", "优化"],
    "举报": ["举报", "违规", "违法", "私接", "偷水", "盗气"]
  },
  "businessType": {
    "water": ["水压", "停水", "自来水", "水质", "水表", "水管", "供水", "二次供水", "爆管", "漏水"],
    "gas":   ["燃气", "天然气", "液化气", "停气", "漏气", "气压", "气表", "钢瓶", "煤气"],
    "lpg":   ["液化气", "钢瓶", "灌装气", "瓶装气"]
  },
  "urgencyLevel": {
    "特急": ["爆炸", "泄漏", "中毒", "大面积停", "伤亡", "群体"],
    "紧急": ["爆管", "断裂", "污染", "火灾", "安全隐患", "持续多日"],
    "一般": []  // 默认
  }
}

匹配逻辑（Java/Node 通用）:
  1. jieba 分词 → 词列表
  2. 遍历分类维度，统计每类关键词命中数
  3. 按优先级取命中最多的类
  4. 未命中 → 默认值（投诉/一般）+ 标记 confidence: low → 人工复核
```

### 实体抽取 — 正则 + 字典

```
地址抽取流程:
  诉求文本
    ↓ jieba 分词
    ↓ 正则匹配: /([一-龥]{2,}(?:省|自治区))?([一-龥]{2,}(?:市|州))?([一-龥]{2,}(?:区|县|市))?([一-龥]{2,}(?:街道|镇|乡))?([一-龥]{1,}(?:路|街|巷|道|大道))?([\d]+(?:号|栋|幢|单元|室|楼))?/
    ↓ 匹配结果 + 区划字典补全
    ↓ 输出: {地址全称, 省, 市, 区县, 街道, 路名, 门牌号}

企业名称抽取:
  诉求文本
    ↓ 企业字典（含别名）
    {
      "宜昌市供水总公司": ["市供水公司", "供水总公司", "宜昌供水"],
      "宜昌中燃城市燃气有限公司": ["宜昌中燃", "中燃公司"],
      ...
    }
    ↓ 全词匹配（优先长词）
    ↓ 输出: {企业ID, 标准名称, 匹配方式: "exact"/"alias"}
```

---

### 流程二：敏感交办（纯规则敏感词库 + 填报系统对接）

**敏感标注流程（无 AI）：**

```
诉求文本
    ↓
┌─ 第一层：AC 自动机多模式匹配 ──────────────────┐
│  预置词库（~30 词）                               │
│  供水：爆管│大面积停水│水质异常│水源污染│水压不足  │
│  燃气：燃气泄漏│燃气爆炸│燃气中毒│大面积停气│管道断裂 │
│  通用：群体事件│伤亡│媒体曝光│重大损失│领导批示    │
│                                                   │
│  匹配结果（O(n) 线性时间）：                       │
│    [{word:"燃气泄漏", level:"特急", pos:45}]       │
└───────────────────────────────────────────────────┘
    ↓
┌─ 第二层：组合规则引擎 ──────────────────────────┐
│  规则格式: IF [条件] THEN [动作]                   │
│                                                   │
│  示例规则:                                        │
│  R1: IF 命中词IN["爆管","燃气泄漏"]               │
│      AND 区域IN["学校","医院","幼儿园"]            │
│      THEN 升级为"特急"                             │
│                                                   │
│  R2: IF 命中词IN["大面积停水","大面积停气"]        │
│      AND 时段∈["06月","07月","08月"]  #高温夏季    │
│      THEN 升级为"紧急"                             │
│                                                   │
│  R3: IF 同一地址投诉次数 ≥ 3                       │
│      THEN 标记为"重复投诉" + 升级为"紧急"           │
│                                                   │
│  R4: IF 命中词IN["爆管","断裂","泄漏","爆炸"]      │
│      THEN 输出sensitiveType="keyword"              │
│                                                   │
│  R5: IF 管理员手动标记                              │
│      THEN 输出sensitiveType="manual"               │
└───────────────────────────────────────────────────┘
    ↓
┌─ 第三层：白名单过滤 ────────────────────────────┐
│  白名单规则:                                      │
│  - "泄漏检测" → 不命中（技术检测非事故）            │
│  - "燃气灶" → 不命中（设备名称非安全事故）          │
│  - "水压测试" → 不命中（测试非故障）               │
│  - 企业名称中的关键词 → 不命中                      │
└───────────────────────────────────────────────────┘
    ↓
输出: {isSensitive, sensitiveType, sensitiveLevel, hitWords, hitRules}
```

交办和外部系统对接与方案 A 一致（不依赖 AI）。

---

### 流程三：企业归属（双网融合）

与方案 A 完全一致（该流程不依赖 AI，依赖的是 PostGIS 空间计算）。

---

### 流程四：热力图增强

与方案 A 完全一致（该流程不依赖 AI，依赖的是数据聚合和前端 ECharts 渲染）。

---

### 流程五 & 六：报告系统（模板规则填充版）

**核心区别**：用 Handlebars 模板引擎替代 LLM，数据驱动填充。

#### 模板引擎原理

```
┌──────────────┐
│  报告模板表    │  ← 数据库存储，管理员可编辑
│  (report_    │
│   template)  │
└──────┬───────┘
       ▼
┌──────────────┐
│  1. 加载模板   │  ← 获取模板文本 + 维度配置
└──────┬───────┘
       ▼
┌──────────────┐
│  2. 数据查询   │  ← SQL 统计：总量/趋势/分类/区域/企业
│               │     ES 检索：关键词高频词
│               │     对比上一周期数据
└──────┬───────┘
       ▼
┌──────────────┐
│  3. 条件判断   │  ← Handlebars 模板语法
│  {{#if}}      │     agingPercent > 30 → 输出设施老化段落
│  {{#each}}    │     topDistricts → 循环输出区域列表
│  {{#unless}}  │     overtimeCount = 0 → 隐藏超时警告
└──────┬───────┘
       ▼
┌──────────────┐
│  4. 变量替换   │  ← {{totalCount}} → 1247
│               │     {{waterPercent}} → 55.2
│               │     {{topDistrict}} → 西陵区
└──────┬───────┘
       ▼
┌──────────────┐
│  5. 输出报告   │  ← Markdown 渲染预览
│               │     HTML 转 PDF/Word 导出
└──────────────┘
```

#### 模板示例：原因分析报告

```handlebars
# {{reportTitle}}
## 统计周期：{{periodStart}} 至 {{periodEnd}}

---

## 一、诉求概况

本周期共受理诉求 **{{totalCount}}** 件，较上周期 {{compareDirection}} {{comparePercent}}%。
其中供水类 {{waterCount}} 件（{{waterPercent}}%），燃气类 {{gasCount}} 件（{{gasPercent}}%）。

## 二、原因分析

### 2.1 供水问题分布
| 原因类别 | 数量 | 占比 | 变化 |
|----------|------|------|------|
| 设施老化 | {{agingCount}} | {{agingPercent}}% | {{agingTrend}} |
| 施工破坏 | {{constructionCount}} | {{constructionPercent}}% | {{constructionTrend}} |
| 管理疏漏 | {{managementCount}} | {{managementPercent}}% | {{managementTrend}} |
| 外部因素 | {{externalCount}} | {{externalPercent}}% | {{externalTrend}} |

### 2.2 主要问题分析

{{#if (gt agingPercent 30)}}
**【设施老化】** 是当前最突出问题，占比 {{agingPercent}}%，
主要集中在 **{{topAgingDistrict}}** 等老城区，
涉及管道使用年限均超过 {{avgPipelineAge}} 年。

建议：优先安排 {{topAgingDistrict}} 管网改造计划，
预计涉及管道长度 {{agingPipelineLength}} 公里，
估算资金需求 {{estimatedBudget}} 万元。
{{/if}}

{{#if (gt constructionPercent 20)}}
**【施工破坏】** 类诉求较上周期 {{constructionTrend}}，
集中在 {{topConstructionArea}} 区域，
与近期 {{constructionProjectCount}} 个施工项目相关。

建议：加强施工区域管线交底，增设警示标识，
对 {{topConstructionArea}} 区域加密巡查频次。
{{/if}}

### 2.3 高发区域
{{#each topDistricts}}
- **{{name}}**：{{count}} 件，主要问题：{{mainIssue}}
{{/each}}

## 三、责任分析

### 3.1 企业诉求排名
| 企业 | 诉求量 | 占比 | 超时 | 超时率 |
|------|--------|------|------|--------|
{{#each companyRankings}}
| {{name}} | {{count}} | {{percent}}% | {{overtimeCount}} | {{overtimeRate}}% |
{{/each}}

{{#each companyRankings}}
{{#if (gt overtimeRate 10)}}
⚠️ **{{name}}** 超时率 {{overtimeRate}}%，超出警戒线，需限期整改。
{{/if}}
{{/each}}

## 四、处理建议

**【紧急】**
{{#if (gt agingPercent 30)}}
1. 启动 {{topAgingDistrict}} 管网改造立项
{{/if}}
{{#if (gt sensitiveCount 5)}}
2. {{sensitiveCount}} 件敏感诉求需优先处理
{{/if}}

**【短期】（1-2 周内）**
1. 加强 {{topHotArea}} 区域巡检
2. 对超时企业 {{overtimeCompany}} 进行约谈

**【中长期】（1-3 个月）**
1. 建立管网健康档案，推行预防性维护
2. 完善施工管线交底制度

---
*本报告由系统自动生成*
*数据来源：宜接就办平台、填报接收系统*
*生成时间：{{generatedAt}}*
```

#### 模板引擎技术选型

```
模板语法: Handlebars（纯 Java 实现，无外网依赖）

Java:    com.github.jknack:handlebars:4.3.1（JAR 离线安装）
Node:    handlebars（npm 离线包）
Python:  Jinja2（pip 离线包）

前端模板编辑器: CodeMirror / Monaco Editor（纯前端，无外网依赖）
前端预览渲染: marked.js（Markdown → HTML）+ 打印 CSS → PDF
```

#### 预置模板清单（~7 套）

| 模板名 | 类型 | 说明 |
|--------|------|------|
| 日报模板 | daily | 当日诉求概况 + 高发区域 + 敏感提示 |
| 周报模板 | weekly | 周趋势对比 + 分类分布 + 企业排名 |
| 月报模板 | monthly | 月汇总 + 环比 + 同比 + 区域热力图数据 |
| 原因分析模板 | ai_cause | 原因分类统计 + 条件段落 + 建议 |
| 责任认定模板 | ai_responsibility | 企业排名 + 超时分析 + 责任认定 |
| 预测预警模板 | prediction | 趋势外推 + 风险事件 + 防范建议 |
| 综合报告模板 | comprehensive | 以上全部合并 |

---

## 技术架构（无 AI）

```
┌─────────────────────────────────────────────────────┐
│                    前端 (React 18)                    │
│  Dashboard / Complaint / Analysis / Dispatch         │
│  Company / Grid / Heatmap / Report                   │
│  状态管理: Zustand  │  API: Axios                    │
│  模板编辑器: CodeMirror  │  图表: ECharts            │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────┐
│              后端 (Spring Boot 3.2)                   │
│  Controller → Service → Repository → PostgreSQL      │
│                                                       │
│  ┌─────────────────┐  ┌─────────────────────────┐   │
│  │  规则引擎模块     │  │  模板报告模块            │   │
│  │                  │  │                          │   │
│  │  - 关键词分类    │  │  - Handlebars 模板引擎    │   │
│  │  - 正则抽取实体   │  │  - 条件逻辑渲染          │   │
│  │  - AC 自动机      │  │  - 统计查询 + 数据填充    │   │
│  │  - 组合规则引擎   │  │  - Markdown 渲染输出      │   │
│  │  (纯 Java,0依赖) │  │  (纯 Java,0依赖)         │   │
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

❌ 无 Python 服务（NLP 由 Java 规则引擎替代）
❌ 无 GPU 依赖（全部 CPU 运行）
❌ 无外网调用（全部本地处理）
```

---

## 方案 B 的数据库表设计（新增）

除方案 A 已有的表外，方案 B 特有：

### 规则配置表 `nlp_rule`

```sql
CREATE TABLE nlp_rule (
    id            BIGSERIAL PRIMARY KEY,
    rule_type     VARCHAR(30) NOT NULL,  -- 'classify'/ 'extract'/'sensitive_filter'
    rule_name     VARCHAR(100) NOT NULL,
    rule_config   JSONB NOT NULL,        -- 规则定义（关键词列表/正则/逻辑）
    priority      INTEGER DEFAULT 0,     -- 优先级
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW()
);
```

### 敏感词表 `sensitive_word`

```sql
CREATE TABLE sensitive_word (
    id            BIGSERIAL PRIMARY KEY,
    word          VARCHAR(100) NOT NULL UNIQUE,
    word_level    VARCHAR(10) NOT NULL DEFAULT '一般',  -- 一般/紧急/特急
    business_scope VARCHAR(30) DEFAULT 'all',           -- water/gas/lpg/all
    is_active     BOOLEAN DEFAULT TRUE,
    hit_count     INTEGER DEFAULT 0,   -- 命中次数统计
    created_at    TIMESTAMP DEFAULT NOW()
);
```

### 组合规则表 `sensitive_rule`

```sql
CREATE TABLE sensitive_rule (
    id            BIGSERIAL PRIMARY KEY,
    rule_name     VARCHAR(100) NOT NULL,
    conditions    JSONB NOT NULL,     -- {"words":["爆管"],"districts":["医院"],"timeRange":null}
    action        JSONB NOT NULL,     -- {"upgradeLevel":"特急"}
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT NOW()
);
```

### 实体字典表 `entity_dict`

```sql
CREATE TABLE entity_dict (
    id            BIGSERIAL PRIMARY KEY,
    dict_type     VARCHAR(30) NOT NULL,  -- 'enterprise'/'district'/'street'
    standard_name VARCHAR(200) NOT NULL,
    aliases       TEXT[],               -- 别名数组
    metadata      JSONB,                -- 扩展信息
    created_at    TIMESTAMP DEFAULT NOW()
);
```

### 报告模板表 `report_template`

```sql
CREATE TABLE report_template (
    id              BIGSERIAL PRIMARY KEY,
    template_name   VARCHAR(100) NOT NULL,
    template_type   VARCHAR(30) NOT NULL,
    template_content TEXT NOT NULL,       -- Handlebars 模板文本
    dimensions      JSONB,               -- ['time','region','company','type']
    is_system       BOOLEAN DEFAULT FALSE,-- 系统内置/管理员自定义
    status          INTEGER DEFAULT 1,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);
```

---

## 方案 A vs 方案 B 对比总结

| 维度 | 方案 A（可用 AI） | 方案 B（政务网离线） |
|------|-----------------|-------------------|
| **文本分类** | BERT/ERNIE 模型 | 关键词规则 + jieba |
| **实体抽取** | NER 序列标注模型 | 正则 + 字典匹配 |
| **敏感词匹配** | AC 自动机 + 语义向量 | AC 自动机 + 组合规则 |
| **报告生成** | LLM 提示词驱动 | Handlebars 模板填充 |
| **分类精度** | ~90% | ~75-80% |
| **实体抽取精度** | ~85% | ~70-75% |
| **报告文本质量** | 自然流畅，每次不同 | 结构化固定，可预期 |
| **外网依赖** | ✅ 需要 | ❌ 不需要 |
| **模型文件** | 需要（~200MB-2GB） | 不需要 |
| **GPU** | 建议有 | 不需要 |
| **安全审批** | 模型安全评估 | 无额外审批 |
| **维护成本** | 模型训练/更新 | 规则/模板人工维护 |
| **数据准确性** | 可能幻觉/编造 | **100% 来自数据库** |
| **部署复杂度** | 高 | 低 |
| **前后端文件数** | ~20 个新建/改造 | ~22 个新建/改造 |
| **一期开发周期** | 3-4 周 | 2-3 周 |

---

## 外部系统对接清单

与方案 A 完全一致（对接需求不因 AI 可用性而变）。

宜接就办：7 个接口（单向接收）  
填报系统：7 个接口（交办出 + 反馈进）
