import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  CheckOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import {
  confirmCorrection,
  generateCorrectionBatch,
  generateCorrections,
  listComplaintCorrections,
  listPendingCorrections,
  rejectCorrection,
} from '../api/corrections';
import type { DispatchedFilter } from '../api/corrections';
import { listEnterprises } from '../api/enterprises';
import type { CorrectionItem, EnterpriseListItem } from '../types/api';

/**
 * 纠偏待办（真实接口驱动）。
 *
 * 口径（业主 2026-09-20 裁定，纠偏与交办是**并行两条轴**）：
 *  - 纠偏是**数据质量轴**，覆盖**所有**诉求，与是否交办、是否审批通过无关；
 *    交办针对"原件"派单、不改诉求内容。旧口径"只有走过督办链路才进纠偏"已作废。
 *  - 每一项仍按字段逐项生成（企业名称/归属、地址、分类、坐标、摘要、企业处置结果）。
 *  - 「企业名称/归属」现在就是**确认责任单位**的唯一入口（总账的「匹配单位」按钮已下线）：
 *    取值必须从企业主数据里选，后端成对写回 enterprise_code + enterprise_name，编码未登记直接拒绝。
 *  - 无法确认的项留在待纠偏，**不假装完成**；判定不成立时可「无需纠偏」并留依据。
 *  - 纠偏闭环仍是进入分析库的前置条件之一；分析库口径本批未变（未交办 / 误报归库不纳入分析），
 *    所以"队列里有未交办的件、但它们不会进分析库"是正常状态。
 *  - 存量 / 新入站诉求靠「补齐全部诉求纠偏待办」这个幂等入口收敛进队列，页面不造任何数据。
 */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | number | undefined {
  return (e as { code?: string | number } | null)?.code;
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: 'warning', text: '待纠偏' },
  confirmed: { color: 'success', text: '已确认' },
  rejected: { color: 'default', text: '无需纠偏' },
};

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

/**
 * 经纬度在库里是 decimal 列。端到端实测：向这两个字段的 confirm 传非数字（例如中文）
 * 会让后端返回 500。所以必须在前端先拦成表单校验错误，而不是让用户撞 500。
 */
const NUMERIC_FIELDS = new Set(['location_lng', 'location_lat']);

/**
 * 责任单位这一项的特例：确认值是**企业主数据的登记编码**，不是手打的名称。
 * 后端拿这个编码回查 enterprise 表，成对写回 enterprise_code + enterprise_name；
 * 编码没登记就直接报错，不会静默写脏数据——所以这里只能给下拉，不给自由输入。
 */
const ENTERPRISE_FIELD = 'enterprise_name';

/** 交办轴筛选（两条轴并行，页面要能分别看） */
const DISPATCHED_OPTIONS: Array<{ label: string; value: DispatchedFilter | 'all' }> = [
  { label: '全部诉求', value: 'all' },
  { label: '已交办', value: 'dispatched' },
  { label: '未交办', value: 'undispatched' },
];

const AddressCorrection: React.FC = () => {
  // ---- 左侧队列 ----
  const [queue, setQueue] = useState<CorrectionItem[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const seqRef = useRef(0);
  /** 交办轴筛选：all=全部（两条轴一起看）、dispatched=只看交办过、undispatched=只看没交办过 */
  const [dispatched, setDispatched] = useState<DispatchedFilter | 'all'>('all');

  // ---- 企业主数据：确认责任单位时的下拉（值=enterprise_code） ----
  // 不做本地兜底清单：手抄的编码与登记值不一致时，后端会直接拒绝写入，页面不该假装能填。
  const [enterpriseOptions, setEnterpriseOptions] = useState<EnterpriseListItem[]>([]);
  const [enterpriseLoading, setEnterpriseLoading] = useState(false);
  const [enterpriseError, setEnterpriseError] = useState<string | null>(null);
  const enterpriseSeqRef = useRef(0);

  // ---- 批量补挂 ----
  const [batching, setBatching] = useState(false);

  // ---- 右侧闭环面板 ----
  const [selectedComplaintId, setSelectedComplaintId] = useState<string | null>(null);
  const [items, setItems] = useState<CorrectionItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  // ---- 生成纠偏待办 ----
  const [genId, setGenId] = useState('');
  const [generating, setGenerating] = useState(false);

  // ---- 确认 / 无需纠偏 ----
  const [confirmTarget, setConfirmTarget] = useState<CorrectionItem | null>(null);
  const [rejectTarget, setRejectTarget] = useState<CorrectionItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmForm] = Form.useForm();
  const [rejectForm] = Form.useForm();

  const fetchEnterprises = useCallback(async (keyword?: string) => {
    const seq = ++enterpriseSeqRef.current;
    setEnterpriseLoading(true);
    try {
      const res = await listEnterprises({
        keyword: keyword && keyword.trim() !== '' ? keyword.trim() : undefined,
        size: 100,
      });
      if (seq !== enterpriseSeqRef.current) return; // 丢弃过期响应
      setEnterpriseOptions(res.content);
      setEnterpriseError(null);
    } catch (err) {
      if (seq !== enterpriseSeqRef.current) return;
      setEnterpriseOptions([]); // 失败就是空，绝不回落到本地示例企业
      setEnterpriseError(errText(err));
    } finally {
      if (seq === enterpriseSeqRef.current) setEnterpriseLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEnterprises();
  }, [fetchEnterprises]);

  const loadQueue = useCallback(
    async (p: number, s: number, d: DispatchedFilter | 'all') => {
      const seq = ++seqRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await listPendingCorrections({
          page: p,
          size: s,
          dispatched: d === 'all' ? undefined : d,
        });
        if (seq !== seqRef.current) return;
        setQueue(res.content);
        setQueueTotal(res.total);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setLoadError(errText(err));
        setQueue([]);
        setQueueTotal(0);
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setFirstLoaded(true);
        }
      }
    },
    []
  );

  useEffect(() => {
    void loadQueue(page, size, dispatched);
  }, [loadQueue, page, size, dispatched]);

  /** 换筛选口径时回到第 1 页，否则可能停在当前口径下不存在的页码 */
  const applyDispatchedFilter = useCallback((next: DispatchedFilter | 'all') => {
    setDispatched(next);
    setPage(1);
  }, []);

  const loadItems = useCallback(async (complaintId: string) => {
    setItemsLoading(true);
    setItemsError(null);
    try {
      const res = await listComplaintCorrections(complaintId);
      setItems(res);
    } catch (err) {
      setItemsError(errText(err));
      setItems([]);
    } finally {
      setItemsLoading(false);
    }
  }, []);

  /** 选中某诉求：加载它的全部纠偏项 */
  const selectComplaint = useCallback(
    (complaintId: string) => {
      setSelectedComplaintId(complaintId);
      void loadItems(complaintId);
    },
    [loadItems]
  );

  /** 确认/无需纠偏之后：刷新该诉求的纠偏项与左侧队列；若已闭环则提示进入分析库 */
  const afterDecision = useCallback(
    async (complaintId: string, analysisEntered?: boolean) => {
      await loadItems(complaintId);
      await loadQueue(page, size, dispatched);
      // 「是否已进入分析库」用**后端返回的判定**（confirm/reject 响应里的 analysisEntered），
      // 不在前端靠"数还有没有 pending 项"来推断——那是猜测，不是事实。
      if (analysisEntered === true) {
        message.success('该项已处置，且该诉求纠偏已全部闭环——已进入分析库（可在「分析库」页查到）');
      } else {
        message.success('已处置该项纠偏');
      }
    },
    [loadItems, loadQueue, page, size, dispatched]
  );

  const doGenerate = async () => {
    const id = genId.trim();
    if (id === '') {
      message.warning('请先填写诉求编号或 ID');
      return;
    }
    setGenerating(true);
    try {
      const res = await generateCorrections(id);
      if (res.created) {
        message.success('已生成 ' + res.total + ' 项纠偏待办');
      } else {
        message.info('该诉求已有纠偏项（共 ' + res.total + ' 项），未重复生成');
      }
      setGenId('');
      selectComplaint(res.complaintId);
      await loadQueue(page, size, dispatched);
    } catch (err) {
      const code = errCode(err);
      if (code === 404 || code === 'NOT_FOUND') {
        message.error('未找到该诉求：' + errText(err));
      } else {
        message.error('生成失败：' + errText(err));
      }
    } finally {
      setGenerating(false);
    }
  };

  /**
   * 批量补挂（幂等）：给所有还没有纠偏清单的诉求生成待办。
   * 结果必须照实播报——uncoveredComplaints 不为 0 或 errors 非空就是没补全，
   * 这时用 warning 而不是 success，避免"点了按钮=办完了"的错觉。
   */
  const doBatchGenerate = async () => {
    setBatching(true);
    try {
      const res = await generateCorrectionBatch();
      const detail =
        '新建 ' + res.createdComplaints + ' 条诉求 / 跳过已有 ' + res.skippedComplaints +
        ' 条 / 插入 ' + res.itemsInserted + ' 项；库内存活诉求 ' + res.totalComplaints +
        ' 条，仍无清单 ' + res.uncoveredComplaints + ' 条';
      if (res.uncoveredComplaints > 0 || res.errors.length > 0) {
        message.warning('补挂未全部完成：' + detail, 8);
      } else {
        message.success('补挂完成，全部诉求已纳入纠偏口径：' + detail, 6);
      }
      await loadQueue(page, size, dispatched);
    } catch (err) {
      message.error('批量补挂失败：' + errText(err));
    } finally {
      setBatching(false);
    }
  };

  const submitConfirm = async () => {
    if (!confirmTarget) return;
    try {
      const values = await confirmForm.validateFields();
      setSubmitting(true);
      const res = await confirmCorrection(confirmTarget.correctionId, {
        newValue: values.newValue === undefined ? undefined : String(values.newValue),
        basis: values.basis === undefined ? undefined : String(values.basis),
      });
      setConfirmTarget(null);
      confirmForm.resetFields();
      await afterDecision(confirmTarget.complaintId, res && res.analysisEntered === true);
    } catch (err) {
      if ((err as { errorFields?: unknown })?.errorFields) return; // 表单校验失败，已就地提示
      message.error('确认失败：' + errText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    try {
      const values = await rejectForm.validateFields();
      setSubmitting(true);
      const res = await rejectCorrection(rejectTarget.correctionId, {
        basis: values.basis === undefined ? undefined : String(values.basis),
      });
      setRejectTarget(null);
      rejectForm.resetFields();
      await afterDecision(rejectTarget.complaintId, res && res.analysisEntered === true);
    } catch (err) {
      if ((err as { errorFields?: unknown })?.errorFields) return;
      message.error('提交失败：' + errText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const pendingCount = items.filter((x) => x.status === 'pending').length;
  /**
   * 该诉求在**交办轴**上的状态：取自服务端给的 hasDispatch，一条诉求的各行取值相同。
   * 面板还没加载到任何项时为 null——这时候就是不知道，不能猜成"未交办"。
   */
  const selectedHasDispatch = items.length > 0 ? items[0].hasDispatch : null;

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>纠偏待办</h2>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="纠偏是数据质量轴，覆盖所有诉求；与交办轴并行"
        description={
          <>
            任何诉求都会逐字段生成纠偏项（企业名称/归属、地址、分类、坐标、摘要、企业处置结果），
            <b>与是否交办、是否审批通过无关</b>；列表里的「已交办 / 未交办」只是标出这条件在另一条轴上的状态。
            <br />
            责任单位现在<b>只在这里确认</b>（总账的「匹配单位」按钮已下线）：取值从企业主数据里选，
            后端成对写回 enterprise_code + enterprise_name，编码未登记会被拒绝。
            <br />
            纠偏全部确认或判定无需后，该诉求才满足进入分析库的前置条件之一；分析库口径未变——
            未交办、误报归库的件仍不纳入分析。无法确认的请留在待纠偏，不要勉强确认。
          </>
        }
      />

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Segmented
            options={DISPATCHED_OPTIONS}
            value={dispatched}
            onChange={(v) => applyDispatchedFilter(v as DispatchedFilter | 'all')}
          />
          <Input
            placeholder="诉求编号或 ID（用于补生成纠偏项）"
            value={genId}
            onChange={(e) => setGenId(e.target.value)}
            style={{ width: 300 }}
            allowClear
          />
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={generating}
            onClick={() => void doGenerate()}
          >
            生成纠偏待办
          </Button>
          <Tooltip title="幂等：只给「还没有任何纠偏项」的诉求补挂清单，已有清单的诉求不受影响。存量与新入站都靠它收敛进纠偏口径。">
            <Button icon={<TeamOutlined />} loading={batching} onClick={() => void doBatchGenerate()}>
              补齐全部诉求纠偏待办
            </Button>
          </Tooltip>
          <Tooltip title="重新加载待纠偏队列">
            <Button icon={<ReloadOutlined />} onClick={() => void loadQueue(page, size, dispatched)}>
              刷新
            </Button>
          </Tooltip>
        </Space>
      </Card>

      <Row gutter={16}>
        <Col span={13}>
          <Card title={'待纠偏项（共 ' + queueTotal + ' 项）'} size="small">
            {loadError ? (
              <Result
                status="error"
                title="加载待纠偏队列失败"
                subTitle={loadError}
                extra={
                  <Button type="primary" onClick={() => void loadQueue(page, size, dispatched)}>
                    重试
                  </Button>
                }
              />
            ) : (
              <Table<CorrectionItem>
                rowKey="correctionId"
                size="middle"
                loading={loading}
                dataSource={queue}
                locale={{
                  emptyText: firstLoaded ? (
                    <Empty description="该口径下暂无待纠偏项；若有诉求从未生成清单，请点「补齐全部诉求纠偏待办」">
                      <Button icon={<TeamOutlined />} loading={batching} onClick={() => void doBatchGenerate()}>
                        补齐全部诉求纠偏待办
                      </Button>
                    </Empty>
                  ) : (
                    <span />
                  ),
                }}
                rowClassName={(r) => (r.complaintId === selectedComplaintId ? 'ant-table-row-selected' : '')}
                onRow={(record) => ({ onClick: () => selectComplaint(record.complaintId) })}
                pagination={{
                  current: page,
                  pageSize: size,
                  total: queueTotal,
                  showSizeChanger: true,
                  showTotal: (t) => '共 ' + t + ' 项',
                  onChange: (p, s) => {
                    setPage(p);
                    setSize(s);
                  },
                }}
                columns={[
                  { title: '诉求', dataIndex: 'complaintId', width: 175, ellipsis: true },
                  {
                    // 两条轴并行的交叉状态：交办与否不影响这条件不该进纠偏队列
                    title: '交办',
                    dataIndex: 'hasDispatch',
                    width: 78,
                    render: (v: boolean) =>
                      v ? <Tag color="processing">已交办</Tag> : <Tag>未交办</Tag>,
                  },
                  {
                    title: '字段',
                    dataIndex: 'fieldLabel',
                    width: 110,
                    render: (v: string | null, r: CorrectionItem) => v ?? r.fieldName,
                  },
                  {
                    title: '旧值',
                    dataIndex: 'oldValue',
                    ellipsis: true,
                    render: (v: string | null) => (v === null || v === '' ? DASH : v),
                  },
                  {
                    title: '建议新值',
                    dataIndex: 'newValue',
                    ellipsis: true,
                    render: (v: string | null) => (v === null || v === '' ? DASH : v),
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 92,
                    render: (v: string, r: CorrectionItem) => {
                      const m = STATUS_TAG[v] ?? { color: 'default', text: r.statusName };
                      return <Tag color={m.color}>{r.statusName || m.text}</Tag>;
                    },
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        <Col span={11}>
          <Card
            title={selectedComplaintId ? '纠偏闭环 · ' + selectedComplaintId : '纠偏闭环'}
            size="small"
            extra={
              selectedComplaintId ? (
                <Button size="small" onClick={() => void loadItems(selectedComplaintId)}>
                  刷新
                </Button>
              ) : null
            }
          >
            {!selectedComplaintId ? (
              <Empty description="请从左侧选择一条待纠偏项，查看该诉求的全部纠偏项" />
            ) : itemsError ? (
              <Result
                status="error"
                title="加载纠偏项失败"
                subTitle={itemsError}
                extra={
                  <Button type="primary" onClick={() => void loadItems(selectedComplaintId)}>
                    重试
                  </Button>
                }
              />
            ) : (
              <>
                <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
                  <Descriptions.Item label="诉求">{selectedComplaintId}</Descriptions.Item>
                  <Descriptions.Item label="交办轴">
                    {selectedHasDispatch === null ? (
                      DASH
                    ) : selectedHasDispatch ? (
                      <Tag color="processing">已交办</Tag>
                    ) : (
                      <Tag>未交办</Tag>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="待确认项">{pendingCount}</Descriptions.Item>
                  <Descriptions.Item label="全部项">{items.length}</Descriptions.Item>
                </Descriptions>

                {pendingCount === 0 && items.length > 0 && (
                  <Alert
                    type="success"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="该诉求纠偏已全部闭环"
                    description={
                      selectedHasDispatch
                        ? '全部纠偏项已确认或判定无需，且该诉求走过督办链路——满足进入分析库的条件。'
                        : '全部纠偏项已确认或判定无需；但该诉求没有交办记录，按现行分析库口径仍不纳入分析（只在总账可查）。'
                    }
                  />
                )}

                <Table<CorrectionItem>
                  rowKey="correctionId"
                  size="small"
                  loading={itemsLoading}
                  dataSource={items}
                  pagination={false}
                  locale={{ emptyText: <Empty description="该诉求暂无纠偏项" /> }}
                  columns={[
                    {
                      title: '字段',
                      dataIndex: 'fieldLabel',
                      width: 96,
                      render: (v: string | null, r: CorrectionItem) => v ?? r.fieldName,
                    },
                    {
                      title: '旧值 → 新值',
                      width: 200,
                      render: (_: unknown, r: CorrectionItem) => (
                        <div style={{ lineHeight: 1.6 }}>
                          <div style={{ color: '#8c8c8c' }}>{r.oldValue ?? '—'}</div>
                          <div>{r.newValue ?? '—'}</div>
                        </div>
                      ),
                    },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 92,
                      render: (v: string, r: CorrectionItem) => {
                        const m = STATUS_TAG[v] ?? { color: 'default', text: r.statusName };
                        return (
                          <Space direction="vertical" size={0}>
                            <Tag color={m.color}>{r.statusName || m.text}</Tag>
                            {r.confirmerName && (
                              <span style={{ fontSize: 12, color: '#8c8c8c' }}>{r.confirmerName}</span>
                            )}
                          </Space>
                        );
                      },
                    },
                    {
                      title: '操作',
                      width: 150,
                      render: (_: unknown, r: CorrectionItem) =>
                        r.status === 'pending' ? (
                          <Space size={0}>
                            <Button
                              type="link"
                              size="small"
                              icon={<CheckOutlined />}
                              onClick={() => {
                                setConfirmTarget(r);
                                confirmForm.setFieldsValue({
                                  // 责任单位：确认值是主数据编码，只能重选，不能拿旧名称回显（旧值是名称，会直接被判为未登记）
                                  newValue:
                                    r.fieldName === ENTERPRISE_FIELD
                                      ? ''
                                      : r.newValue ?? r.oldValue ?? '',
                                  basis: r.basis ?? '',
                                });
                              }}
                            >
                              确认
                            </Button>
                            <Button
                              type="link"
                              size="small"
                              icon={<StopOutlined />}
                              onClick={() => {
                                setRejectTarget(r);
                                rejectForm.setFieldsValue({ basis: r.basis ?? '' });
                              }}
                            >
                              无需纠偏
                            </Button>
                          </Space>
                        ) : (
                          <span style={{ color: '#8c8c8c' }}>
                            {r.confirmedAt ? new Date(r.confirmedAt).toLocaleString('zh-CN') : '已处理'}
                          </span>
                        ),
                    },
                  ]}
                />
              </>
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        title={confirmTarget ? '确认纠偏 · ' + (confirmTarget.fieldLabel ?? confirmTarget.fieldName) : '确认纠偏'}
        open={!!confirmTarget}
        onCancel={() => {
          setConfirmTarget(null);
          confirmForm.resetFields();
        }}
        onOk={() => void submitConfirm()}
        confirmLoading={submitting}
        okText="确认"
        width={560}
        destroyOnClose
      >
        {confirmTarget && (
          <>
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="诉求">{confirmTarget.complaintId}</Descriptions.Item>
              <Descriptions.Item label="原值">{confirmTarget.oldValue ?? '—'}</Descriptions.Item>
            </Descriptions>
            {confirmTarget.fieldName === ENTERPRISE_FIELD && enterpriseError ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={'企业主数据加载失败：' + enterpriseError}
                description="责任单位下拉将为空，不会被本地示例企业替代；此时无法确认责任单位，请先重试。"
                action={
                  <Button size="small" onClick={() => void fetchEnterprises()}>
                    重试
                  </Button>
                }
              />
            ) : null}
            <Form form={confirmForm} layout="vertical">
              <Form.Item
                name="newValue"
                label={
                  confirmTarget.fieldName === ENTERPRISE_FIELD
                    ? '责任单位（企业主数据登记值，编码 + 名称成对写回）'
                    : '纠偏后取值'
                }
                rules={
                  confirmTarget.fieldName === ENTERPRISE_FIELD
                    ? [{ required: true, message: '请从企业主数据里选择责任单位' }]
                    : NUMERIC_FIELDS.has(confirmTarget.fieldName)
                    ? [
                        { required: true, message: '请填写纠偏后的取值' },
                        {
                          pattern: /^-?\d+(\.\d+)?$/,
                          message: '该字段是数值（经纬度），请填写数字，例如 111.2860',
                        },
                      ]
                    : [{ required: true, message: '请填写纠偏后的取值' }]
                }
                extra={
                  confirmTarget.fieldName === ENTERPRISE_FIELD ? (
                    <>
                      当前登记名称：{confirmTarget.oldValue ?? '（空）'}。
                      这里选的是 <b>enterprise_code</b>，后端会回查 enterprise 表并成对写回
                      enterprise_code + enterprise_name；编码未登记会被拒绝，不会静默写入。
                    </>
                  ) : undefined
                }
              >
                {confirmTarget.fieldName === ENTERPRISE_FIELD ? (
                  <Select
                    showSearch
                    allowClear
                    filterOption={false}
                    loading={enterpriseLoading}
                    placeholder="输入企业名称或编码搜索（只能从主数据里选）"
                    onSearch={(kw) => void fetchEnterprises(kw)}
                    onOpenChange={(open) => {
                      if (open && enterpriseOptions.length === 0 && !enterpriseLoading) {
                        void fetchEnterprises();
                      }
                    }}
                    options={enterpriseOptions.map((e) => ({
                      value: e.enterpriseCode,
                      label:
                        e.enterpriseName +
                        '（' + e.enterpriseCode + '）' +
                        (e.businessTypeName ? ' · ' + e.businessTypeName : ''),
                    }))}
                  />
                ) : (
                  <Input
                    placeholder={
                      NUMERIC_FIELDS.has(confirmTarget.fieldName)
                        ? '请输入数字，例如 111.2860'
                        : '请输入核实后的取值'
                    }
                  />
                )}
              </Form.Item>
              <Form.Item name="basis" label="确认依据">
                <Input.TextArea rows={3} placeholder="例如：电话核实、现场照片、来源系统回执编号" />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>

      <Modal
        title="判定无需纠偏"
        open={!!rejectTarget}
        onCancel={() => {
          setRejectTarget(null);
          rejectForm.resetFields();
        }}
        onOk={() => void submitReject()}
        confirmLoading={submitting}
        okText="提交"
        width={520}
        destroyOnClose
      >
        {rejectTarget && (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="确认这不是「跳过」"
              description="「无需纠偏」表示经核对自动生成的建议不成立，该判定会连同依据一并留痕。"
            />
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="诉求">{rejectTarget.complaintId}</Descriptions.Item>
              <Descriptions.Item label="字段">
                {rejectTarget.fieldLabel ?? rejectTarget.fieldName}
              </Descriptions.Item>
              <Descriptions.Item label="建议新值">{rejectTarget.newValue ?? '—'}</Descriptions.Item>
            </Descriptions>
            <Form form={rejectForm} layout="vertical">
              <Form.Item name="basis" label="判定依据">
                <Input.TextArea rows={3} placeholder="例如：与来源系统原始报文一致，无需调整" />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>
    </div>
  );
};

export default AddressCorrection;
