# 来源办理流程与外部回访接收

诉求来源仍为宜接就办；公共事业管理填报系统的申请、审批、停供、施工及敏感交办继续使用现有公共事业接口。本次新增入口不替代该链路。

## 服务配置

通过部署环境 `GQXQ_BUSINESS_SOURCES_JSON` 配置来源数组。每项包含 `sourceId`、`keyId`、至少32字符的 `secret`、`maxSkewSeconds`（1–900）及 `complaintTargets`。办理流程另需 `sourceSystem`。每个目标授权必须指定 `sourceSystem`，并明确 `enterpriseCodes` 或 `allEnterprises: true`。未配置、重复来源或格式错误均拒绝接收。配置和签名密钥不得提交到Git。

所有推送使用原始请求体，携带 `x-source-id`、`x-key-id`、`x-source-timestamp`、`x-source-signature`。签名为 HMAC-SHA256(secret, timestamp + 换行 + 原始请求体) 的十六进制值。来源时间应在配置窗口内。

## 推送入口

- `POST /api/v1/external/business-source/processes`：办理过程快照，字段为 `sourceSystem`、案件 `sourceId`、递增整数 `sourceVersion`、`cutoffAt`、`complete`、`deadlineAt`、`completedAt`、`nodes`。时间为带时区ISO时间或明确的null；完整批次必须提供截止时间。节点包含稳定 `nodeId`、相同案件来源身份、`sourceSequence`、节点 `sourceVersion`、`occurredAt`、`stage`、`department`、`contactName`、可选 `contactPhone`、`opinion`。未知可空字段应明确传null。
- `POST /api/v1/external/business-source/events`：只接收 `kind: followup`。外层包含签名来源 `sourceId`、稳定回访编号 `sourceObjectId`、递增整数 `sourceVersion`、`sourceUpdatedAt`、可空 `enterpriseCode`/`districtCode`。`payload` 包含目标 `complaintId`、`occurredAt`、`contacted`、`evaluation`（satisfied/dissatisfied/null）、`dissatisfactionReason`、`operatorName`、`notes`。

相同版本相同内容幂等，过期版本不覆盖当前版本；同版本不同内容拒绝。回访目标按服务配置和当前案件归属授权，不信任正文企业字段；同一回访编号不可改绑其他诉求。办理时间明确传null表示来源撤销该时间，不恢复旧导入值。

## 后台查询及数据隔离

后台按当前诉求权限查看 `/api/v1/synchronized-followups` 及 `/:id`，含版本历史。办理流程仍通过现有诉求详情接口展示。无来源明文权限时，当前及历史节点联系方式、回访操作人均脱敏，节点意见及回访不满意原因/备注等自由文本不返回；撤权或切换账号立即清除页面旧数据。接收接口均使用合成数据完成隔离数据库验证，上游正式字段映射与密钥须由部署环境提供。
