import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';
import {
  createSensitiveWord,
  executeSensitiveRescan,
  listSensitiveWords,
  previewSensitiveRescan,
  updateSensitiveWord,
} from '../api/sensitiveWords';
import type {
  ApiError,
  ManagedSensitiveWord,
  SensitiveRescanPreview,
} from '../types/api';

type DemoDictItem = {
  key: number;
  label: string;
  value: string;
  sort: number;
  status: number;
};

const dictData: Record<string, DemoDictItem[]> = {
  complaint_type: [
    { key: 1, label: '投诉', value: 'complaint', sort: 1, status: 1 },
    { key: 2, label: '咨询', value: 'consult', sort: 2, status: 1 },
    { key: 3, label: '建议', value: 'suggest', sort: 3, status: 1 },
    { key: 4, label: '举报', value: 'report', sort: 4, status: 1 },
    { key: 5, label: '求助', value: 'help', sort: 5, status: 1 },
    { key: 6, label: '其他', value: 'other', sort: 6, status: 1 },
    { key: 7, label: '表扬', value: 'praise', sort: 7, status: 1 },
  ],
  business_type: [
    { key: 1, label: '供水', value: 'water', sort: 1, status: 1 },
    { key: 2, label: '燃气', value: 'gas', sort: 2, status: 1 },
    { key: 3, label: '液化气', value: 'lpg', sort: 3, status: 1 },
  ],
  urgency_level: [
    { key: 1, label: '一般', value: 'normal', sort: 1, status: 1 },
    { key: 2, label: '紧急', value: 'urgent', sort: 2, status: 1 },
    { key: 3, label: '特急', value: 'critical', sort: 3, status: 1 },
  ],
  source: [
    { key: 1, label: '市民之家', value: 'citizen_hall', sort: 1, status: 1 },
    { key: 2, label: '12345热线', value: 'hotline_12345', sort: 2, status: 1 },
    { key: 3, label: '移动端', value: 'mobile_app', sort: 3, status: 1 },
    { key: 4, label: '网页端', value: 'web', sort: 4, status: 1 },
  ],
  grid_district: [
    { key: 1, label: '西陵区', value: 'xiling', sort: 1, status: 1 },
    { key: 2, label: '伍家岗区', value: 'wujiagang', sort: 2, status: 1 },
    { key: 3, label: '点军区', value: 'dianjun', sort: 3, status: 1 },
    { key: 4, label: '猇亭区', value: 'xiaoting', sort: 4, status: 1 },
    { key: 5, label: '夷陵区', value: 'yiling', sort: 5, status: 1 },
  ],
};

const dictTabs = [
  { key: 'sensitive_word', label: '敏感词' },
  { key: 'complaint_type', label: '诉求类型' },
  { key: 'business_type', label: '业务类型' },
  { key: 'urgency_level', label: '紧急程度' },
  { key: 'source', label: '诉求来源' },
  { key: 'grid_district', label: '区域划分' },
];

function errorText(error: unknown): string {
  return (error as ApiError)?.message || '操作失败，请稍后重试';
}

export const SensitiveWordManager: React.FC = () => {
  const [rows, setRows] = useState<ManagedSensitiveWord[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedSensitiveWord | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SensitiveRescanPreview | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [form] = Form.useForm<{ word: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listSensitiveWords());
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledCount = rows.filter((row) => row.status === 'enabled').length;
  const hitCount = rows.reduce((total, row) => total + row.hitCount, 0);
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return rows;
    return rows.filter((row) => row.word.toLocaleLowerCase().includes(term));
  }, [rows, search]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setEditorOpen(true);
  };

  const openEdit = (row: ManagedSensitiveWord) => {
    setEditing(row);
    form.setFieldsValue({ word: row.word });
    setEditorOpen(true);
  };

  const save = async () => {
    let values: { word: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateSensitiveWord(editing.itemId, { word: values.word });
        message.success('敏感词已更新');
      } else {
        await createSensitiveWord(values.word);
        message.success('敏感词已新增并立即用于新诉求识别');
      }
      setEditorOpen(false);
      form.resetFields();
      await load();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = (row: ManagedSensitiveWord) => {
    const enabling = row.status === 'disabled';
    Modal.confirm({
      title: enabling ? '启用敏感词' : '停用敏感词',
      content: enabling
        ? `启用“${row.word}”后，将立即用于新诉求识别。`
        : `停用“${row.word}”后不再用于新诉求识别，历史命中证据仍会保留。`,
      okText: enabling ? '确认启用' : '确认停用',
      okButtonProps: { danger: !enabling },
      cancelText: '取消',
      onOk: async () => {
        try {
          await updateSensitiveWord(row.itemId, {
            status: enabling ? 'enabled' : 'disabled',
          });
          message.success(enabling ? '敏感词已启用' : '敏感词已停用');
          await load();
        } catch (error) {
          message.error(errorText(error));
          throw error;
        }
      },
    });
  };

  const openPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await previewSensitiveRescan());
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setPreviewing(false);
    }
  };

  const runRescan = async () => {
    if (!preview) return;
    setRescanning(true);
    try {
      const result = await executeSensitiveRescan(preview.previewToken);
      message.success(`历史重扫完成，更新 ${result.updated} 条诉求`);
      setPreview(null);
      await load();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setRescanning(false);
    }
  };

  const columns: ColumnsType<ManagedSensitiveWord> = [
    { title: '敏感词', dataIndex: 'word', width: 260 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === 'enabled' ? 'success' : 'default'}>
          {status === 'enabled' ? '启用' : '停用'}
        </Tag>
      ),
    },
    { title: '历史命中证据', dataIndex: 'hitCount', width: 140 },
    {
      title: '操作',
      width: 180,
      render: (_, row) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger={row.status === 'enabled'}
            onClick={() => toggleStatus(row)}
          >
            {row.status === 'enabled' ? '停用' : '启用'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="规则说明"
        description="启用词条会对新进入的诉求标题、内容和地址做包含匹配。词条不物理删除，停用后仍保留历史命中证据；历史数据只有在预览并再次确认后才会更新敏感标记。"
      />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}><Card size="small"><Statistic title="词条总数" value={rows.length} /></Card></Col>
        <Col xs={24} sm={8}><Card size="small"><Statistic title="当前启用" value={enabledCount} /></Card></Col>
        <Col xs={24} sm={8}><Card size="small"><Statistic title="历史命中证据" value={hitCount} /></Card></Col>
      </Row>

      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索敏感词"
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ width: 220 }}
          allowClear
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增敏感词</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
        <Tag>共 {filtered.length} 条</Tag>
      </Space>

      <Table
        rowKey="itemId"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        size="middle"
        pagination={false}
      />

      <Card title="历史诉求重扫" size="small" style={{ marginTop: 20 }}>
        <Space direction="vertical" size={12}>
          <div>先计算影响范围，不会直接修改数据。确认执行时只更新敏感标记、关键词、规则置信度、规则版本、更新时间和命中证据，不改变交办、归库或人工处置状态。</div>
          <Button icon={<SyncOutlined />} loading={previewing} onClick={() => void openPreview()}>
            预览历史重扫
          </Button>
        </Space>
      </Card>

      <Modal
        title={editing ? '编辑敏感词' : '新增敏感词'}
        open={editorOpen}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
          form.resetFields();
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="word"
            label="敏感词"
            rules={[
              { required: true, whitespace: true, message: '请输入敏感词' },
              { max: 128, message: '敏感词最长 128 个字符' },
              {
                validator: (_, value?: string) =>
                  value && /[,，、]/u.test(value)
                    ? Promise.reject(new Error('敏感词不能包含逗号、中文逗号或顿号'))
                    : Promise.resolve(),
              },
            ]}
          >
            <Input placeholder="例如：燃气泄漏" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="历史重扫影响预览"
        open={preview !== null}
        onCancel={() => setPreview(null)}
        onOk={() => void runRescan()}
        okText="确认重扫并写入"
        cancelText="取消"
        confirmLoading={rescanning}
        okButtonProps={{ danger: true }}
      >
        {preview && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="请核对影响范围"
              description={`预览令牌仅当前管理员可使用一次，有效至 ${new Date(preview.expiresAt).toLocaleString()}。期间词表或诉求数据变化时，服务端会拒绝执行。`}
            />
            <Row gutter={[12, 12]}>
              <Col span={12}><Statistic title="扫描总数" value={preview.summary.total} /></Col>
              <Col span={12}><Statistic title="将变为敏感" value={preview.summary.wouldBecomeSensitive} /></Col>
              <Col span={12}><Statistic title="将取消敏感" value={preview.summary.wouldBecomeNonSensitive} /></Col>
              <Col span={12}><Statistic title="关键词将变化" value={preview.summary.keywordsChanged} /></Col>
              <Col span={12}><Statistic title="保持不变" value={preview.summary.unchanged} /></Col>
            </Row>
            <div>本次启用词：{preview.enabledWords.map((word) => <Tag key={word}>{word}</Tag>)}</div>
          </Space>
        )}
      </Modal>
    </div>
  );
};

const demoColumns: ColumnsType<DemoDictItem> = [
  { title: '排序', dataIndex: 'sort', width: 60 },
  { title: '标签', dataIndex: 'label', width: 200 },
  { title: '编码值', dataIndex: 'value', width: 200 },
  {
    title: '状态', dataIndex: 'status', width: 80,
    render: (status) => <Tag color={status === 1 ? 'success' : 'error'}>{status === 1 ? '启用' : '禁用'}</Tag>,
  },
  {
    title: '操作', width: 120,
    render: () => (
      <Tooltip title="功能未实现（批次 G1）">
        <span><Button type="link" size="small" icon={<EditOutlined />} disabled>编辑</Button></span>
      </Tooltip>
    ),
  },
];

const DictManager: React.FC = () => {
  const [activeTab, setActiveTab] = useState('sensitive_word');
  const [search, setSearch] = useState('');
  const currentData = dictData[activeTab] || [];
  const filtered = currentData.filter((item) =>
    !search || item.label.includes(search) || item.value.includes(search)
  );

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>字典管理</h2>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={dictTabs} />
      {activeTab === 'sensitive_word' ? (
        <SensitiveWordManager />
      ) : (
        <>
          <DemoDataNotice batch="G1" />
          <Space style={{ margin: '16px 0' }}>
            <Input
              placeholder="搜索字典项"
              prefix={<SearchOutlined />}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 220 }}
              allowClear
            />
            <Tooltip title="功能未实现（批次 G1）">
              <span><Button type="primary" icon={<PlusOutlined />} disabled>新增字典项</Button></span>
            </Tooltip>
            <Tag>共 {filtered.length} 条</Tag>
          </Space>
          <Table rowKey="key" columns={demoColumns} dataSource={filtered} size="middle" pagination={false} />
        </>
      )}
    </div>
  );
};

export default DictManager;
