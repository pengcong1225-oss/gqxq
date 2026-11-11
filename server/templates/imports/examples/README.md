# 虚构失败文件

主目录每类模板含一个虚构成功样例，须先按字段说明准备相关依赖并删除真实上传中的样例；这些文件仅用于纠错培训。缺失编码须保持不存在。任何错误应使 canCommit=false（格式/坐标错误可能直接返回400），不能写主数据。引用失败若受限用户无法证明对象范围，批次详情/错误下载会拒绝；显式全域用户仍可查看本人错误明细。

| 文件类型 | 刻意错误 |
|---|---|
| enterprise | status=unknown |
| department_mapping | entityType=person |
| household | households=-1 |
| dictionary_type | status=unknown |
| dictionary_item | parentCode=MISSING_PARENT |
| category | sort=0.5 |
| admin_grid | districtCode=MISSING_DISTRICT |
| community | adminGridCode=MISSING_ADMIN |
| service_grid | enterpriseCode=MISSING_ENTERPRISE |
| grid_coverage | relationKind=unknown |
| grid_boundary | coordinateSystem=GCJ02，平台不自动转换 |

其他覆盖：自动化用例生成公式、宏、外链、损坏、伪扩展名、资源超限文件，以及重复编码、父子环、户数小数、区间交叠与越权，详见 B4 验收报告。
