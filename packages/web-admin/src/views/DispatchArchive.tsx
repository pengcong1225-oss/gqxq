import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Modal,
  Result,
  Space,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import { EyeOutlined, InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { getDispatchOrder, listDispatchOrders } from '../api/dispatch';
import { archiveDispatch } from '../api/archive';
import type { DispatchOrderDetail, DispatchOrderListItem } from '../types/api';

/**
 * 交办归档（真实接口驱动）。
 *
 * 口径：
 *  - 已归档列表 = 查 dispatch_order 里 status='archived' 的真实记录（复用 GET /dispatch/orders）。
 *  - 「已完成但未归档」的交办可在此归档；归档前置条件由后端校验：
 *      1) 交办已完成（填报审批最终通过）；
 *      2) 该诉求**没有未确认的纠偏项**。
 *    第 2 条被拒会返回 409，页面必须给出**明确原因 + 纠偏入口**，不能显示成泛化错误。
 */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | number | undefined {
  return (e as { code?: string | number } | null)?.code;
}

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

function fmt(iso: string | null): React.ReactNode {
  return iso ? new Date(iso).toLocaleString('zh-CN') : DASH;
}

interface BlockedInfo {
  assignmentId: string;
  message: string;
}

const DispatchArchive: React.FC = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'completed' | 'archived'>('completed');

  const [rows, setRows] = useState<DispatchOrderListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const seqRef = useRef(0);

  const [detail, setDetail] = useState<DispatchOrderDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [blocked, setBlocked] = useState<BlockedInfo | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);

  const load = useCallback(async (status: 'completed' | 'archived', p: number, s: number) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listDispatchOrders({ status, page: p, size: s });
      if (seq !== seqRef.current) return;
      setRows(res.content);
      setTotal(res.total);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setLoadError(errText(err));
      setRows([]);
      setTotal(0);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setFirstLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    void load(tab, page, size);
  }, [load, tab, page, size]);

  const openDetail = async (assignmentId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    try {
      const d = await getDispatchOrder(assignmentId);
      setDetail(d);
    } catch (err) {
      setDetailError(errText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const doArchive = async (row: DispatchOrderListItem) => {
    setArchiving(row.assignmentId);
    try {
      await archiveDispatch(row.assignmentId);
      message.success('已归档：' + row.orderNo);
      await load(tab, page, size);
    } catch (err) {
      const code = errCode(err);
      if (code === 409 || code === 'INVALID_STATE_TRANSITION') {
        // 409 的两种可能：交办未完成，或该诉求仍有未确认的纠偏项。
        // 后者按规格必须给出去纠偏的入口，所以这里用专门的弹窗而不是 toast。
        setBlocked({ assignmentId: row.assignmentId, message: errText(err) });
      } else if (code === 404 || code === 'NOT_FOUND') {
        message.error('交办不存在：' + errText(err));
      } else {
        message.error('归档失败：' + errText(err));
      }
    } finally {
      setArchiving(null);
    }
  };

  const columns: Array<Record<string, unknown>> = [
    { title: '交办单号', dataIndex: 'orderNo', width: 155 },
    {
      title: '诉求',
      width: 300,
      render: (_: unknown, r: DispatchOrderListItem) => (
        <Space direction="vertical" size={0}>
          <span>{r.complaintNo ?? r.complaintId}</span>
          <span style={{ fontSize: 12, color: '#8c8c8c' }}>{r.complaintTitle ?? ''}</span>
        </Space>
      ),
    },
    {
      title: '目标企业',
      dataIndex: 'targetEnterpriseName',
      width: 190,
      ellipsis: true,
      render: (v: string | null) => v ?? DASH,
    },
    {
      title: '状态',
      dataIndex: 'statusName',
      width: 110,
      render: (v: string, r: DispatchOrderListItem) => (
        <Tag color={r.status === 'archived' ? 'default' : r.status === 'completed' ? 'success' : 'processing'}>
          {v || r.status}
        </Tag>
      ),
    },
    {
      title: '填报任务号',
      dataIndex: 'reportingTaskId',
      width: 120,
      render: (v: string | null) => v ?? DASH,
    },
    { title: '最近更新', dataIndex: 'updatedAt', width: 165, render: (v: string | null) => fmt(v) },
    {
      title: '操作',
      width: 150,
      fixed: 'right' as const,
      render: (_: unknown, r: DispatchOrderListItem) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => void openDetail(r.assignmentId)}>
            详情
          </Button>
          {tab === 'completed' && (
            <Button
              type="link"
              size="small"
              icon={<InboxOutlined />}
              loading={archiving === r.assignmentId}
              onClick={() => void doArchive(r)}
            >
              归档
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const tableNode = loadError ? (
    <Result
      status="error"
      title="加载交办列表失败"
      subTitle={loadError}
      extra={
        <Button type="primary" onClick={() => void load(tab, page, size)}>
          重试
        </Button>
      }
    />
  ) : (
    <Table<DispatchOrderListItem>
      rowKey="assignmentId"
      size="middle"
      loading={loading}
      dataSource={rows}
      scroll={{ x: 1160 }}
      locale={{
        emptyText: firstLoaded ? (
          <Empty description={tab === 'completed' ? '暂无已完成待归档的交办' : '暂无已归档交办'} />
        ) : (
          <span />
        ),
      }}
      pagination={{
        current: page,
        pageSize: size,
        total,
        showSizeChanger: true,
        showTotal: (t) => '共 ' + t + ' 条',
        onChange: (p, s) => {
          setPage(p);
          setSize(s);
        },
      }}
      columns={columns as never}
    />
  );

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>交办归档</h2>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="归档前置条件"
        description="交办需已完成（填报审批最终通过），且该诉求没有未确认的纠偏项。若被拒，页面会给出具体原因与纠偏入口。归档是写 dispatch_order 的状态与归档时间并留审计，不会删除历史记录。"
      />

      <Card>
        <Tabs
          activeKey={tab}
          onChange={(k) => {
            setTab(k as 'completed' | 'archived');
            setPage(1);
          }}
          tabBarExtraContent={
            <Button icon={<ReloadOutlined />} onClick={() => void load(tab, page, size)}>
              刷新
            </Button>
          }
          items={[
            { key: 'completed', label: '已完成待归档', children: tableNode },
            { key: 'archived', label: '已归档', children: tableNode },
          ]}
        />
      </Card>

      <Drawer
        title={detail ? '归档详情 · ' + detail.orderNo : '归档详情'}
        open={!!detail || !!detailError}
        onClose={() => {
          setDetail(null);
          setDetailError(null);
        }}
        width={560}
      >
        {detailLoading && <Empty description="加载中…" />}
        {detailError && (
          <Result status="error" title="加载详情失败" subTitle={detailError} />
        )}
        {detail && (
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="交办单号">{detail.orderNo}</Descriptions.Item>
            <Descriptions.Item label="诉求">
              {detail.complaintNo ?? detail.complaintId}
              {detail.complaintTitle ? ' · ' + detail.complaintTitle : ''}
            </Descriptions.Item>
            <Descriptions.Item label="目标企业">
              {detail.targetEnterpriseName ?? DASH}
              {detail.targetEnterpriseCode ? '（' + detail.targetEnterpriseCode + '）' : ''}
            </Descriptions.Item>
            <Descriptions.Item label="交办状态">
              <Tag>{detail.statusName || detail.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="触发类型">{detail.triggerTypeName || DASH}</Descriptions.Item>
            <Descriptions.Item label="交办要求">{detail.requirement ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="填报任务号">{detail.reportingTaskId ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="推送时间">{fmt(detail.pushedAt)}</Descriptions.Item>
            <Descriptions.Item label="完成时间">{fmt(detail.completedAt)}</Descriptions.Item>
            <Descriptions.Item label="归档时间">{fmt(detail.archivedAt)}</Descriptions.Item>
            <Descriptions.Item label="处理结果">{detail.resultContent ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{fmt(detail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="最近更新">{fmt(detail.updatedAt)}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>

      <Modal
        title="归档被拒"
        open={!!blocked}
        onCancel={() => setBlocked(null)}
        footer={[
          <Button key="close" onClick={() => setBlocked(null)}>
            知道了
          </Button>,
          <Button
            key="go"
            type="primary"
            onClick={() => {
              setBlocked(null);
              navigate('/address-correction');
            }}
          >
            前往纠偏待办
          </Button>,
        ]}
        width={520}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="该交办当前不满足归档条件"
          description="常见原因：交办尚未完成（填报审批未最终通过），或该诉求仍有未确认的纠偏项。请按下面后端返回的原文处理后重试。"
        />
        <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, wordBreak: 'break-all' }}>
          {blocked?.message}
        </div>
      </Modal>
    </div>
  );
};

export default DispatchArchive;
