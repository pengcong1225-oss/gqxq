# department_mapping / b4-v1

- 字段：规则
- 模板类型：department_mapping / b4-v1
- 样例：全部虚构。导入前删除样例；引用对象需先导入。
- 步骤：下载 → 文本填写 → 预览 → 核对差异 → 确认 → 查询批次
- 约束：全批原子；有错误不能确认；10MiB / 2000行；24小时保留
- 空值：缺少可选列保留；提供空列清除可空文本；不删除文件缺少的对象
- 顺序：字典类型→条目/分类→企业→户数/映射→行政网格→小区→服务网格→覆盖/边界
- templateVersion：必填，固定 b4-v1；旧版本请重新下载
- sourceSystem：必填来源系统编码，不按名称合并
- sourceDepartmentCode：必填来源部门编码，与来源系统构成稳定键
- sourceDepartmentName：必填来源名称，最多128字
- enterpriseCode：必填稳定企业编码；文本，保留前导零
- entityType：必填 enterprise；行政机关不可混入
- aliases：必填 JSON 字符串数组；空数组 []，不使用逗号列表
- verified：必填 true/false，明确是否核验
