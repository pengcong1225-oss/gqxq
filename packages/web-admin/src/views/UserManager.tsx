import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { listRoles,type PlatformRole } from '../api/roles';
import { createUser, listUsers, updateUser, resetPassword } from '../api/users';
import { useAppStore } from '../stores/appStore';
import { ROLE_ADMIN, ROLE_HANDLER, WriteGate, useAdminAccess } from '../stores/roleAccess';
import type { AppRole, UserAdminFilter, UserAdminItem } from '../types/api';

/** Existing account CRUD with backend role choices and protected reset capability.
 * Local creation requires one explicit role; disabled accounts preserve audit identity. */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmt(iso: string | null): React.ReactNode {
  return iso === null ? (
    <span style={{ color: '#bfbfbf' }}>从未登录</span>
  ) : (
    new Date(iso).toLocaleString('zh-CN')
  );
}

interface CreateForm {
  username: string;
  realName: string;
  role: AppRole;
  password: string;
}

interface EditForm {
  realName: string;
  role: AppRole;
  status: 0 | 1;
}

const UserManager: React.FC = () => {
  const { can: isAdmin, tip: adminTip } = useAdminAccess();
  const myUserId = useAppStore((s) => s.userInfo?.userId ?? null);

  const [roleRows,setRoleRows]=useState<PlatformRole[]>([]);
  const ROLE_OPTIONS=roleRows.filter(r=>r.enabled).map(r=>({value:r.roleCode,label:r.name}));
  const [resetting,setResetting]=useState<UserAdminItem|null>(null);
  const [resetForm]=Form.useForm();
  useEffect(()=>{if(isAdmin)void listRoles().then(setRoleRows).catch(e=>message.error(errText(e)));},[isAdmin]);
  const [rows, setRows] = useState<UserAdminItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 输入框里的关键词：要按「查询」或回车才生效，不每敲一个字打一次接口 */
  const [keywordInput, setKeywordInput] = useState('');
  const [filters, setFilters] = useState<UserAdminFilter>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserAdminItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createForm] = Form.useForm<CreateForm>();
  const [editForm] = Form.useForm<EditForm>();
  const seqRef = useRef(0);

  const load = useCallback(
    async (p: number, s: number, f: UserAdminFilter) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await listUsers({ ...f, page: p, size: s });
        if (seq !== seqRef.current) return;
        setRows(res.content);
        setTotal(res.total);
      } catch (e) {
        if (seq !== seqRef.current) return;
        // 403 由 request.ts 统一提示；这里明说取不到，不摆一张"看起来正常"的空表
        setRows([]);
        setTotal(0);
        setLoadError(errText(e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (isAdmin) void load(page, size, filters);
  }, [isAdmin, page, size, filters, load]);

  const refresh = useCallback(() => void load(page, size, filters), [load, page, size, filters]);

  /** 换筛选条件就回到第一页，否则会停在"筛完只剩 3 条但当前是第 7 页"的空页上 */
  const changeFilters = (next: UserAdminFilter) => {
    setFilters(next);
    setPage(1);
  };

  const applyKeyword = () => changeFilters({ ...filters, keyword: keywordInput.trim() === '' ? undefined : keywordInput.trim() });

  const stats = useMemo(
    () => ({
      enabled: rows.filter((r) => r.status === 1).length,
      disabled: rows.filter((r) => r.status === 0).length,
      admins: rows.filter((r) => r.roles.includes(ROLE_ADMIN)).length,
    }),
    [rows]
  );

  const openCreate = () => {
    createForm.resetFields();

    setCreateOpen(true);
  };

  const submitCreate = async () => {
    let values: CreateForm;
    try {
      values = await createForm.validateFields();
    } catch {
      return; // 字段级提示已经给过了
    }
    setSubmitting(true);
    try {
      const created = await createUser(values);
      message.success('已创建 ' + created.username + '（' + created.roleNames.join('/') + '）');
      setCreateOpen(false);
      createForm.resetFields();
      refresh();
    } catch (e) {
      // 409「用户名已存在」/ 400 契约错误都照实显示后端那句话
      message.error(errText(e));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (row: UserAdminItem) => {
    setEditing(row);
    editForm.setFieldsValue({ realName: row.realName, role: row.roles[0], status: row.status });
  };

  const submitEdit = async () => {
    if (editing === null) return;
    let values: EditForm;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      const res = await updateUser(editing.userId, values);
      message.success(res.changed.length === 0 ? '无字段变化，未写入审计' : '已更新：' + res.changed.join('、'));
      setEditing(null);
      refresh();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSubmitting(false);
    }
  };

  /** 快捷启停：与编辑弹窗同一接口，只是省一次填表；防呆仍由后端把关 */
  const doToggle = async (row: UserAdminItem) => {
    const next: 0 | 1 = row.status === 1 ? 0 : 1;
    try {
      await updateUser(row.userId, { status: next });
      message.success(row.username + ' 已' + (next === 1 ? '启用' : '禁用'));
      refresh();
    } catch (e) {
      message.error(errText(e));
    }
  };

  const columns = [
    { title: '用户名', dataIndex: 'username', width: 160 },
    { title: '姓名', dataIndex: 'realName', width: 120 },
    {
      title: '角色',
      dataIndex: 'roleNames',
      width: 150,
      render: (names: string[], r: UserAdminItem) => (
        <Space size={4}>
          {names.map((n) => (
            <Tag
              key={n}
              color={r.roles[0] === ROLE_ADMIN ? 'gold' : r.roles[0] === ROLE_HANDLER ? 'blue' : 'default'}
            >
              {n}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: 0 | 1) => <Tag color={s === 1 ? 'success' : 'error'}>{s === 1 ? '启用' : '禁用'}</Tag>,
    },
    { title: '最后登录', dataIndex: 'lastLoginAt', width: 200, render: (v: string | null) => fmt(v) },
    {
      title: '操作',
      width: 260,
      fixed: 'right' as const,
      render: (_: unknown, r: UserAdminItem) => (
        <Space size={0}>
          <WriteGate allowed={isAdmin} tip={adminTip}>
            <Button type="link" size="small" onClick={() => openEdit(r)}>
              编辑
            </Button>
          </WriteGate>
          <WriteGate allowed={isAdmin} tip={adminTip}>
            <Button type="link" size="small" danger={r.status === 1} onClick={() => void doToggle(r)}>
              {r.status === 1 ? '禁用' : '启用'}
            </Button>
          </WriteGate>
          {/* 没有删除按钮：禁用即下线，历史审计里的 user_id 要还能查得到人 */}
          <Tooltip title="不提供删除：禁用即下线，历史审计要查得到人">
            <span style={{ marginLeft: 8, color: '#bfbfbf' }}>无删除</span>
          </Tooltip>
          <Button type="link" disabled={!isAdmin} onClick={()=>{resetForm.resetFields();setResetting(r);}}>重置口令</Button>
          {r.userId === myUserId ? <Tag style={{ marginLeft: 8 }}>当前登录</Tag> : null}
        </Space>
      ),
    },
  ];

  const userTab = (
    <div>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card size="small">
            <Statistic title="本页启用" value={stats.enabled} prefix={<UserOutlined />} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="本页禁用" value={stats.disabled} valueStyle={{ color: '#ff4d4f' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="账号总数" value={total} prefix={<TeamOutlined />} />
          </Card>
        </Col>
        <Col span={12}>
          <Space style={{ marginTop: 8 }} wrap>
            <Input
              placeholder="用户名 / 姓名"
              prefix={<SearchOutlined />}
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onPressEnter={applyKeyword}
              style={{ width: 170 }}
              allowClear
            />
            <Select
              placeholder="角色"
              style={{ width: 110 }}
              allowClear
              value={filters.role}
              onChange={(v: AppRole | undefined) => changeFilters({ ...filters, role: v })}
              options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label.split('（')[0] }))}
            />
            <Select
              placeholder="状态"
              style={{ width: 100 }}
              allowClear
              value={filters.status}
              onChange={(v: 0 | 1 | undefined) => changeFilters({ ...filters, status: v })}
              options={[
                { value: 1, label: '启用' },
                { value: 0, label: '禁用' },
              ]}
            />
            <Button icon={<SearchOutlined />} onClick={applyKeyword}>
              查询
            </Button>
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
            <WriteGate allowed={isAdmin} tip={adminTip}>
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新增用户
              </Button>
            </WriteGate>
          </Space>
        </Col>
      </Row>

      {loadError !== null && (
        <Alert type="error" showIcon message="加载失败" description={loadError} style={{ marginBottom: 12 }} />
      )}
      {isAdmin === false && (
        <Alert
          type="warning"
          showIcon
          message="本页面仅系统管理员可用"
          description="接口层按策略表 U1–U3 拒绝非 admin（403），所以这里不会显示任何账号。"
          style={{ marginBottom: 12 }}
        />
      )}

      <Table
        rowKey="userId"
        columns={columns}
        dataSource={rows}
        loading={loading}
        size="middle"
        scroll={{ x: 1000 }}
        pagination={{
          current: page,
          pageSize: size,
          total,
          showSizeChanger: true,
          showTotal: (t) => '共 ' + t + ' 个账号' + (stats.admins > 0 ? '（本页 admin ' + stats.admins + ' 个）' : ''),
          onChange: (p, s) => {
            setPage(p);
            setSize(s);
          },
        }}
      />
    </div>
  );

  return (
    <div>
      <Modal title={'重置口令：'+(resetting?.username??'')} open={Boolean(resetting)} onCancel={()=>{setResetting(null);resetForm.resetFields();}} onOk={async()=>{
       let values;try{values=await resetForm.validateFields();}catch{return;}
       try{await resetPassword(resetting!.userId,values.password);setResetting(null);resetForm.resetFields();message.success('已重置；旧会话失效，下次登录须改密');refresh();}catch(e){message.error(errText(e));}
      }} destroyOnClose>
      <Alert type="warning" message="旧会话立即失效；新口令请通过既定安全渠道交给本人，下次登录必须修改。"/>
      <Form form={resetForm} layout="vertical"><Form.Item name="password" label="新临时口令" rules={[{required:true},{min:8},{validator:(_,v)=>!v||new TextEncoder().encode(v).length<=72?Promise.resolve():Promise.reject(new Error('口令超过 72 字节'))}]}><Input.Password autoComplete="new-password"/></Form.Item></Form></Modal>
      <h2 style={{ marginBottom: 16 }}>系统管理</h2>
      <Tabs
        items={[
          { key: 'users', label: <span><UserOutlined /> 用户管理</span>, children: userTab },
        ]}
      />

      <Modal
        title="新增用户"
        open={createOpen}
        onOk={() => void submitCreate()}
        onCancel={() => {setCreateOpen(false);createForm.resetFields();}}
        confirmLoading={submitting}
        okText="创建"
        width={520}
      >
        <Form form={createForm} layout="vertical" disabled={submitting}>
          <Form.Item
            name="username"
            label="用户名"
            extra="2–64 字符，仅字母、数字与 . _ -（与 app_user.username 列宽一致）"
            rules={[
              { required: true, message: '请输入用户名' },
              { min: 2, max: 64, message: '2–64 个字符' },
              { pattern: /^[A-Za-z0-9._-]+$/, message: '仅字母、数字与 . _ -' },
            ]}
          >
            <Input placeholder="登录用户名，如 zhangsan" autoComplete="off" />
          </Form.Item>
          <Form.Item name="realName" label="姓名" rules={[{ required: true, message: '请输入真实姓名' }, { max: 64 }]}>
            <Input placeholder="真实姓名" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始口令"
            extra="至少 8 个字符、UTF-8 不超过 72 字节；首次登录须改密"
            rules={[{ required: true, message: '请输入初始口令' }, { min: 8, message: '至少 8 个字符' },{validator:(_,v)=>!v||new TextEncoder().encode(v).length<=72?Promise.resolve():Promise.reject(new Error('口令超过 72 字节'))}]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editing === null ? '编辑用户' : '编辑用户：' + editing.username}
        open={editing !== null}
        onOk={() => void submitEdit()}
        onCancel={() => setEditing(null)}
        confirmLoading={submitting}
        okText="保存"
        width={520}
      >
        <Form form={editForm} layout="vertical" disabled={submitting}>
          <Form.Item name="realName" label="姓名" rules={[{ required: true, message: '请输入真实姓名' }, { max: 64 }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            rules={[{ required: true }]}
            extra="改自己的角色会被拒（409）；降级最后一个 admin 也会被拒"
          >
            <Select
              options={ROLE_OPTIONS}
              disabled={editing !== null && editing.userId === myUserId}
            />
          </Form.Item>
          <Form.Item name="status" label="状态" valuePropName="checked" getValueFromEvent={(checked: boolean) => (checked ? 1 : 0)} getValueProps={(v) => ({ checked: v === 1 })}>
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default UserManager;
