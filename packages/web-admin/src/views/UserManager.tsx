import React, { useState } from 'react';
import { Tabs, Table, Tag, Space, Button, Input, Select, Card, Row, Col, Statistic, Modal, Form, Switch, Tree, Tooltip } from 'antd';
import { SearchOutlined, UserOutlined, TeamOutlined, SafetyCertificateOutlined, FileTextOutlined, PlusOutlined, EditOutlined, DeleteOutlined, LockOutlined } from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';

const users = [
  { key: 1, username: 'admin', realName: '系统管理员', phone: '13800000001', email: 'admin@yichang.gov.cn', deptName: '水燃中心', roles: ['超级管理员'], status: 1, lastLoginTime: '2026-05-28 08:30:00', lastLoginIp: '10.18.33.100' },
  { key: 2, username: 'zhangsan', realName: '张三', phone: '13800000002', email: 'zhangsan@yichang.gov.cn', deptName: '供水监管科', roles: ['供水监管员'], status: 1, lastLoginTime: '2026-05-28 09:15:00', lastLoginIp: '10.18.33.101' },
  { key: 3, username: 'lisi', realName: '李四', phone: '13800000003', email: 'lisi@yichang.gov.cn', deptName: '燃气监管科', roles: ['燃气监管员'], status: 1, lastLoginTime: '2026-05-28 10:00:00', lastLoginIp: '10.18.33.102' },
  { key: 4, username: 'wangwu', realName: '王五', phone: '13800000004', email: 'wangwu@yichang.gov.cn', deptName: '数据分析科', roles: ['数据分析师'], status: 1, lastLoginTime: '2026-05-27 16:30:00', lastLoginIp: '10.18.33.103' },
  { key: 5, username: 'zhaoliu', realName: '赵六', phone: '13800000005', email: 'zhaoliu@yichang.gov.cn', deptName: '供水监管科', roles: ['供水监管员'], status: 1, lastLoginTime: '2026-05-28 07:45:00', lastLoginIp: '10.18.33.104' },
  { key: 6, username: 'sunqi', realName: '孙七', phone: '13800000006', email: 'sunqi@yichang.gov.cn', deptName: '系统运维科', roles: ['运维管理员'], status: 1, lastLoginTime: '2026-05-26 14:20:00', lastLoginIp: '10.18.33.105' },
  { key: 7, username: 'zhouba', realName: '周八', phone: '13800000007', email: 'zhouba@yichang.gov.cn', deptName: '燃气监管科', roles: ['燃气监管员'], status: 0, lastLoginTime: '2026-04-15 11:00:00', lastLoginIp: '10.18.33.106' },
  { key: 8, username: 'wujiu', realName: '吴九', phone: '13800000008', email: 'wujiu@yichang.gov.cn', deptName: '数据分析科', roles: ['数据分析师'], status: 1, lastLoginTime: '2026-05-28 08:00:00', lastLoginIp: '10.18.33.107' },
];

const roles = [
  { key: 1, name: '超级管理员', code: 'ROLE_ADMIN', description: '系统最高权限，可管理所有功能模块', userCount: 1, status: 1 },
  { key: 2, name: '供水监管员', code: 'ROLE_WATER', description: '供水相关诉求的查看和处理权限', userCount: 2, status: 1 },
  { key: 3, name: '燃气监管员', code: 'ROLE_GAS', description: '燃气相关诉求的查看和处理权限', userCount: 2, status: 1 },
  { key: 4, name: '数据分析师', code: 'ROLE_ANALYST', description: '数据分析和报告生成权限', userCount: 2, status: 1 },
  { key: 5, name: '运维管理员', code: 'ROLE_OPS', description: '系统运维和日志管理权限', userCount: 1, status: 1 },
];

const roleMenus = [
  { title: '数据大屏', key: 'dashboard', children: [{ title: '态势大屏', key: 'dashboard:view' }] },
  { title: '诉求管理', key: 'complaint', children: [{ title: '诉求列表', key: 'complaint:list' },{ title: '诉求详情', key: 'complaint:detail' },{ title: '诉求导入导出', key: 'complaint:export' }] },
  { title: '数据分析', key: 'analysis', children: [{ title: '数据分析', key: 'analysis:view' },{ title: '报告导出', key: 'analysis:export' }] },
  { title: '敏感交办', key: 'dispatch', children: [{ title: '交办管理', key: 'dispatch:manage' },{ title: '敏感词管理', key: 'dispatch:sensitive' }] },
  { title: '企业管理', key: 'company', children: [{ title: '企业信息', key: 'company:view' },{ title: '资质管理', key: 'company:cert' },{ title: '年度考核', key: 'company:assess' }] },
  { title: '网格管理', key: 'grid', children: [{ title: '网格管理', key: 'grid:manage' }] },
  { title: '停供管理', key: 'shutdown', children: [{ title: '停供审批', key: 'shutdown:approve' }] },
  { title: '系统管理', key: 'system', children: [{ title: '用户管理', key: 'system:user' },{ title: '角色管理', key: 'system:role' },{ title: '操作日志', key: 'system:log' }] },
];

const logs = Array.from({ length: 20 }, (_, i) => ({
  key: i + 1,
  operator: users[i % 8].realName,
  module: ['诉求管理','数据分析','敏感交办','企业管理','网格管理','系统管理'][i % 6],
  operation: ['查询','新增','修改','删除','导出','登录'][i % 6],
  target: ['诉求CS001','用户信息','企业资料','角色权限','字典配置','系统参数'][i % 6],
  ip: '10.18.33.' + (100 + i),
  result: i % 10 !== 0,
  duration: Math.floor(Math.random() * 500) + 10,
  createdAt: new Date(Date.now() - i * 3600000 * 2).toISOString(),
}));

const UserManager: React.FC = () => {
  const [search, setSearch] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [roleModalVisible, setRoleModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [form] = Form.useForm();
  const [localUsers, setLocalUsers] = useState(users);

  const userColumns = [
    { title: '用户名', dataIndex: 'username', width: 100 },
    { title: '姓名', dataIndex: 'realName', width: 100 },
    { title: '手机号', dataIndex: 'phone', width: 120 },
    { title: '邮箱', dataIndex: 'email', width: 180 },
    { title: '部门', dataIndex: 'deptName', width: 100 },
    { title: '角色', dataIndex: 'roles', width: 160, render: (r: string[]) => r.map(role => <Tag key={role} color="blue">{role}</Tag>) },
    { title: '状态', dataIndex: 'status', width: 70, render: (s: number) => <Tag color={s === 1 ? 'success' : 'error'}>{s === 1 ? '启用' : '禁用'}</Tag> },
    { title: '最后登录', dataIndex: 'lastLoginTime', width: 150 },
    { title: '操作', width: 140, fixed: 'right' as const,
      render: (_: any, r: any) => <Space>
        <Tooltip title="功能未实现（批次 G1.6 之后）"><span><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditingUser(r); form.setFieldsValue(r); setModalVisible(true); }} disabled>编辑</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 G1.6 之后）"><span><Button type="link" size="small" danger icon={<DeleteOutlined />} disabled>删除</Button></span></Tooltip>
      </Space> },
  ];

  const roleColumns = [
    { title: '角色名称', dataIndex: 'name', width: 140 },
    { title: '编码', dataIndex: 'code', width: 160, render: (c: string) => <Tag>{c}</Tag> },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: '用户数', dataIndex: 'userCount', width: 80 },
    { title: '状态', dataIndex: 'status', width: 70, render: (s: number) => <Tag color={s ? 'success' : 'error'}>{s ? '启用' : '禁用'}</Tag> },
    { title: '操作', width: 120,
      render: () => <Space>
        <Tooltip title="功能未实现（批次 G1.6 之后）"><span><Button type="link" size="small" icon={<EditOutlined />} onClick={() => setRoleModalVisible(true)} disabled>权限</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 G1.6 之后）"><span><Button type="link" size="small" icon={<DeleteOutlined />} danger disabled>删除</Button></span></Tooltip>
      </Space> },
  ];

  const logColumns = [
    { title: '操作人', dataIndex: 'operator', width: 80 },
    { title: '模块', dataIndex: 'module', width: 80 },
    { title: '操作', dataIndex: 'operation', width: 60 },
    { title: '操作对象', dataIndex: 'target', width: 120 },
    { title: 'IP', dataIndex: 'ip', width: 120 },
    { title: '结果', dataIndex: 'result', width: 60, render: (r: boolean) => <Tag color={r ? 'success' : 'error'}>{r ? '成功' : '失败'}</Tag> },
    { title: '耗时', dataIndex: 'duration', width: 70, render: (d: number) => d + 'ms' },
    { title: '时间', dataIndex: 'createdAt', width: 150, render: (t: string) => new Date(t).toLocaleString('zh-CN') },
  ];

  const handleSaveUser = () => {
    form.validateFields().then(vals => {
      if (editingUser) {
        setLocalUsers(localUsers.map(u => u.key === editingUser.key ? { ...u, ...vals } : u));
      } else {
        setLocalUsers([...localUsers, { key: Math.max(...localUsers.map(u => u.key)) + 1, ...vals, status: 1, lastLoginTime: '-', lastLoginIp: '-' }]);
      }
      setModalVisible(false); setEditingUser(null); form.resetFields();
    });
  };

  const filteredUsers = localUsers.filter(u => !search || u.realName.includes(search) || u.username.includes(search));

  const tabItems = [
    { key: 'users', label: <span><UserOutlined /> 用户管理</span>, children: (
      <div>
        <Row gutter={12} style={{ marginBottom: 16 }}>
          <Col span={4}><Card size="small"><Statistic title="用户总数" value={localUsers.length} prefix={<UserOutlined />} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title="启用" value={localUsers.filter(u=>u.status===1).length} valueStyle={{color:'#52c41a'}} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title="禁用" value={localUsers.filter(u=>u.status===0).length} valueStyle={{color:'#ff4d4f'}} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title="今日在线" value={5} prefix={<Tag color="green">●</Tag>} /></Card></Col>
          <Col span={8}><Space style={{marginTop:8}}><Input placeholder="搜索用户" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} allowClear /><Tooltip title="功能未实现（批次 G1.6 之后）"><span><Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingUser(null); form.resetFields(); setModalVisible(true); }} disabled>新增用户</Button></span></Tooltip></Space></Col>
        </Row>
        <Table columns={userColumns} dataSource={filteredUsers} size="middle" scroll={{ x: 1100 }} pagination={{ defaultPageSize: 10 }} />
      </div>
    )},
    { key: 'roles', label: <span><SafetyCertificateOutlined /> 角色权限</span>, children: (
      <div>
        <Row gutter={12} style={{ marginBottom: 16 }}>
          <Col span={4}><Card size="small"><Statistic title="角色总数" value={roles.length} prefix={<TeamOutlined />} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title="启用" value={roles.filter(r=>r.status).length} valueStyle={{color:'#52c41a'}} /></Card></Col>
          <Col span={16}><Space style={{marginTop:8}}><Tooltip title="功能未实现（批次 G1.6 之后）"><span><Button type="primary" icon={<PlusOutlined />} disabled>新增角色</Button></span></Tooltip></Space></Col>
        </Row>
        <Table columns={roleColumns} dataSource={roles} size="middle" pagination={false} />
      </div>
    )},
    { key: 'logs', label: <span><FileTextOutlined /> 操作日志</span>, children: (
      <div>
        <Space style={{ marginBottom: 16 }}>
          <Select defaultValue="all" style={{ width: 100 }} options={[{value:'all',label:'全部模块'},{value:'诉求管理',label:'诉求管理'},{value:'系统管理',label:'系统管理'}]} />
          <Select defaultValue="all" style={{ width: 100 }} options={[{value:'all',label:'全部操作'},{value:'查询',label:'查询'},{value:'修改',label:'修改'},{value:'删除',label:'删除'}]} />
          <Button icon={<SearchOutlined />}>查询</Button>
        </Space>
        <Table columns={logColumns} dataSource={logs} size="middle" scroll={{ x: 900 }} pagination={{ defaultPageSize: 12 }} />
      </div>
    )},
  ];

  return (
    <div>
      <DemoDataNotice batch="G1.6 之后" />
      <h2 style={{ marginBottom: 16 }}>系统管理</h2>
      <Tabs items={tabItems} />

      <Modal title={editingUser ? '编辑用户' : '新增用户'} open={modalVisible} onOk={handleSaveUser} onCancel={() => { setModalVisible(false); setEditingUser(null); form.resetFields(); }} width={500}>
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input placeholder="登录用户名" /></Form.Item>
          <Form.Item name="realName" label="姓名" rules={[{ required: true }]}><Input placeholder="真实姓名" /></Form.Item>
          <Form.Item name="phone" label="手机号"><Input placeholder="手机号" /></Form.Item>
          <Form.Item name="email" label="邮箱"><Input placeholder="邮箱" /></Form.Item>
          <Form.Item name="deptName" label="部门"><Select options={['水燃中心','供水监管科','燃气监管科','数据分析科','系统运维科'].map(d => ({value:d,label:d}))} /></Form.Item>
          <Form.Item name="roles" label="角色"><Select mode="multiple" options={roles.map(r => ({value:r.name,label:r.name}))} /></Form.Item>
          <Form.Item name="status" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="禁用" /></Form.Item>
        </Form>
      </Modal>

      <Modal title="权限分配" open={roleModalVisible} onCancel={() => setRoleModalVisible(false)} onOk={() => { setRoleModalVisible(false); }} width={500}>
        <Tree checkable defaultExpandAll treeData={roleMenus} />
      </Modal>
    </div>
  );
};

export default UserManager;
