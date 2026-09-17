import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  Result,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  EyeOutlined,
  ExportOutlined,
  FileTextOutlined,
  ImportOutlined,
  SearchOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { Dayjs } from 'dayjs';
import { listComplaints } from '../api/complaints';
import { getDictItems } from '../api/dicts';
import type {
  ApiError,
  BusinessType,
  ComplaintListItem,
  ComplaintListParams,
  ComplaintListResult,
  ComplaintType,
  CorrectionStatus,
  DictCode,
  DictItem,
  SourceEventStatus,
  SupervisionStatus,
  UrgencyLevel,
} from '../types/api';

const { RangePicker } = DatePicker;

/**
 * 诉求总账（真实接口驱动）。
 *
 * 设计纪律（《2026-09-17-诉求平台G1详细实施方案》§0 交付纪律）：
 *  - 无 Mock、无 || 兜底：接口失败就是失败态，绝不回落到示例数据。
 *  - 中文名一律用服务端返回的 *Name 字段，前端不建翻译表（这里只保留按 code 取色的色板）。
 *  - 未实现的按钮 disabled + Tooltip 说明归属批次，不弹假成功。
 */

/* ---------------- 筛选条件 ---------------- */

interface Filters {
  keyword?: string;
  businessType?: BusinessType;
  complaintType?: ComplaintType;
  urgencyLevel?: UrgencyLevel;
  supervisionStatus?: SupervisionStatus;
  sourceEventStatus?: SourceEventStatus;
  isSensitive?: 0 | 1;
  correctionStatus?: CorrectionStatus;
  districtCode?: string;
  range?: [Dayjs | null, Dayjs | null] | null;
}

/** 仅用于 Tag 配色；文案一律取服务端 *Name 字段。 */
const BUSINESS_COLOR: Record<string, string> = { water: 'blue', gas: 'orange', lpg: 'purple' };
const URGENCY_COLOR: Record<string, string> = { normal: 'blue', urgent: 'orange', critical: 'red' };
const CORRECTION_COLOR: Record<string, string> = {
  none: 'default',
  pending: 'warning',
  corrected: 'success',
  failed: 'error',
};
const SUPERVISION_COLOR: Record<string, string> = {
  none: 'default',
  pending_match: 'warning',
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

/** 筛选下拉用的字典类型（标签来自服务端 /dicts/:code/items，不在前端硬编码）。 */
const DICT_CODES: DictCode[] = [
  'business_type',
  'complaint_type',
  'urgency_level',
  'supervision_status',
  'source_event_status',
  'correction_status',
  'district',
];

/* ---------------- 小工具 ---------------- */

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

function fmtDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '—';
}

const ComplaintList: React.FC = () => {
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [filters, setFilters] = useState<Filters>({});
  const [keywordInput, setKeywordInput] = useState('');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const [data, setData] = useState<ComplaintListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [dicts, setDicts] = useState<Partial<Record<DictCode, DictItem[]>>>({});
  const [dictError, setDictError] = useState<string | null>(null);

  /** 请求序号：快速切换筛选时，过期响应必须被丢弃，否则旧结果会覆盖新结果。 */
  const seqRef = useRef(0);

  /* ---------- 字典：筛选下拉的标签一律来自服务端 ---------- */
  useEffect(() => {
    let alive = true;
    setDictError(null);
    Promise.all(DICT_CODES.map(async (code) => [code, await getDictItems(code)] as const))
      .then((entries) => {
        if (!alive) return;
        setDicts(Object.fromEntries(entries) as Partial<Record<DictCode, DictItem[]>>);
      })
      .catch((err: ApiError) => {
        if (!alive) return;
        setDictError(err?.message ?? '字典加载失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  const dictOptions = useCallback(
    (code: DictCode) => (dicts[code] ?? []).map((d) => ({ value: d.value, label: d.label })),
    [dicts]
  );

  /* ---------- 查询参数 ---------- */
  const params = useMemo<ComplaintListParams>(
    () => ({
      page,
      size,
      keyword: filters.keyword,
      businessType: filters.businessType,
      complaintType: filters.complaintType,
      urgencyLevel: filters.urgencyLevel,
      supervisionStatus: filters.supervisionStatus,
      sourceEventStatus: filters.sourceEventStatus,
      isSensitive: filters.isSensitive,
      correctionStatus: filters.correctionStatus,
      startDate: filters.range?.[0] ? filters.range[0].format('YYYY-MM-DD') : undefined,
      endDate: filters.range?.[1] ? filters.range[1].format('YYYY-MM-DD') : undefined,
    }),
    [page, size, filters]
  );

  const load = useCallback(async (p: ComplaintListParams) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listComplaints(p);
      if (seq !== seqRef.current) return; // 过期响应，丢弃
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

  /** 任一筛选变化都回到第 1 页 */
  const applyFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  const stats = data?.stats;
  const firstLoading = loading && data === null;

  /* ---------- 列 ---------- */
  const columns: ColumnsType<ComplaintListItem> = useMemo(
    () => [
      {
        title: '诉求编号',
        dataIndex: 'complaintNo',
        width: 160,
        fixed: 'left',
        render: (v: string, r) => <a onClick={() => navigate('/complaints/' + r.id)}>{v}</a>,
      },
      {
        title: '标题',
        dataIndex: 'title',
        ellipsis: true,
        render: (t: string, r) => (
          <>
            {r.isSensitive && (
              <Tag color="red" style={{ marginRight: 4 }}>
                敏感
              </Tag>
            )}
            <Tooltip title={t}>{t}</Tooltip>
          </>
        ),
      },
      {
        title: '业务类型',
        dataIndex: 'businessTypeCode',
        width: 90,
        render: (_: unknown, r) => (
          <Tag color={BUSINESS_COLOR[r.businessTypeCode] ?? 'default'}>{r.businessTypeName}</Tag>
        ),
      },
      {
        title: '诉求类型',
        dataIndex: 'complaintTypeCode',
        width: 90,
        render: (_: unknown, r) => <Tag>{r.complaintTypeName}</Tag>,
      },
      {
        title: '紧急程度',
        dataIndex: 'urgencyLevelCode',
        width: 90,
        render: (_: unknown, r) => (
          <Tag color={URGENCY_COLOR[r.urgencyLevelCode] ?? 'default'}>{r.urgencyLevelName}</Tag>
        ),
      },
      {
        title: '来源系统',
        dataIndex: 'sourceSystem',
        width: 110,
        render: (v: string | null) => (v ? <Tag color="blue">{v}</Tag> : DASH),
      },
      {
        title: '来源渠道',
        dataIndex: 'sourceChannel',
        width: 100,
        render: (v: string | null) => v ?? DASH,
      },
      {
        title: '督办状态',
        dataIndex: 'supervisionStatusCode',
        width: 130,
        render: (_: unknown, r) => (
          <Tag color={SUPERVISION_COLOR[r.supervisionStatusCode] ?? 'default'}>
            {r.supervisionStatusName}
          </Tag>
        ),
      },
      {
        title: '来源状态',
        dataIndex: 'sourceEventStatusCode',
        width: 110,
        render: (_: unknown, r) =>
          r.sourceEventStatusCode === 'unknown' ? (
            <Tooltip title="宜接就办接口尚未对接（批次 G6），来源处置状态暂不可知">
              <Tag color="default">{r.sourceEventStatusName}</Tag>
            </Tooltip>
          ) : (
            <Tag color="cyan">{r.sourceEventStatusName}</Tag>
          ),
      },
      {
        title: '区域',
        dataIndex: 'districtName',
        width: 90,
        render: (v: string | null) => v ?? DASH,
      },
      {
        title: '责任企业',
        dataIndex: 'enterpriseName',
        width: 180,
        ellipsis: true,
        render: (v: string | null) =>
          v ? <Tooltip title={v}>{v}</Tooltip> : <span style={{ color: '#faad14' }}>未匹配</span>,
      },
      {
        title: '接收时间',
        dataIndex: 'receivedAt',
        width: 165,
        render: (v: string | null) => fmtDateTime(v),
      },
      {
        title: '操作',
        width: 80,
        fixed: 'right',
        render: (_: unknown, r) => (
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate('/complaints/' + r.id)}
          >
            详情
          </Button>
        ),
      },
    ],
    [navigate]
  );

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>诉求管理</h2>

      {dictError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={'筛选字典加载失败：' + dictError}
          description="筛选下拉项来自服务端字典接口，加载失败时下拉为空；表格数据不受影响。"
        />
      )}

      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card size="small">
            <Statistic title="总诉求" value={stats ? stats.total : '—'} loading={firstLoading} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="未交办" value={stats ? stats.notDispatchedCount : '—'} loading={firstLoading} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="待匹配" value={stats ? stats.pendingMatchCount : '—'} loading={firstLoading} valueStyle={{ color: '#faad14' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="已交办" value={stats ? stats.activeDispatchCount : '—'} loading={firstLoading} prefix={<ClockCircleOutlined />} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="敏感诉求" value={stats ? stats.sensitiveCount : '—'} loading={firstLoading} prefix={<WarningOutlined />} valueStyle={{ color: '#ff4d4f' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="本系统办结" value={stats ? stats.closedInSystemCount : '—'} loading={firstLoading} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
      </Row>

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input.Search
            placeholder="搜索编号/标题/内容/地址"
            prefix={<SearchOutlined />}
            value={keywordInput}
            allowClear
            style={{ width: 260 }}
            onChange={(e) => {
              setKeywordInput(e.target.value);
              if (e.target.value === '') applyFilter({ keyword: undefined });
            }}
            onSearch={(v) => applyFilter({ keyword: v.trim() === '' ? undefined : v.trim() })}
          />
          <Select
            placeholder="业务类型"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('business_type')}
            onChange={(v: BusinessType | undefined) => applyFilter({ businessType: v })}
          />
          <Select
            placeholder="诉求类型"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('complaint_type')}
            onChange={(v: ComplaintType | undefined) => applyFilter({ complaintType: v })}
          />
          <Select
            placeholder="紧急程度"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('urgency_level')}
            onChange={(v: UrgencyLevel | undefined) => applyFilter({ urgencyLevel: v })}
          />
          <Select
            placeholder="督办状态"
            allowClear
            style={{ width: 150 }}
            options={dictOptions('supervision_status')}
            onChange={(v: SupervisionStatus | undefined) => applyFilter({ supervisionStatus: v })}
          />
          <Select
            placeholder="来源状态"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('source_event_status')}
            onChange={(v: SourceEventStatus | undefined) => applyFilter({ sourceEventStatus: v })}
          />
          <Select
            placeholder="是否敏感"
            allowClear
            style={{ width: 110 }}
            options={[
              { value: 1, label: '是' },
              { value: 0, label: '否' },
            ]}
            onChange={(v: 0 | 1 | undefined) => applyFilter({ isSensitive: v })}
          />
          <Select
            placeholder="纠偏状态"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('correction_status')}
            onChange={(v: CorrectionStatus | undefined) => applyFilter({ correctionStatus: v })}
          />
          <Select
            placeholder="区域"
            allowClear
            style={{ width: 160 }}
            options={dictOptions('district')}
            onChange={(v: string | undefined) => applyFilter({ districtCode: v })}
          />
          <RangePicker
            value={range}
            onChange={(v) => {
              const next = v as [Dayjs | null, Dayjs | null] | null;
              setRange(next);
              applyFilter({ range: next });
            }}
          />
          <Tooltip title="导出与批量导入尚未实现（后端未提供接口）">
            <Button icon={<ExportOutlined />} disabled>
              导出Excel
            </Button>
          </Tooltip>
          <Tooltip title="批量导入尚未实现（后端未提供接口）">
            <Button icon={<ImportOutlined />} disabled>
              批量导入
            </Button>
          </Tooltip>
        </Space>

        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            统计卡片为当前筛选条件下的全量口径（不受分页影响）。来源状态「未接入」表示宜接就办接口尚未对接（批次 G6），不代表处置进度。
          </Typography.Text>
        </div>

        {error ? (
          <Result
            status="error"
            title="诉求列表加载失败"
            subTitle={error.message}
            extra={
              <Space>
                <Button type="primary" onClick={() => void load(params)}>
                  重试
                </Button>
                <Button onClick={() => navigate('/dashboard')}>返回大屏</Button>
              </Space>
            }
          />
        ) : (
          <Table<ComplaintListItem>
            rowKey="id"
            columns={columns}
            dataSource={data?.content ?? []}
            loading={loading}
            size="middle"
            scroll={{ x: 1700 }}
            locale={{ emptyText: <Empty description="暂无诉求数据" /> }}
            pagination={{
              current: page,
              pageSize: size,
              total: data?.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => '共 ' + total + ' 条诉求',
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
    </div>
  );
};

export default ComplaintList;
