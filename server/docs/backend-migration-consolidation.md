# 2026-11-11 受控迁移归并

四份手工 SQL 的后继入口为 `npm run migrate:latest`（工作目录 server）。不要再次手工执行 `backend-followup-permissions.sql`，该旧脚本每次递增授权版本；受控迁移只在补齐内置 admin 缺失授权时递增 admin 与全局授权版本各一次。handler、定制角色、已有授权与权限目录均保持历史语义，不删除、不重新播种。

新增顺序：

1. `20261111090000__backend_schema_consolidation.js`：tender store/history、企业展示元数据、网格联系人、PU 企业绑定；兼容已手工执行的同构表。先检查全部已有结构，再执行缺失 DDL。类型、nullable、默认值、生成列、字符集/排序规则、主键/唯一键/外键形态冲突明确报表列或索引名，不自动改写。
2. `20261111090100__followup_admin_permission_repair.js`：独立事务、锁授权状态、仅补内置 admin。空状态或缺失权限目录报错；非内置 admin 不授予权限。
3. `20261111090200__source_delivery_fields.js`：承接 ca92f4e 遗漏的来源日期、过程 ingress_version/hash、revision.contact_phone、business head/revision.followup_binding。原归档 migration 的 dashboard_visible/dashboard_name 不引入：本分支使用 display_on_screen/screen_name。manager_name/phone 已由第一项覆盖。
4. `20261111090300__dispatch_snapshot_key_compatibility.js`：承接 ca92f4e 第二项必要 join key 排序规则修复；仅对两个已知 varchar 键（包括历史 assignment_id 64/128 长度配对，保留各自长度）按照 dispatch_order 元数据对齐。其他冲突拒绝运行，所有检查先于 DDL。

## 前提和恢复

外部 baseline 和此前 migration 仍必须完整满足。PU 原 SQL 要求 enterprise.enterprise_code 为 varchar(64)、utf8mb4_0900_ai_ci，因此目标为 MySQL 8；不尝试修改存量企业代码排序规则。tender 的手工 SQL 未指定排序规则，合法形态要求其字符列与实际表默认 utf8mb4 排序规则一致；新增表沿数据库默认。没有导入业务样本或凭据。

MySQL DDL 隐式提交，迁移中途失败可能留下已添加结构；检查修复冲突后重跑。所有新增迁移拒绝破坏性 down；回滚应使用经审核备份和业务版本恢复方案。不要编辑已登记的历史迁移记录来绕过检查。

## 可重复验证

`server/tests/backend-consolidation-migration.test.cjs` 默认不连接任何数据库。实际测试必须显式设置 `GQXQ_ISOLATED_MIGRATION_TEST=1`，且只连接 127.0.0.1:13317，验证实例 datadir 为专用 gqxq-merge-mysql-20261111/data 后新建唯一 `gqxq_merge_migrations_<pid>_test` 合成测试库；测试结束保留库供审计。禁止改成生产连接、3306 或复用业务库。

PowerShell 在仓库根运行：

```powershell
$env:GQXQ_ISOLATED_MIGRATION_TEST='1'
node --test server/tests/backend-consolidation-migration.test.cjs
```

2026-11-11 已于隔离 MySQL 8.0.41 实测：新建与重复结构迁移、合成 store 行保持、列长度/unsigned/排序规则/索引冲突拒绝、admin 补授仅递增一次、handler 和定制权限保持、非内置 admin 不获授。该测试是新增迁移的最小合成 baseline 验证，不等于整条历史 baseline 或生产预演验收。

## 完整历史链验证（追加）

`tests/fixtures/external-baseline-ddl.sql` 为仓库外 zhuxin-platform Flyway V1 的 gqxq 表定义与 V8 的三个报表 ALTER 摘录；平台审计表结构内联为 operation_audit_log。仅 DDL，没有 V3 参考种子、示例账号、凭据或业务数据，避免借真实库制造测试基线。

`tests/fullchain-migration.test.cjs` 在相同隔离实例新建独立 `gqxq_merge_fullchain_<pid>_test`，执行 fixture 后通过 Knex 正式 migration runner 运行整个目录，再运行一次，检查迁移总数、第二次空列表、授权版本不变、来源/企业/网格关键列、新表与历史权限语义。首次运行揭示新增 snapshot 检查必须容纳已知的 order.assignment_id varchar(64) 与 snapshot.assignment_id varchar(128) 配对，现已仅修正新增迁移，未修改历史迁移。

2026-11-11 最终联合实测：3/3 测试通过、无跳过；完整历史链 **43 项成功，第二次 0 项**，验证库 `gqxq_merge_fullchain_34208_test`。complaint 为 0 条，未注入真实业务行。运行：

```powershell
$env:GQXQ_ISOLATED_MIGRATION_TEST='1'
node --test server/tests/fullchain-migration.test.cjs server/tests/backend-consolidation-migration.test.cjs
```

这是纯合成外部基线的完整链验收，加上手工升级形态的独立覆盖；不等同于生产数据迁移预演。
