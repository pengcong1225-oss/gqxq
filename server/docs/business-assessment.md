# 真实主账预警与历史研判

本组功能读取诉求主账的 `procurement-source-completed-v2` 口径：宜接就办、供水/供气、来源明确 completed 且有同步证据，期间取来源录入日期。专题模拟和独立整包导入仍在原“专题数据与预警管理”，两者不会互相替代。

后台入口：真实主账预警 `/business-alerts`；历史同期 `/appeal-assessment`；五季保障 `/seasonal-assessment`；行政网格对比 `/grid-comparison`；正式规则 `/business-rules`。详情可跳转诉求，仍由诉求权限和当前范围复核。

## 发布规则与触发

具备 `business.rules.manage` 且全域范围的有效用户可保存/发布 seasonal、alert 规则。发布时核验正式分类字典版本与大/小类，燃气三件套必须确认定义；系统不猜测分类编码。冬季默认燃气、夏季默认供水。规则、版本和审计记录持久保存。授权状态锁串行化发布，避免并发发布同季业务多个有效规则。

预警按规则版本、企业、区县、行政网格和窗口形成稳定标识；重复计算不重复插入，首次触发证据保留，不以重算覆盖原处理记录。确认/处理必须填写依据。读取和处理时同事务锁定预警及所有当前可见证据诉求；范围移出则隐藏，不能拿旧快照绕过当前范围。

冬夏预警依赖已发布的保障季定义；计划停供只读当前 `utility-feed-real`：来源必须明确 `fields.nature=planned`、real、映射成功、审批通过、未取消，并匹配诉求企业/区县/网格/业务/事件时段。缺少计划性质证据时显示资料不足，不把所有申请当计划停供。没有旧 source_business_head 停供/反馈 worker，无外部发送。

## 自动核算（标书1.2.10）

默认 `GQXQ_BUSINESS_ALERT_WORKER_ENABLED=false`，测试进程不自动启动。部署需要先发布正式规则，然后配置 `GQXQ_BUSINESS_ALERT_USER_ID` 为专用有效账号，并启用开关；间隔 `GQXQ_BUSINESS_ALERT_INTERVAL_MS` 默认300000毫秒，允许60000至86400000。仅示例文件增加空账号占位，本次没有修改运行环境或启用生产定时任务。

每轮重读账号状态、强制改密状态、有效权限和真实全域范围；至少要求 alert.handle、alert.read、statistics.read、dashboard.read，计划停供另需shutdown.read。禁用账号、撤权、收缩范围后下一轮拒绝写入；事务持授权锁，变更提交后不继续使用旧授权。进程内不重叠；多进程以数据库稳定主键去重。定时只调用同一预警计算服务，不向企业或外部系统发消息。停用开关或停止进程时取消定时器，写入前再次检查开关。

## 历史完整性

历史同期给近五年同期间Top3，分类版本分开；保障季给五季、上季月度和Top6网格。无接入记录返回 null/资料不足，不当完整零值；规则有效期不能完整覆盖统计段时也返回不可用。当前未完季给 observedTo/truncated，并在图表旁明确实际截至日期；上一季某网格无记录也不虚构为零。统计是已接入观测数据，不声称来源全量完整覆盖。

## API与权限

- `/business-rules` GET/POST、`/:id/publish` POST：business.rules.manage + 全域；写操作再查实时账号。
- `/business-alerts` GET、`/:id/history` GET：alert.read + 当前全部证据诉求范围。
- `/business-alerts/evaluate` POST、`/:id/actions` POST：alert.handle；计算还需统计与总账权限，处理还需alert.read；readonly禁止写。
- `/assessment/{admin-grids,grid-comparison,historical,seasonal}` GET：assessment.read；按操作还需grid.read、statistics.read和数据集权限。只有complaint.read才返回明细。

沿用既有20261014100000迁移中的business表与once-only权限播种，不再次授予已撤销权限。前端5页按完整用户对象+令牌key重挂载，切账号/撤权立即移除抽屉、弹窗及旧响应。
