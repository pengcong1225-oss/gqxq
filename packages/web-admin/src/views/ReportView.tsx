import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Result, Select, Space, Table, Tag } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { listReportTodos } from '../api/analysis';
import type { ReportTodoItem, ReportTodoStatus } from '../types/api';

/**
 * 待查报告待办（真实接口驱动）。
 *
 * ⚠️ 口径声明（必须显示在页面上）：
 *   报告**如何形成、是否需要审核与发布**，规则待业务方确认。
 *   本页当前只提供「待查入口」——待办是从分析库（已纠偏闭环的诉求）派生出来的，
 *   不代表报告已经生成。
 */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 契约里的三个状态码（值来自服务端 DTO；中文名优先用服务端返回的 statusName） */
const STATUS_CODES: ReportTodoStatus[] = ['pending', 'in_progress', 'done'];

const STATUS_COLOR: Record<ReportTodoStatus, string> = {
  pending: 'warning',
  in_progress: 'processing',
  done: 'success',
};

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

function fmt(iso: string | null): React.ReactNode {
  return iso ? new Date(iso).toLocaleString('zh-CN') : DASH;
}

const ReportView: React.FC = () => {
  const navigate = useNavigate();

  const [rows, setRows] = useState<ReportTodoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [status, setStatus] = useState<ReportTodoStatus | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const seqRef = useRef(0);

  /**
   * 状态中文名一律取自服务端返回的 statusName，前端不建翻译表。
   * 筛选下拉在没有行可参考时回退显示状态码本身（而不是自造中文）。
   */
  const [observedLabels, setObservedLabels] = useState<Partial<Record<ReportTodoStatus, string>>>({});

  const load = useCallback(
    async (s: ReportTodoStatus | undefined, p: number, n: number) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await listReportTodos({ status: s, page: p, size: n });
        if (seq !== seqRef.current) return;
        setRows(res.content);
        setTotal(res.total);
        setObservedLabels((prev) => {
          const next = { ...prev };
          for (const r of res.content) {
            if (r.statusName) next[r.status] = r.statusName;
          }
          return next;
        });
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
    },
    []
  );

  useEffect(() => {
    void load(status, page, size);
  }, [load, status, page, size]);

  const label = (code: ReportTodoStatus): string => observedLabels[code] ?? code;

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>待查报告待办</h2>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="报告的形成、审批与发布规则待业务方确认"
        description="本页只提供「待查入口」：下列待办由分析库（已完成纠偏闭环的诉求）派生，用于提示哪些诉求需要出报告。不代表报告已经生成，也不代表可对外发布。"
      />

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Select
            placeholder="全部状态"
            allowClear
            style={{ width: 150 }}
            value={status}
            onChange={(v: ReportTodoStatus | undefined) => {
              setStatus(v);
              setPage(1);
            }}
            options={STATUS_CODES.map((code) => ({ value: code, label: label(code) }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(status, page, size)}>
            刷新
          </Button>
          <span style={{ color: '#8c8c8c' }}>
            共 <b>{total}</b> 条待办
          </span>
        </Space>

        {loadError ? (
          <Result
            status="error"
            title="加载待查报告待办失败"
            subTitle={loadError}
            extra={
              <Button type="primary" onClick={() => void load(status, page, size)}>
                重试
              </Button>
            }
          />
        ) : (
          <Table<ReportTodoItem>
            rowKey="todoId"
            size="middle"
            loading={loading}
            dataSource={rows}
            scroll={{ x: 1050 }}
            locale={{
              emptyText: firstLoaded ? <Empty description="暂无待查报告待办" /> : <span />,
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
            columns={[
              { title: '待办编号', dataIndex: 'todoId', width: 200, ellipsis: true },
              {
                title: '关联分析记录',
                dataIndex: 'analysisId',
                width: 190,
                ellipsis: true,
                render: (v: string | null) => v ?? DASH,
              },
              {
                title: '诉求',
                dataIndex: 'complaintId',
                width: 185,
                ellipsis: true,
                render: (v: string, r: ReportTodoItem) => (
                  <a onClick={() => navigate('/complaints/' + encodeURIComponent(r.complaintId))}>{v}</a>
                ),
              },
              {
                title: '报告编号',
                dataIndex: 'reportId',
                width: 150,
                render: (v: string | null) =>
                  v ? <Tag color="blue">{v}</Tag> : DASH,
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 100,
                render: (s: ReportTodoStatus, r: ReportTodoItem) => (
                  <Tag color={STATUS_COLOR[s] ?? 'default'}>{r.statusName || s}</Tag>
                ),
              },
              {
                title: '备注',
                dataIndex: 'note',
                ellipsis: true,
                render: (v: string | null) => v ?? DASH,
              },
              { title: '创建时间', dataIndex: 'createdAt', width: 165, render: (v: string | null) => fmt(v) },
              { title: '更新时间', dataIndex: 'updatedAt', width: 165, render: (v: string | null) => fmt(v) },
              {
                title: '操作',
                width: 110,
                fixed: 'right' as const,
                render: (_: unknown, r: ReportTodoItem) => (
                  <Button
                    type="link"
                    size="small"
                    icon={<SearchOutlined />}
                    onClick={() => navigate('/complaints/' + encodeURIComponent(r.complaintId))}
                  >
                    查看诉求
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
};

export default ReportView;
