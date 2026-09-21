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
  Typography,
  message,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { createUser, listUsers, updateUser } from '../api/users';
import { useAppStore } from '../stores/appStore';
import { ROLE_ADMIN, ROLE_HANDLER, ROLE_READONLY, WriteGate, useAdminAccess } from '../stores/roleAccess';
import type { AppRole, UserAdminFilter, UserAdminItem } from '../types/api';

/**
 * 系统管理 —— 用户管理（Task #35：原 501 桩 / Mock 页换成真接口）。
 *
 * 口径（docs/2026-09-21-角色权限映射.md §3.4、§5）：
 *  - 整页 admin 独占：菜单过滤 + App.tsx 的 RequireRole + 后端策略表 U1–U3 与 requireRole('admin')；
 *  - **没有"删除"**：后端不提供 DELETE，下线账号用「禁用」，
 *    否则历史审计里的 user_id 会变成查无此人的孤号；
 *  - 建号只给初始口令，之后不回显也改不了（改口令本批未做，已记遗留）；
 *  - 防呆（最后一个 admin 不可自禁/自降、不能禁用自己）由后端返回 409，
 *    页面原样显示那句话，不粉饰成"保存失败"；
 *  - 旧 Mock 的「操作日志」页签已撤下：读 operation_audit_log 的接口本批不做，
 *    留假数据比没有更糟（零 mock 是红线）。
 */

const ROLE_OPTIONS: { value: AppRole; label: string }[] = [
  { value: ROLE_ADMIN, label: '系统管理员（全部权限，用户/字典管理独占）' },
  { value: ROLE_HANDLER, label: '业务经办（可写业务，不可管用户与字典）' },
  { value: ROLE_READONLY, label: '只读（仅 GET）' },
];

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
    createForm.setFieldsValue({ role: ROLE_HANDLER });
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

  /**
   * 角色说明：三档能力对照，抄自映射表 §1 与 §3。
   * 这里是**策略文本**不是业务数据：没有假账号、没有假用户数。
   */
  const roleTab = (
    <div>
      <Table
        rowKey="role"
        size="middle"
        pagination={false}
        dataSource={[
          {
            role: ROLE_ADMIN,
            name: '系统管理员',
            write: '全部业务写 + 用户管理 + 字典管理',
            note: '策略表所有端点放行；新增路由漏声明时默认也只有它能用（默认拒绝）',
          },
          {
            role: ROLE_HANDLER,
            name: '业务经办',
            write: '交办 / 纠偏确认 / 归库 / 推送 / 归档 / 回填类写接口',
            note: '不可管用户、不可改字典；受控撤销按业务动作放开',
          },
          {
            role: ROLE_READONLY,
            name: '只读',
            write: '无（任何非 GET 一律 403）',
            note: '后端在判定前先剔除 readonly，误配策略也放不开',
          },
        ]}
        columns={[
          { title: '档位', dataIndex: 'name', width: 120, render: (v: string) => <Tag color="blue">{v}</Tag> },
          { title: '可写范围', dataIndex: 'write' },
          { title: '口径', dataIndex: 'note' },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        一人一档：roles 数组本批按单档使用。全部判定见 <code>docs/2026-09-21-角色权限映射.md</code>，
        代码真源 <code>server/src/auth/rolePolicy.ts</code>，可用 <code>npm run verify:rbac</code> 复算。
      </Typography.Paragraph>
    </div>
  );

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>系统管理</h2>
      <Tabs
        items={[
          { key: 'users', label: <span><UserOutlined /> 用户管理</span>, children: userTab },
          { key: 'roles', label: <span><SettingOutlined /> 角色说明</span>, children: roleTab },
        ]}
      />

      <Modal
        title="新增用户"
        open={createOpen}
        onOk={() => void submitCreate()}
        onCancel={() => setCreateOpen(false)}
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
            extra="8–72 个字符；只在创建时提交一次，任何接口都不会回显它"
            rules={[{ required: true, message: '请输入初始口令' }, { min: 8, max: 72, message: '8–72 个字符' }]}
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
