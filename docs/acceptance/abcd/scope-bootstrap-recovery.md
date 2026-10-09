# A2 一次性范围初始化与中断恢复

此说明用于 `20261009040000__user_object_scopes.js`，不是生产迁移验收或自动授予权限的指令。先保存当前 schema、账号范围、授权版本与迁移/管理员操作证据；不要删除字段、清空范围、重置版本或重建账号来使迁移通过。

新迁移在任何 DDL 前核验真实 `app_user` 和 A5 授权状态表的结构、InnoDB、完整 singleton 主键及 id=1 行。之后在 A5 锁内保存 `scope_bootstrap_state=pending` 和原启用账号的数值身份、user_id、状态、session_version 清单，再添加范围列。完成事务仅对仍匹配原身份/状态/会话且 scope_version=1、scope_rules=NULL、scope_provenance=new-account-deny 的原账号执行约定的旧账号 all 初始化。管理员范围更新会推进 scope_version；即使主动恢复同样的 NULL/deny 文本，也不再匹配。新建账号不在原清单内。

完成状态为 `complete`，保留原清单及 `skipped` 的身份/状态/会话/范围变化原因。重跑 complete 不重新授予范围。中断后重跑 pending 只处理仍符合原条件的账号；修改过或撤销过的范围跳过并记录。只添加了 checkpoint 字段但尚未写入清单、且没有任何范围列时，可以重新记录清单；不接受字段部分缺失、未知状态或不可判定清单。

旧版本已经存在范围列但没有 checkpoint 时，无法从列存在、NULL 或 deny 文本判断过去是否完成过初始化、是否由管理员主动撤销。迁移明确拒绝，代价是这类历史数据库需要一次人工恢复裁定，不能直接重跑自动扩大权限。

恢复步骤：

1. 暂停范围/账号管理与迁移写入，备份数据库及证据；核对 A5 结构、完整主键、InnoDB 和 singleton，核对三项范围字段的类型/空值契约。
2. 逐账号核对历史迁移成功记录、原账号身份及管理员范围变更。现有范围是需要保留的实际授权；无法判定的账号保持拒绝，由有权管理员按正常范围 API 显式设置，不能推测 all。
3. 对**已存在完整范围字段、且决定保留所有现有授权**的历史状态，由负责数据库恢复的管理员在维护窗口明确记录“跳过旧自动 bootstrap”的裁定。在依赖检查通过后，添加可空 `scope_bootstrap_state varchar(16)` 与 `scope_bootstrap_users json`；在锁定 A5 id=1 的事务中设 state=complete，users 清单为空、skipped 清单为空，保留另外的恢复证据与负责人记录。不修改 app_user 的范围、来源、scope_version 或账号身份。这里的 complete 表示自动初始化已明确结束，不证明每个历史用户曾获 all。
4. 重跑 A2，核对 checkpoint 完整、现有范围逐项未变及撤销用户仍拒绝。缺失或部分范围列、未知 checkpoint、无法解释的清单不得使用步骤3；保留失败状态，依据备份和审计制定显式恢复方案。

本地回归只在固定隔离 schema 验证：依赖失败零 DDL 后补依赖重试、checkpoint/范围 DDL 中断、原清单外新账号保持拒绝、管理员推进范围版本后同样 NULL/deny 不恢复，以及 complete 重跑不复活撤销。实际业务库的历史证据与恢复裁定不由这些测试代替。
