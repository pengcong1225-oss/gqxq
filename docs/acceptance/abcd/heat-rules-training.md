# 五档热力规则与真实数量操作说明（D2）

Q7 正式政策尚未业务批准。本批提供可保存、可复算的候选草稿、真实数量、权限边界和发布门槛；生产迁移不会生成确认记录或正式规则。没有精确服务端确认记录，管理员也不能发布。候选样本的颜色不代表正式等级。

## 查询真实热力数量

热力页与 D1 使用同一规范化 StatisticsQuery：显式数据集、当前有效或入库快照投影、上海业务日区间及筛选。总量按稳定诉求键去重；未定位仍计总量，不造坐标。网格桶允许同一诉求属于多个授权历史网格，所以各网格数量**非加和**。仅有记录的当前经纬度或今日纠偏证据不能证明历史业务日网格归属。

空间预览只用 D1 返回的授权覆盖、真实 WGS84 坐标和 selectedBusinessDays 胜出日期 mask。不会用旧开放区间复活被更高版本遮蔽的覆盖，不展示 draft 或越权几何，不推定未知坐标系，不构造设施、密度、趋势或随机点。它是本地几何预览，没有底图和面积计算。

必须明确选择唯一正式分类才可评估等级：明确小类以该小类规则评估；只有所选政策声明 minor_then_major 时，缺小类规则可回退对应大类规则。只明确大类时评估所选大类整体，不挑子类主导、最高或平均等级。未选择类别返回 level=null / CATEGORY_SELECTION_REQUIRED；选择后没有规则返回 level=null / UNCONFIGURED。Q7 未确认时仍可看真实数量。

查询权限为 heatmap.read + statistics.read + 数据集能力（总账 dashboard.read；分析 analysis.read）。没有 complaint.read 时只返回授权网格聚合与允许的覆盖，逐诉求 ID、坐标和明细均不返回。拥有明细能力也只获得实际授权、合法且来源已核实的 WGS84 点位；仅缺历史网格匹配不会否定合法来源的位置，但不宣称网格归属。权限撤销、账号或授权版本变化、筛选变化、请求失败清除旧结果，并拒绝旧请求回填；D1 容量拒绝原样报错，不伪装为空数据。

## 管理候选草稿

heatmap.manage 默认只首次授予内置 admin，可显式授予自定义角色；角色名本身不授管理能力。全局规则配置不额外要求 explicit-all 数据范围。重跑迁移不会重授已撤销能力。管理选项使用 B1 已发布启用分类，不需要字典管理能力。

按绿、蓝、黄、橙、红填写五个非负十进制**字符串**，最多两位小数，严格递增；相等、倒序、科学计数法、负数、超过精度均拒绝。实现以百分之一单位 BigInt 比较数量×100与系数单位×计日，不进行浮点阈值比较。

所有政策参数须显式选择：anchor、endpointOwner、zero、belowFirst、top、day、classFallback、noRule、ruleSelection。不完整返回 POLICY_INCOMPLETE；不自洽返回 POLICY_INCOHERENT。候选约束 upper 必须 belowFirst=green，lower 必须 top=red；否则参数会被忽略或最高档为空，所以拒绝。明确允许零值不分类、upper 超最高界不分类、lower 首界以下不分类；各情况返回原因。上述约束是候选工程模型，不是 Q7 业务确认。

上海含首尾日计数是明确候选 day=shanghai_inclusive，同日=1。query_end 候选以结束业务日的同一规则评估整个窗口数量/天数，跨规则期间不宣称逐事件加权。它们都必须被未来真实确认的政策版本涵盖。

保存须 expectedVersion；未保存的编辑不能预览不同的已持久化系数，修改后先保存。草稿预览同样须携带编辑器已保存的 expectedVersion；若另一管理员已保存新版本，返回409，重新读取/编辑后再预览，不展示新版本结果冒充旧编辑器。冻结发布预览按明确 version 读取。政策版本内容不可改，修改行为须创建更高政策版本。样本预览只需管理能力，不读取业务数据；返回 candidate=true、草稿/冻结发布版本及明确原因。没有预填的获批系数或政策。

## 发布门槛与历史复算

发布请求仅接受 expectedVersion。服务端读取不可变确认记录：精确 policyId/policyVersion、规范政策 SHA-256 fingerprint、真实 truthTable 和 evidenceRef。客户端 confirmed/审批字段一律拒绝。本批没有公开确认、审批端点，也不实施正式配置导入；Q7 批准后才能另行受控导入。

每个 exact category 使用稳定 head 锁串行发布。发布内容与 effectiveFrom 永不覆盖；后续 start 须严格晚于已有最大 start，同日冲突，不得追溯到已经完成的上海业务日。区间为 [当前 start, 下一已发布 start)，end 由下一 start 推导，不修改旧内容或旧 start。可按版本读取冻结规则、政策和确认事实复算；不把新政策替换进旧版本。

配置审计复用 operation_audit_log：heat_rule + HEAT_DRAFT_SAVE / HEAT_RULE_PUBLISH 明确作为系统配置元数据，安全详情仅列规则/分类/字典/政策/版本/日期，不公开原始 before/after JSON。未知 action 仍排除。

## Q7 输入—输出待确认表

| 输入 | 候选说明 | 正式结果 |
| --- | --- | --- |
| count=0 | zero 参数须显式选择 green 或 null | 待业务确认 |
| 30天、黄10/橙20、count=300 | upper 两候选端点归属可分别为 yellow 或 orange；不是正式端点 | 待业务确认 |
| 同参数、count=450 | 报告候选例 orange，测试用完整 synthetic upper 系数 [1,5,10,20,30] | 待业务确认 |
| 同参数、count=600 | upper 两候选端点归属可分别为 orange 或 red | 待业务确认 |
| 最高有限界及以上 | top、anchor 与端点归属显式，不能猜 | 待业务确认 |
| 同日、跨月、闰日、跨年 | Shanghai inclusive 候选同日1；D1 日期真源 | 待业务确认 |
| 缺小类规则 | exact_only 或 minor_then_major 显式 | 待业务确认 |
| 查询跨多个发布 start | query_end 候选整窗采用结束日版本 | 待业务确认 |
| 同 start / 倒序追加 / 追溯已完成日 | 发布事务拒绝，旧版本内容保持 | 工程约束已固定，非政策批准 |

验证只使用虚构样本和 gqxq_d2_contract_test 的真实隔离 SQL。fixture 中的确认记录明确标注 SYNTHETIC ONLY，不能解释为业务批准、生产迁移、canonical/M0、部署或重启验收。
