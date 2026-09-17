# gqxq_service 现状核对与 G1 增量迁移设计

> 编制日期：2026-09-17
> 上游：`docs/2026-09-17-诉求平台G1详细实施方案.md`（下称"G1 方案"）
> 关联：`D:\aiProject\workspace-opc\zhuxin-platform`（Spring Boot 一体化平台，下称"平台侧"）

---

## 0. 更正声明（必须先读）

在 2026-09-17 的核对过程中，我先给出了**两个错误判断**，本文予以更正：

| 我先前的说法 | 实际情况 | 误判原因 |
| --- | --- | --- |
| "live `gqxq_service.complaint` 缺少 `(source_system, source_id)` 唯一键" | **不成立**。live 有 `uk_source UNIQUE (source_system, source_id)` | MySQL 对**可空列**上的复合唯一索引，`information_schema.COLUMNS.COLUMN_KEY` 报 `MUL` 而非 `UNI`，我据此误读为普通索引 |
| "live 有 V1 迁移没有的多余列（rule_confidence/contact_name/contact_phone/created_by/updated_by）" | **不成立**。这些列只存在于平台侧 spec §7.2；live 与 V1 完全一致 | 我把 spec §7.2 的 DDL 当成了 live 结构来比对 |

**并且**：我在提问时把"三方 schema 漂移"作为既定事实，据此得到的"先修漂移"结论建立在这个错误前提上。特此更正。

**更正后的结论：`gqxq_service` 与平台侧迁移 V1+V8 完全一致，不存在结构性漂移（0 / 19 张表有差异）。** 证据见 §1。

---

## 1. 现状核对（可复现）

### 1.1 核对方法

1. 从 `information_schema` 导出 live 的表、列、索引集合；
2. 解析平台侧 `V1__init_platform_gqxq_utility.sql` 第 156–411 行（`use gqxq_service` 段）的 `create table` 块，含**行内** `primary key` / `unique` 声明；
3. 解析 `V8__report_enhancements.sql` 对 `report_record` 的三列新增；
4. 逐表做集合差。

### 1.2 核对结果

| 口径 | 结果 |
| --- | --- |
| 表数量 | V1 段 19 张，live 19 张，**表名一一对应** |
| 仅 live 有的表 | 无 |
| 仅 V1 有的表 | 无 |
| 列差异 | 仅 `report_record` 多 `date_from / date_to / template_version` 三列，**来源是 V8 迁移**，属正常演进 |
| 索引差异 | 无 |
| **结构性差异表数** | **0 / 19** |

关键键位确认（live）：

```text
complaint 唯一键: complaint_id, complaint_no, uk_source(source_system, source_id)
complaint 列数: 29
```

> 结论：`gqxq_service` 是平台侧 V1–V8 的**忠实落地**。它没有 `flyway_schema_history`（V1 用 `use gqxq_service` 切库执行，历史记在 `zhuxin_platform_admin`，V1 checksum = `-187431886`）。

### 1.3 数据量现状

| 表 | 行数 | 表 | 行数 |
| --- | --- | --- | --- |
| `complaint` | 8 | `report_record` | 7 |
| `dispatch_order` | 3 | `address_correction` | 2 |
| `enterprise` | 4 | `service_grid` | 3 |
| `dict_item` | 12 | `dict_type` | 4 |
| `pipeline_project` | 2 | `shutdown_application` | 2 |
| `operation_audit_log` / `process_log` / `sync_log` / `legacy_migration_map` | 0 | `attachment` / `enterprise_certificate` / `grid_enterprise` / `complaint_rule_result` | 0 |

---

## 2. 归属决定与"一库两主"的影响

### 2.1 决定

| 项 | 决定 |
| --- | --- |
| DDL 归属 | **gqxq 仓库接管 `gqxq_service` 的 DDL**（用 knex 迁移演进）；平台侧**冻结**对它的结构改动，只保留读写 |
| 枚举与主键 | **沿用现有约定**（小写枚举 + `varchar(64)` 业务键） |

### 2.2 为什么必须明确写下这条

`gqxq_service` 目前**被平台侧实际占用**，不是"空库"：

| 占用方式 | 证据 |
| --- | --- |
| 结构（DDL） | 平台侧 Flyway `V1`（建 19 表）、`V3`（种子）、`V8`（改 `report_record` + 插入种子） |
| 运行期读写 | `apps/server/.../gqxq/JdbcGqxqRepository.java` 有 **98 处** `gqxq_service.<表>` 限定名 SQL |
| 前端 | `apps/gqxq-service`（14 个页面，走 `/api/gqxq/*`） |

因此改它的表结构会**同时影响平台侧运行**。本次决定下，后续约束为：

1. gqxq 的 knex 迁移是 `gqxq_service` 结构的**唯一权威**；平台侧迁移文件不再修改该库的表结构。
2. 迁移必须**只做增量**（`add column` / `add key` / `create table`），**不得** `drop` 或改类型，因为平台侧 98 处 SQL 仍在读旧列。
3. 平台侧 `V8` 的 `alter table gqxq_service.report_record add column ...` 若在**全新环境**重放，与 gqxq 的迁移存在先后顺序问题，需要在部署文档里固定顺序（先平台侧 `V1`，后 gqxq 迁移）。已记录为风险 R-A。
4. 现有 `complaint.status`（单列混装）**保留不删**，作为兼容列继续供平台侧读写；新增的三条状态轴与它并存，由 gqxq 服务维护。

---

## 3. 现有约定（必须沿用，不得另立）

### 3.1 业务主键与编号

真实样本（`gqxq_service.complaint` / `dispatch_order`）：

| 对象 | 列 | 格式 | 样本 |
| --- | --- | --- | --- |
| 诉求业务键 | `complaint_id` | `CPL` + yyyyMMdd + 4 位 | `CPL202606240001` |
| 诉求编号 | `complaint_no` | `CS` + yyyyMMdd + 4 位 | `CS202606240001` |
| 交办业务键 | `assignment_id` | `ASGN` + yyyyMMdd + 4 位 | `ASGN202606240001` |
| 交办单号 | `order_no` | `JB` + yyyyMMdd + 4 位 | `JB202606240001` |
| 来源业务键 | `source_id` | 由来源系统给 | `YJJB202606240001` |

> **G1 方案 §3.5 的 `CS+yyyyMMdd+6 位` 与现有 4 位不一致**，必须改为 **4 位**（沿用现有），否则新老编号不可比。发号器仍可用 `number_sequence` 实现，只是格式串改为 4 位。

### 3.2 枚举取值（live 实际在用，全部小写）

| 列 | 现值 | 计数 |
| --- | --- | --- |
| `business_type` | `water` / `gas` / `lpg` | 5 / 2 / 1 |
| `complaint_type` | `complaint` | 8 |
| `urgency_level` | `critical` / `urgent` / `normal` | 3 / 3 / 2 |
| `status` | `processing` / `closed` | 6 / 2 |
| `correction_status` | `pending` / `corrected` / `completed` | 5 / 1 / 2 |

> **G1 方案 §4.2 用大写枚举（`WATER` / `CRITICAL` …）与本决定冲突，必须整体改为小写。**

### 3.3 已经存在、可直接复用的资产（G1 方案不要重复造）

| 现有对象 | 可替代 G1 方案里的 | 说明 |
| --- | --- | --- |
| `complaint.uk_source` 唯一键 | "唯一约束去重" | **已存在**，G1 的幂等落库可直接依赖它，无需新建 |
| `operation_audit_log` | G1 方案新建的 `audit_log` | 结构 = 平台 `platform_audit_log`；列：`audit_id/user_id/app_code/resource_code/action/biz_type/biz_id/result/client_ip/detail/created_at` |
| `dict_type` + `dict_item` | G1 方案的"代码常量字典" | 已有 12 项，含 `business_type / complaint_type / urgency_level / sensitive_word` 四类 |
| `dict_item` 的 `sensitive_word` 类 | 落地计划 G2"硬编码 5 词数组改为读规则表" | **敏感词已经在库里**（如"爆管/泄漏/大面积停水"），G2 直接读即可 |
| `process_log` | 详情页时间线的一部分 | 通用轨迹表（`biz_type/biz_id/action/content`） |
| `complaint_rule_result` | 规则判定证据 | 有 `matched_rules/extracted_entities/confidence`（JSON） |
| `enterprise` / `service_grid` / `grid_enterprise` | G2 责任企业与网格匹配 | 企业 4 条、网格 3 条，已可用 |
| `dispatch_order` / `dispatch_archive` / `address_correction` | G2/G5 的交办、归档、纠偏 | 已成表，G2 只需补"唯一有效交办"约束与落库逻辑 |

### 3.4 需要澄清的口径问题（不擅自"修数据"）

| 问题 | 现状 | 处理建议 |
| --- | --- | --- |
| `source_system` 混装"系统"与"渠道" | 现有值含"宜接就办"（系统）、"市场热线/网页端/网格上报"（渠道） | 原值**不动**；G1 新增 `source_channel` 列，并在方案中约定 `source_system` 只放系统标识。历史混装记为已知问题 |
| `correction_status='completed'` | 2 行，**不在**约定集合 `none/pending/corrected/failed` 内 | 作为**数据修复项**处理（见 §4.4），不静默改写 |
| `complaint.status` 单列混装 | 正是落地计划 §1.2 要拆的反模式 | 保留为兼容列 + 新增三轴，由 gqxq 服务维护新轴 |

---

### 3.5 时间口径（2026-09-17 实测修正，务必遵守）

**结论：gqxq_service 里的 DATETIME 存的是 Asia/Shanghai 墙钟时间，不是 UTC。** 证据三条：

| 证据 | 实测 |
| --- | --- |
| MySQL 服务器时区 | `TIMEDIFF(NOW(), UTC_TIMESTAMP())` = 08:00:00，system_time_zone 为中国标准时间 |
| 既存数据 | complaint.created_at = 2026-06-29 13:40:36，与 Flyway installed_on 同一时刻（本地墙钟） |
| 平台侧 | JDBC 连接串用 serverTimezone=Asia/Shanghai，对同一批列按 +08:00 解释 |

因此 Node 侧连接池必须写 timezone: '+08:00'（**不是 'Z'**）。写错会让同一行比真实时刻晚 8 小时，
并与平台侧（Java）对同一行的解释相差 8 小时。实测对照：

~~~text
库里存的墙钟字符串 : 2026-06-29 13:40:36
timezone='Z'     读出来 -> 2026-06-29T13:40:36.000Z   <- 错，晚 8 小时
timezone='+08:00' 读出来 -> 2026-06-29T05:40:36.000Z  <- 正确
~~~

配套约束：

1. **不要用 UTC_TIMESTAMP()**。它返回 UTC 数值却被按 +08:00 解释，实测读成 2026-09-16T20:54:06Z（错 16 小时）。
   要取当前时刻就写 NOW()。
2. 写入时**传 JS Date 对象**，由驱动按 +08:00 格式化；不要自己拼 UTC 字符串。
3. 需要「今日 / 趋势」分桶时，日界按 +08:00 计算；SQL 用数字偏移 CONVERT_TZ(x,'+00:00','+08:00')，
   **禁用命名时区**（本机时区表 0 行未加载，命名时区会静默返回 NULL）。
4. 对外 API 仍统一返回 ISO-8601 UTC（toISOString() 得到 …Z），由前端本地化展示。
5. 新增列一律用 datetime（精度 0，与既有表一致），不要引入 timestamp——
   timestamp 会做时区转换，语义与既有列不同。本文早期提案里的 DATETIME(3) 已在实现时统一为 datetime。
## 4. G1 增量迁移设计

迁移体为 knex 迁移（原始 SQL），库名一律写全限定 `gqxq_service.<表>`，与平台侧风格一致。

### 4.1 迁移清单

| 序号 | 迁移 | 内容 | 依赖 |
| --- | --- | --- | --- |
| `M0` | `20260917100000__adopt_existing_schema` | **接管基线**：在 `gqxq_service` 建 `knex_migrations` 并写入一条 `adopted` 记录，声明 V1+V8 已存在；**不重新建表** | 无 |
| `M1` | `20260917100100__g1_new_tables` | 新建 `complaint_source_log`、`complaint_field_version`、`number_sequence`、`app_user` | M0 |
| `M2` | `20260917100200__complaint_g1_columns` | `complaint` 增列（三条状态轴 + 来源快照 + 办结/分析 + 匹配元数据）与索引 | M1 |
| `M3` | `20260917100300__g1_backfill` | 数据回填与 `correction_status` 修复（只改数据，不改结构） | M2 |

### 4.2 M0：接管基线（关键，避免 knex 重建已有表）

```sql
use gqxq_service;
create table if not exists knex_migrations (
  id bigint unsigned not null auto_increment primary key,
  name varchar(255),
  batch int,
  migration_time timestamp
);
-- 记录一条"已采纳外部基线"，使 knex 从 M1 开始执行
insert into knex_migrations (name, batch, migration_time)
values ('adopted:zhuxin-platform V1+V3+V8 (2026-06-29)', 0, now());
```

### 4.3 M1：新增表

```sql
-- 外部投递日志（追加写；每次重传都留痕，含重复与被拒）
create table if not exists complaint_source_log (
  id            bigint primary key auto_increment,
  log_id        varchar(64)  not null unique,
  source_system varchar(64)  not null,
  source_id     varchar(128) not null,
  complaint_id  varchar(64)      null comment '落库成功时回填',
  payload_hash  char(64)     not null,
  payload       json         not null,
  result        varchar(24)  not null comment 'created/duplicate_same/updated/rejected',
  message       varchar(500)     null,
  remote_ip     varchar(64)      null,
  request_id    varchar(64)      null,
  received_at   datetime     not null default current_timestamp,
  key idx_csl_source   (source_system, source_id, received_at),
  key idx_csl_received (received_at)
) engine=InnoDB default charset=utf8mb4 comment='外部投递日志（追加写）';

-- 字段变更版本（追加写）
create table if not exists complaint_field_version (
  id            bigint primary key auto_increment,
  version_id    varchar(64) not null unique,
  complaint_id  varchar(64) not null,
  field_name    varchar(64) not null,
  old_value     text,
  new_value     text,
  change_source varchar(24) not null comment 'external_redelivery/manual_edit/rule_engine/data_repair',
  reason        varchar(500),
  operator_id   varchar(64),
  operator_name varchar(64),
  changed_at    datetime not null default current_timestamp,
  key idx_cfv_complaint (complaint_id, changed_at)
) engine=InnoDB default charset=utf8mb4 comment='诉求字段变更版本（追加写）';

-- 按日发号器
create table if not exists number_sequence (
  seq_key       varchar(32) not null,
  biz_date      date        not null,
  current_value bigint      not null default 0,
  updated_at    datetime    not null default current_timestamp on update current_timestamp,
  primary key (seq_key, biz_date)
) engine=InnoDB default charset=utf8mb4 comment='按日发号器';

-- 最小真实身份（独立运行时用；平台侧统一认证见 G1 方案 §7）
create table if not exists app_user (
  id            bigint primary key auto_increment,
  user_id       varchar(64)  not null unique,
  username      varchar(64)  not null unique,
  password_hash varchar(100) not null comment 'bcrypt',
  real_name     varchar(64)  not null,
  roles         json         not null,
  permissions   json         not null,
  status        tinyint      not null default 1,
  last_login_at datetime,
  created_at    datetime     not null default current_timestamp,
  updated_at    datetime     not null default current_timestamp on update current_timestamp
) engine=InnoDB default charset=utf8mb4 comment='系统用户（独立运行）';
```

> **发号器实现约束（实测踩坑，务必遵守）**：`LAST_INSERT_ID(expr)` 是**会话级**变量。若实现成「先 insert、再单独 select last_insert_id()」，在同一连接上并发发号时，多条 insert 会先全部执行，随后所有 select 都读到**最后一个**值——实测 3 路并发全部拿到 3，会直接产生重号。正确做法是**只发一条语句**，并取回该语句自身的 `insertId`（mysql2 的 `result.insertId` 即 LAST_INSERT_ID(expr) 的结果）。已在 `server/src/db/sequence.ts` 按此实现，并用 5 路并发验证得到 1,2,3,4,5。

### 4.4 M2：`complaint` 增列

> 全部为**可空或带默认值**的 `add column`，对既有 8 行安全；不删除、不改类型、不改名。

```sql
alter table gqxq_service.complaint
  add column source_channel         varchar(64)  null comment '来源渠道（source_system 现混装，见 §3.4）',
  add column rule_confidence        decimal(5,2) null,
  add column rule_version           varchar(32)  null,
  add column source_payload         json         null comment '原始报文快照',
  add column source_payload_hash    char(64)     null comment '规范化 JSON 的 sha256；历史行为 NULL',
  add column source_reported_at     datetime     null comment '来源声明的诉求时间',
  add column source_updated_at      datetime     null comment '最近一次重传覆盖快照时间',
  add column source_event_status    varchar(24)  not null default 'unknown'     comment '来源事件状态（只读快照）',
  add column supervision_status     varchar(24)  not null default 'none'        comment '督办交办状态',
  add column reporting_status       varchar(24)  not null default 'not_started' comment '填报审批状态',
  add column closed_in_system       tinyint      not null default 0,
  add column closed_by              varchar(64)  null,
  add column closed_by_name         varchar(64)  null,
  add column closed_basis           varchar(500) null,
  add column analysis_included      tinyint      not null default 0,
  add column analysis_record_id     varchar(64)  null,
  add column responsible_matched_at datetime     null,
  add column responsible_match_reason varchar(500) null,
  add key idx_complaint_supervision (supervision_status),
  add key idx_complaint_reporting   (reporting_status),
  add key idx_complaint_received    (received_at);
```

> `source_payload_hash` 允许为 NULL：历史 8 行没有原始报文，**不伪造 hash**。新接收的记录一律写入 hash；重传时 NULL ≠ 新 hash，会正确判为 `updated`。

### 4.5 M3：数据回填与修复

```sql
-- 1) 三轴回填：来源事件状态不猜测（宜接就办未接入）
update gqxq_service.complaint
set source_event_status = 'unknown',
    reporting_status    = 'not_started',
    closed_in_system    = 0
where source_event_status = 'unknown';

-- 2) 督办状态由 dispatch_order 派生（有交办就按交办状态，无交办为 none）
update gqxq_service.complaint c
join gqxq_service.dispatch_order d on d.complaint_id = c.complaint_id
set c.supervision_status = case
  when d.status in ('pending','pushed','accepted','processing','returned') then d.status
  when d.status = 'archived' then 'archived'
  else 'none' end
where c.supervision_status = 'none';

-- 3) correction_status 越界值修复：completed 不在 none/pending/corrected/failed 内
--    先留痕到 complaint_field_version，再改写
insert into gqxq_service.complaint_field_version
  (version_id, complaint_id, field_name, old_value, new_value, change_source, reason, operator_name)
select concat('CFV-REPAIR-', c.id), c.complaint_id, 'correction_status',
       c.correction_status, 'corrected', 'data_repair',
       '原值 completed 不在约定枚举集合内，按语义映射为 corrected', 'system'
from gqxq_service.complaint c
where c.correction_status = 'completed';

update gqxq_service.complaint
set correction_status = 'corrected'
where correction_status = 'completed';
```

> `complaint.status` **不改**。它是兼容列，平台侧 98 处 SQL 仍依赖它；其与新三轴的语义关系记录为待确认项（§6）。

### 4.6 回滚

| 迁移 | 回滚 |
| --- | --- |
| M3 | 用 `complaint_field_version` 里的 `data_repair` 记录反向还原 `correction_status`；三轴回填可置回默认值 |
| M2 | `drop column` / `drop key`（仅新增列，安全） |
| M1 | `drop table`（新表，无外部依赖） |
| M0 | 删除 `knex_migrations` 中的 adopted 行 |

**执行前必须备份**：`mysqldump gqxq_service` 全库 + 单独备份 `complaint` / `dispatch_order` / `report_record`。G0 已提供代码回退基线 `baseline-20260917`，数据库侧需另存 dump。

---

### 4.7 回滚演练（2026-09-17 已实际执行，非纸面承诺）

| 步骤 | 命令 | 实测结果 |
| --- | --- | --- |
| 1. 用 G0 前的全库备份建测试库 | 备份产物改库名后灌入 gqxq_service_test | 19 表、无 knex_migrations、complaint 29 列 8 行 → **备份确实可还原** |
| 2. 在测试库应用全部迁移 | NODE_ENV=test npx knex --knexfile knexfile.js migrate:latest | M0 基线校验通过；Batch 1 共 5 个迁移；complaint 48 列；4 张新表就位 |
| 3. 全量回滚 | NODE_ENV=test ... migrate:rollback --all | Batch 1 回滚 5 个迁移，exit 0 |
| 4. 核对回滚结果 | 直查 information_schema | 业务表回到 19 张；complaint 回到 29 列；G1 四张新表已删；三轴与 correction_confidence 列已删；**correction_status 为 completed 的 2 行已还原**（M3 的 down 生效） |
| 5. 确认真库未被波及 | 直查 gqxq_service | complaint 仍 8 行 48 列 |

**结论：备份可还原、迁移可前滚、可回滚、数据修复可逆。**

两个实现细节务必注意：

1. `mysqldump --databases` 的产物含 `CREATE DATABASE` 与 `USE` 语句，**直接灌会覆盖真库**；演练时必须先把库名从 gqxq_service 改名成 gqxq_service_test 再灌。
2. 回滚后 knex 的记账表（knex_migrations / knex_migrations_lock）会保留但为 0 行，属正常；判断是否回到基线时要把这两张表排除。

测试库 gqxq_service_test 演练后已重新迁移到 G1 状态，保留给自动化测试使用。
## 5. 对 G1 方案的修订点

| G1 方案位置 | 原文 | 修订为 |
| --- | --- | --- |
| §2.4 建库 | 新建 `gqxq` 与 `gqxq_test` | **复用 `gqxq_service`**；测试库另建 `gqxq_service_test`（结构由同一套迁移生成） |
| §3.3 表名 | 新建 `complaint` / `audit_log` | `complaint` 已存在 → 改为**增列**；`audit_log` → **复用 `operation_audit_log`** |
| §3.5 编号 | `CS` + yyyyMMdd + **6 位** | `CS` + yyyyMMdd + **4 位**（沿用现有），并沿用 `CPL/ASGN/JB` 前缀 |
| §3.7 唯一交办 | 生成列 `active_complaint_id` | 在既有 `dispatch_order` 上增生成列与唯一键；"进行中"集合沿用现有小写 `pending/pushed/accepted/processing/returned` |
| §4.2 枚举 | 大写 `WATER/CRITICAL/...` | 全部**小写** `water/critical/...` |
| §4.2 字典 | 服务端代码常量 `enums.ts` | **读 `dict_type`/`dict_item`**（已有 12 项），代码常量仅作兜底 |
| §5.3 幂等 | 自建 `uk_complaint_source` | 依赖**已存在**的 `uk_source` |
| §5.4/5.7 主键 | 数值 `id` | 对外用 `complaint_id`（varchar 业务键），与服务端既有接口一致 |
| §8.3 门禁 | 无 | 增加两条：禁止在 `gqxq_service` 上执行 `drop table/column`；禁止出现大写枚举字面量 |

---

## 6. 待确认项

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | `complaint.status` 与三轴的语义映射 | 现有 `processing/closed` 由平台侧写入；G1 后由谁维护？建议平台侧只读、gqxq 服务按派生规则回写 |
| 2 | `source_system` 混装口径 | 是否在 G1 内把历史值规范化为系统标识（需同步 98 处 Java SQL 的过滤条件） |
| 3 | `correction_status` 约定集合是否补入 `completed` | 本设计选择映射为 `corrected`；若业务上 `completed` 另有含义则改为扩集合 |
| 4 | `gqxq_service_test` 的生成方式 | 建议由同一套 knex 迁移从零建库，用于自动化测试 |
| 5 | 平台侧 Flyway 与 gqxq knex 的部署顺序 | 新环境先跑平台侧 V1（建表）再跑 gqxq 迁移；需写入部署文档（风险 R-A） |

## 7. 风险

| # | 风险 | 对策 |
| --- | --- | --- |
| R-A | 全新环境部署顺序错乱导致 V8 `add column` 重复 | 部署文档固定"先 V1、后 gqxq 迁移"；gqxq 迁移全部 `if not exists` / 幂等 |
| R-B | 平台侧有人在 gqxq 接管后仍改 `gqxq_service` 结构 | 冻结决定需落到平台侧仓库的迁移规范里（写进其 docs） |
| R-C | `complaint` 增列后平台侧 `select *` / 列序假设失效 | 已确认 v8 之前的 SQL 均为具名列（98 处抽查为具名）；仍建议在平台侧跑一次回归 |
| R-D | 回填 `supervision_status` 依赖 `dispatch_order` 现有 3 行，语义可能不准 | 回填同时写 `responsible_match_reason` 说明来源；不确定的保持 `none` |
