/**
 * 演示用假数据（纯本地，无任何业务含义、无任何接口）
 * 只用于把卡片、弹窗的样式撑起来，方便本地直接看视觉效果。
 * 接新项目时连同整个 src/demo/ 目录一起删除即可。
 */

export const cardList = [
  {
    title: '核心指标',
    type: 'metrics',
    metrics: [
      { label: '总量', value: '12,860', unit: '项' },
      { label: '完成率', value: '86.4', unit: '%' },
      { label: '处理中', value: '328', unit: '项' },
      { label: '达标率', value: '92.1', unit: '%' },
    ],
  },
  {
    title: '分类占比',
    type: 'bars',
    bars: [
      { label: '区域 A', value: 82 },
      { label: '区域 B', value: 67 },
      { label: '区域 C', value: 54 },
      { label: '区域 D', value: 38 },
      { label: '区域 E', value: 21 },
    ],
  },
  {
    title: '变化趋势',
    type: 'list',
    rows: [
      { label: '第一周', value: '1,204', trend: '+8.2%' },
      { label: '第二周', value: '1,368', trend: '+13.6%' },
      { label: '第三周', value: '1,152', trend: '-15.8%' },
      { label: '第四周', value: '1,490', trend: '+29.3%' },
      { label: '第五周', value: '1,426', trend: '-4.3%' },
    ],
  },
  {
    title: '排行 TOP 5',
    type: 'rank',
    rows: [
      { label: '区域 A', value: '2,486' },
      { label: '区域 B', value: '2,130' },
      { label: '区域 C', value: '1,908' },
      { label: '区域 D', value: '1,452' },
      { label: '区域 E', value: '1,076' },
    ],
  },
  {
    title: '月度走势',
    type: 'columns',
    columns: [42, 58, 35, 72, 64, 88, 55, 76, 62, 91, 70, 84],
    axis: ['1月', '6月', '12月'],
  },
  {
    title: '实时明细',
    type: 'table',
    columns: ['名称', '数量', '状态'],
    rows: [
      { name: '条目 01', value: '1,024', status: '正常' },
      { name: '条目 02', value: '868', status: '正常' },
      { name: '条目 03', value: '542', status: '关注' },
      { name: '条目 04', value: '316', status: '正常' },
    ],
  },
]

/** 弹窗示例：表格 / 表单 / 详情三种样式 */
export const modalTable = {
  title: '列表示例',
  columns: ['编号', '名称', '数量', '状态'],
  rows: [
    { id: 'A-001', name: '示例条目一', value: '1,024', status: '正常' },
    { id: 'A-002', name: '示例条目二', value: '868', status: '正常' },
    { id: 'A-003', name: '示例条目三', value: '542', status: '关注' },
    { id: 'A-004', name: '示例条目四', value: '316', status: '正常' },
    { id: 'A-005', name: '示例条目五', value: '208', status: '关注' },
  ],
}

export const modalForm = {
  title: '表单示例',
  fields: [
    { label: '名称', type: 'input', placeholder: '请输入名称' },
    { label: '类型', type: 'select', options: ['类型一', '类型二', '类型三'] },
    { label: '日期', type: 'date', placeholder: '请选择日期' },
    { label: '备注', type: 'textarea', placeholder: '请输入备注' },
  ],
}

export const modalDetail = {
  title: '详情示例',
  info: [
    { label: '编号', value: 'A-001' },
    { label: '名称', value: '示例条目一' },
    { label: '所属区域', value: '区域 A' },
    { label: '数量', value: '1,024' },
    { label: '更新时间', value: '2026-11-10 09:30:00' },
    { label: '状态', value: '正常' },
  ],
  summary: '这里是一段用于展示弹窗正文排版的示例说明文字，可替换为实际项目中的描述内容。',
}
