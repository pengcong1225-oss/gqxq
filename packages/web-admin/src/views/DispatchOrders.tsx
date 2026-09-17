import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cancelDispatch, getDispatchOrder, listDispatchOrders } from '../api/dispatch';
import { getDictItems } from '../api/dicts';
import type {
  ApiError,
  DictItem,
  DispatchOrderDetail,
  DispatchOrderListItem,
  DispatchOrderParams,
  DispatchOrderStatus,
  Paged,
} from '../types/api';

/**
 * 敏感交办（真实接口驱动）。
 *
 * 设计纪律：
 *  - 删除页面内本地 25 条 Mock 交办数组与所有假成功提示。
 *  - 列表来自 GET /dispatch/orders 真查表，不是按敏感诉求现场生成。
 *  - 推送 / 重推 / 同步 / 归档属 G3/G4/G5：disabled + Tooltip 说明批次，不弹假成功。
 *  - **不提供第二次新建交办**：交办一律在诉求总账发起（设计文档第 2 节）。
 */

/** 仅用于 Tag 配色；文案一律取服务端 statusName。 */
const STATUS_COLOR: Record<string, string> = {
  pending: 'processing',
  pushed: 'processing',
  accepted: 'processing',
  processing: 'processing',
  returned: 'warning',
  completed: 'success',
  rejected: 'error',
  archived: 'default',
  cancelled: 'default',
};

/** 交办单可能出现的状态全集（用于筛选下拉，顺序即业务流程顺序） */
const DISPATCH_STATUSES: DispatchOrderStatus[] = [
  'pending',
  'pushed',
  'accepted',
  'processing',
  'returned',
  'completed',
  'rejected',
  'archived',
  'cancelled',
];

/** 终态：不可再撤销（与后端状态机一致） */
const TERMINAL_DISPATCH_STATUSES = new Set<string>([
  'completed',
  'rejected',
  'archived',
  'cancelled',
]);

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

function fmtDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '—';
}

function fmtDateOnly(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('zh-CN') : '—';
}

const DispatchOrders: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<DispatchOrderStatus[] | undefined>();
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState<string | undefined>();

  const [data, setData] = useState<Paged<DispatchOrderListItem> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /** 请求序号：快速切换筛选时丢弃过期响应，避免旧结果覆盖新结果 */
  const seqRef = useRef(0);

  /** 状态筛选下拉的文案来自服务端字典（supervision_status），前端不建翻译表 */
  const [statusDict, setStatusDict] = useState<DictItem[]>([]);
  const [dictError, setDictError] = useState<string | null>(null);

  /* ---------- 详情 ---------- */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DispatchOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* ---------- 受控撤销 ---------- */
  const [cancelTarget, setCancelTarget] = useState<DispatchOrderListItem | null>(null);
  const [cancelForm] = Form.useForm<{ reason: string }>();
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let alive = true;
    setDictError(null);
    getDictItems('supervision_status')
      .then((items) => {
        if (alive) setStatusDict(items);
      })
      .catch((err: ApiError) => {
        if (alive) setDictError(err?.message ?? '字典加载失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  const params = useMemo<DispatchOrderParams>(
    () => ({ page, size, keyword, status: statusFilter }),
    [page, size, keyword, statusFilter]
  );

  const load = useCallback(async (p: DispatchOrderParams) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listDispatchOrders(p);
      if (seq !== seqRef.current) return;
      setData(res);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err as ApiError);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(params);
  }, [params, load]);

  /* ---------- 详情：打开时按 assignmentId 拉真实记录 ---------- */
  const openDetail = useCallback(async (assignmentId: string) => {
    setDetailId(assignmentId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const d = await getDispatchOrder(assignmentId);
      setDetail(d);
    } catch (err) {
      setDetailError((err as ApiError)?.message ?? '交办详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
    if (searchParams.get('assignmentId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('assignmentId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  /** 从总账「查看交办」跳过来时带 ?assignmentId=xxx，自动打开详情 */
  const assignmentFromUrl = searchParams.get('assignmentId');
  useEffect(() => {
    if (assignmentFromUrl && assignmentFromUrl !== detailId) {
      void openDetail(assignmentFromUrl);
    }
  }, [assignmentFromUrl, detailId, openDetail]);

  const handleCancel = useCallback(async () => {
    if (!cancelTarget) return;
    let values: { reason: string };
    try {
      values = await cancelForm.validateFields();
    } catch {
      return;
    }
    setCancelling(true);
    const target = cancelTarget;
    try {
      // 忽略响应体：撤销后一律以重新拉取为准（后端未冻结 cancel 的响应形状）
      await cancelDispatch(target.assignmentId, values.reason.trim());
      message.success('已撤销交办 ' + target.orderNo);
      setCancelTarget(null);
      cancelForm.resetFields();
      if (detailId === target.assignmentId) void openDetail(target.assignmentId);
      void load(params);
    } catch (err) {
      message.error('撤销失败：' + ((err as ApiError)?.message ?? '未知错误'));
    } finally {
      setCancelling(false);
    }
  }, [cancelTarget, cancelForm, detailId, openDetail, load, params]);

  const statusFilterOptions = useMemo(
    () =>
      DISPATCH_STATUSES.map((code) => {
        const hit = statusDict.find((d) => d.value === code);
        // 字典缺项时回退显示状态码本身，不编造中文
        return { value: code, label: hit ? hit.label : code };
      }),
    [statusDict]
  );

  const columns: ColumnsType<DispatchOrderListItem> = useMemo(
    () => [
      {
        title: '交办单号',
        dataIndex: 'orderNo',
        width: 160,
        fixed: 'left',
        render: (v: string, r) => <a onClick={() => void openDetail(r.assignmentId)}>{v}</a>,
      },
      {
        title: '诉求编号',
        dataIndex: 'complaintNo',
        width: 160,
        render: (v: string | null, r) =>
          v ? <a onClick={() => navigate('/complaints/' + r.complaintId)}>{v}</a> : DASH,
      },
      {
        title: '诉求标题',
        dataIndex: 'complaintTitle',
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '目标企业',
        dataIndex: 'targetEnterpriseName',
        width: 170,
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '交办方式',
        dataIndex: 'dispatchType',
        width: 100,
        // 契约里没有 dispatchTypeName / triggerTypeName，这里如实显示状态码，不编造中文
        render: (v: string | null) => (v ? <Tag color={v === 'auto' ? 'blue' : 'purple'}>{v}</Tag> : DASH),
      },
      {
        title: '触发类型',
        dataIndex: 'triggerType',
        width: 120,
        render: (v: string | null) => (v ? <Tag>{v}</Tag> : DASH),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 120,
        render: (_: unknown, r) => (
          <Tag color={STATUS_COLOR[r.status] ?? 'default'}>{r.statusName}</Tag>
        ),
      },
      {
        title: '截止时间',
        dataIndex: 'deadline',
        width: 150,
        render: (v: string | null) => fmtDateTime(v),
      },
      {
        title: '创建时间',
        dataIndex: 'createdAt',
        width: 150,
        render: (v: string | null) => fmtDateTime(v),
      },
      {
        title: '请求号',
        dataIndex: 'requestId',
        width: 170,
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '填报任务号',
        dataIndex: 'reportingTaskId',
        width: 150,
        ellipsis: true,
        render: (v: string | null) =>
          v ? (
            <Tooltip title={v}>{v}</Tooltip>
          ) : (
            <Tooltip title="填报任务号由批次 G3 推送成功后回填">
              <span style={{ color: '#bfbfbf' }}>—</span>
            </Tooltip>
          ),
      },
      {
        title: '操作',
        width: 240,
        fixed: 'right',
        render: (_: unknown, r) => {
          const terminal = TERMINAL_DISPATCH_STATUSES.has(r.status);
          return (
            <Space size={4} wrap>
              <Button
                type="link"
                size="small"
                icon={<EyeOutlined />}
                onClick={() => void openDetail(r.assignmentId)}
              >
                详情
              </Button>
              <Tooltip title="功能未实现（批次 G3）">
                <span>
                  <Button type="link" size="small" disabled>
                    推送
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title="功能未实现（批次 G4）">
                <span>
                  <Button type="link" size="small" disabled>
                    同步
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title="功能未实现（批次 G5）">
                <span>
                  <Button type="link" size="small" disabled>
                    归档
                  </Button>
                </span>
              </Tooltip>
              {terminal ? (
                <Tooltip title={'已是终态（' + r.statusName + '），不可撤销'}>
                  <span>
                    <Button type="link" size="small" danger disabled icon={<StopOutlined />}>
                      撤销
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  onClick={() => {
                    cancelForm.resetFields();
                    setCancelTarget(r);
                  }}
                >
                  撤销
                </Button>
              )}
            </Space>
          );
        },
      },
    ],
    [navigate, openDetail, cancelForm]
  );

  const firstLoading = loading && data === null;

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>敏感诉求交办</h2>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="交办一律在诉求总账发起"
        description="本页只展示已产生的交办记录及其进度，不提供第二次新建交办（设计文档第 2 节：进入敏感交办表示已完成交办决定）。如需交办，请到「诉求管理」对目标诉求操作。"
      />

      {dictError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={'状态字典加载失败：' + dictError}
          description="状态筛选下拉的文案来自服务端字典；加载失败时下拉回退显示状态码本身，表格数据不受影响。"
        />
      )}

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input.Search
            placeholder="搜索交办单号/诉求编号/标题"
            prefix={<SearchOutlined />}
            value={keywordInput}
            allowClear
            style={{ width: 280 }}
            onChange={(e) => {
              setKeywordInput(e.target.value);
              if (e.target.value === '') {
                setKeyword(undefined);
                setPage(1);
              }
            }}
            onSearch={(v) => {
              setKeyword(v.trim() === '' ? undefined : v.trim());
              setPage(1);
            }}
          />
          <Select
            mode="multiple"
            placeholder="状态（可多选）"
            allowClear
            style={{ minWidth: 260 }}
            options={statusFilterOptions}
            value={statusFilter}
            onChange={(v: DispatchOrderStatus[]) => {
              setStatusFilter(v && v.length > 0 ? v : undefined);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(params)} loading={loading}>
            刷新
          </Button>
        </Space>

        {error ? (
          <Result
            status="error"
            title="交办列表加载失败"
            subTitle={error.message}
            extra={
              <Space>
                <Button type="primary" onClick={() => void load(params)}>
                  重试
                </Button>
                <Button onClick={() => navigate('/complaints')}>去诉求管理</Button>
              </Space>
            }
          />
        ) : (
          <Table<DispatchOrderListItem>
            rowKey="assignmentId"
            columns={columns}
            dataSource={data?.content ?? []}
            loading={loading}
            size="middle"
            scroll={{ x: 1900 }}
            locale={{
              emptyText: firstLoading ? <span /> : <Empty description="暂无交办记录" />,
            }}
            pagination={{
              current: page,
              pageSize: size,
              total: data?.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => '共 ' + total + ' 条交办单',
              onChange: (nextPage, nextSize) => {
                if (nextSize !== size) {
                  setSize(nextSize);
                  setPage(1);
                } else {
                  setPage(nextPage);
                }
              },
            }}
          />
        )}
      </Card>

      {/* ---------- 详情 ---------- */}
      <Modal
        title={detail ? '交办详情 - ' + detail.orderNo : '交办详情'}
        open={detailId !== null}
        onCancel={closeDetail}
        footer={
          <Space>
            <Button onClick={closeDetail}>关闭</Button>
            <Button onClick={() => navigate('/complaints/' + (detail ? detail.complaintId : ''))} disabled={!detail}>
              查看关联诉求
            </Button>
          </Space>
        }
        width={720}
      >
        {detailLoading && <Typography.Text type="secondary">加载中…</Typography.Text>}

        {!detailLoading && detailError && (
          <Alert
            type="error"
            showIcon
            message="交办详情加载失败"
            description={detailError}
            action={
              <Button size="small" onClick={() => detailId && void openDetail(detailId)}>
                重试
              </Button>
            }
          />
        )}

        {!detailLoading && !detailError && detail && (
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="交办单号">{detail.orderNo}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_COLOR[detail.status] ?? 'default'}>{detail.statusName}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="诉求编号">
              {detail.complaintNo ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="诉求标题">
              {detail.complaintTitle ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="目标企业">
              {detail.targetEnterpriseName ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="企业编码">
              {detail.targetEnterpriseCode ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="交办方式">{detail.dispatchType ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="触发类型">{detail.triggerType ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="敏感词" span={2}>
              {detail.sensitiveWords.length > 0
                ? detail.sensitiveWords.map((w) => (
                    <Tag color="red" key={w}>
                      {w}
                    </Tag>
                  ))
                : DASH}
            </Descriptions.Item>
            <Descriptions.Item label="交办原因">{detail.reason ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="截止时间">{fmtDateTime(detail.deadline)}</Descriptions.Item>
            <Descriptions.Item label="交办要求" span={2}>
              {detail.requirement ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="请求号" span={2}>
              {detail.requestId ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="填报任务号">
              {detail.reportingTaskId ?? (
                <Tooltip title="填报任务号由批次 G3 推送成功后回填">
                  <span style={{ color: '#bfbfbf' }}>—</span>
                </Tooltip>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="填报状态">
              {detail.externalStatus ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="推送状态">{detail.syncStatus ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="推送时间">{fmtDateTime(detail.pushedAt)}</Descriptions.Item>
            <Descriptions.Item label="完成时间">{fmtDateTime(detail.completedAt)}</Descriptions.Item>
            <Descriptions.Item label="归档时间">{fmtDateTime(detail.archivedAt)}</Descriptions.Item>
            <Descriptions.Item label="模板">
              {detail.templateCode
                ? detail.templateCode + (detail.templateVersion != null ? ' v' + detail.templateVersion : '')
                : DASH}
            </Descriptions.Item>
            <Descriptions.Item label="审批定义">
              {detail.approvalDefinitionCode
                ? detail.approvalDefinitionCode +
                  (detail.approvalDefinitionVersion != null
                    ? ' v' + detail.approvalDefinitionVersion
                    : '')
                : DASH}
            </Descriptions.Item>
            <Descriptions.Item label="结果内容" span={2}>
              {detail.resultContent ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="撤销时间">{fmtDateTime(detail.cancelledAt)}</Descriptions.Item>
            <Descriptions.Item label="撤销原因">{detail.cancelReason ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="创建人">{detail.createdByName ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{fmtDateTime(detail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="最后更新" span={2}>
              {fmtDateTime(detail.updatedAt)}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>

      {/* ---------- 受控撤销 ---------- */}
      <Modal
        title={cancelTarget ? '受控撤销交办 ' + cancelTarget.orderNo : '受控撤销交办'}
        open={cancelTarget !== null}
        onCancel={() => {
          setCancelTarget(null);
          cancelForm.resetFields();
        }}
        onOk={() => void handleCancel()}
        confirmLoading={cancelling}
        okText="确认撤销"
        okButtonProps={{ danger: true }}
        width={520}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="撤销后不可复活"
          description="该交办会进入终态「已撤销」，且本次操作会写入审计。如需重新交办，请在诉求总账重新发起。"
        />
        <Form form={cancelForm} layout="vertical">
          <Form.Item
            name="reason"
            label="撤销原因"
            rules={[{ required: true, message: '必须填写撤销原因' }]}
          >
            <Input.TextArea rows={3} placeholder="例如：重复交办 / 交办对象有误 / 业主撤回" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default DispatchOrders;
