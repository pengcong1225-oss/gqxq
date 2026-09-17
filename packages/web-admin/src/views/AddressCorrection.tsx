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
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import { CheckOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  confirmCorrection,
  generateCorrections,
  listComplaintCorrections,
  listPendingCorrections,
  rejectCorrection,
} from '../api/corrections';
import type { CorrectionItem } from '../types/api';

/**
 * 纠偏待办（真实接口驱动）。
 *
 * 口径（源自《落地计划》G5 与迁移设计）：
 *  - 纠偏是**最终回传之后**的环节；纠偏闭环完成后该诉求才会进入分析库。
 *  - 纠偏项按字段逐项生成（企业名称/归属、地址、分类、坐标、摘要、企业处置结果）。
 *  - 无法确认的项留在待纠偏，**不假装完成**；判定不成立时可「无需纠偏」并留依据。
 *  - 「无需交办归库」「误报归库」的诉求不纳入纠偏口径（后端不为它们生成纠偏项）。
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

  const loadQueue = useCallback(async (p: number, s: number) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listPendingCorrections({ page: p, size: s });
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
  }, []);

  useEffect(() => {
    void loadQueue(page, size);
  }, [loadQueue, page, size]);

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
      await loadQueue(page, size);
      // 「是否已进入分析库」用**后端返回的判定**（confirm/reject 响应里的 analysisEntered），
      // 不在前端靠"数还有没有 pending 项"来推断——那是猜测，不是事实。
      if (analysisEntered === true) {
        message.success('该项已处置，且该诉求纠偏已全部闭环——已进入分析库（可在「分析库」页查到）');
      } else {
        message.success('已处置该项纠偏');
      }
    },
    [loadItems, loadQueue, page, size]
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
      await loadQueue(page, size);
    } catch (err) {
      const code = errCode(err);
      if (code === 404 || code === 'NOT_FOUND') {
        message.error('未找到该诉求：' + errText(err));
      } else if (code === 409 || code === 'INVALID_STATE_TRANSITION') {
        message.error('该诉求当前状态不允许生成纠偏项：' + errText(err));
      } else {
        message.error('生成失败：' + errText(err));
      }
    } finally {
      setGenerating(false);
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

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>纠偏待办</h2>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="纠偏闭环是进入分析库的前置条件"
        description="最终审批通过后的诉求会逐字段生成纠偏项（企业名称/归属、地址、分类、坐标、摘要、企业处置结果）。全部确认或判定无需纠偏后，该诉求才会进入分析库；无法确认的项请留在待纠偏，不要勉强确认。无需交办/误报归库的诉求不在本口径内。"
      />

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
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
          <Tooltip title="重新加载待纠偏队列">
            <Button icon={<ReloadOutlined />} onClick={() => void loadQueue(page, size)}>
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
                  <Button type="primary" onClick={() => void loadQueue(page, size)}>
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
                locale={{ emptyText: firstLoaded ? <Empty description="暂无待纠偏项" /> : <span /> }}
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
                  <Descriptions.Item label="待确认项">{pendingCount}</Descriptions.Item>
                  <Descriptions.Item label="全部项">{items.length}</Descriptions.Item>
                </Descriptions>

                {pendingCount === 0 && items.length > 0 && (
                  <Alert
                    type="success"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="该诉求纠偏已闭环，已进入分析库"
                    description="全部纠偏项已确认或判定无需，满足进入分析库的前置条件。"
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
                                  newValue: r.newValue ?? r.oldValue ?? '',
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
            <Form form={confirmForm} layout="vertical">
              <Form.Item
                name="newValue"
                label="纠偏后取值"
                rules={
                  NUMERIC_FIELDS.has(confirmTarget.fieldName)
                    ? [
                        { required: true, message: '请填写纠偏后的取值' },
                        {
                          pattern: /^-?\d+(\.\d+)?$/,
                          message: '该字段是数值（经纬度），请填写数字，例如 111.2860',
                        },
                      ]
                    : [{ required: true, message: '请填写纠偏后的取值' }]
                }
              >
                <Input
                  placeholder={
                    NUMERIC_FIELDS.has(confirmTarget.fieldName)
                      ? '请输入数字，例如 111.2860'
                      : '请输入核实后的取值'
                  }
                />
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
