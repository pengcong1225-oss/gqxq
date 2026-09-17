import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Result,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { getAnalysisRecord, listAnalysisRecords } from '../api/analysis';
import type { AnalysisRecordDetail } from '../api/analysis';
import { getDictItems } from '../api/dicts';
import { listEnterprises } from '../api/enterprises';
import type { AnalysisRecordItem, BusinessType, DictItem, EnterpriseListItem } from '../types/api';

/**
 * 分析库（真实接口驱动）。
 *
 * **核心口径**：只有**纠偏闭环完成**的诉求才会出现在这里。
 * 「无需交办归库」「误报归库」的诉求不纳入分析口径。
 * 因此本页任何情况下都不得用兜底数据"补足"行数。
 */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

function fmt(iso: string | null | undefined): React.ReactNode {
  return iso ? new Date(iso).toLocaleString('zh-CN') : DASH;
}

const Analysis: React.FC = () => {
  const navigate = useNavigate();

  const [rows, setRows] = useState<AnalysisRecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [fDistrict, setFDistrict] = useState<string | undefined>(undefined);
  const [fBusiness, setFBusiness] = useState<BusinessType | undefined>(undefined);
  const [fEnterprise, setFEnterprise] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const seqRef = useRef(0);

  // 筛选候选项：区域与业务类型来自服务端字典；企业来自服务端企业主数据。
  const [districtOptions, setDistrictOptions] = useState<DictItem[]>([]);
  const [businessOptions, setBusinessOptions] = useState<DictItem[]>([]);
  const [enterpriseOptions, setEnterpriseOptions] = useState<EnterpriseListItem[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // 下钻
  const [detail, setDetail] = useState<AnalysisRecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadOptions = useCallback(async () => {
    setOptionsError(null);
    try {
      const [districts, businesses, enterprises] = await Promise.all([
        getDictItems('district'),
        getDictItems('business_type'),
        listEnterprises({ page: 1, size: 100 }),
      ]);
      setDistrictOptions(districts);
      setBusinessOptions(businesses);
      setEnterpriseOptions(enterprises.content);
    } catch (err) {
      // 筛选项加载失败不影响列表本身；如实提示，不回落到本地候选项。
      setOptionsError(errText(err));
      setDistrictOptions([]);
      setBusinessOptions([]);
      setEnterpriseOptions([]);
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  const load = useCallback(
    async (
      p: number,
      n: number,
      districtCode: string | undefined,
      businessType: BusinessType | undefined,
      enterpriseCode: string | undefined
    ) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await listAnalysisRecords({
          page: p,
          size: n,
          districtCode,
          businessType,
          enterpriseCode,
        });
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
    },
    []
  );

  useEffect(() => {
    void load(page, size, fDistrict, fBusiness, fEnterprise);
  }, [load, page, size, fDistrict, fBusiness, fEnterprise]);

  const openDetail = async (analysisId: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    try {
      const d = await getAnalysisRecord(analysisId);
      setDetail(d);
    } catch (err) {
      setDetailError(errText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  /** 实测形状是嵌套的（record/complaint/dispatch/approvalTraces/corrections/reportTodo）；
   *  万一后端改成别的形状，明确说出来，而不是显示空白。 */
  const shapeMismatch = !!detail && !detail.record;

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>分析库</h2>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="进入分析库的前置条件是纠偏闭环完成"
        description="只有纠偏全部确认（或判定无需纠偏）的诉求才会进入分析库；无需交办归库、误报归库的诉求不纳入本口径。列表为空表示当前筛选条件下确实没有已闭环的诉求，不代表数据加载失败。"
      />

      {optionsError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="筛选项加载失败，筛选项暂不可用"
          description={optionsError + '（列表本身不受影响；下拉不会回落到本地候选项）'}
          action={
            <Button size="small" onClick={() => void loadOptions()}>
              重试
            </Button>
          }
        />
      )}

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Select
            placeholder="区域"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 150 }}
            value={fDistrict}
            onChange={(v: string | undefined) => {
              setFDistrict(v);
              setPage(1);
            }}
            options={districtOptions.map((d) => ({ value: d.value, label: d.label }))}
          />
          <Select
            placeholder="业务类型"
            allowClear
            style={{ width: 130 }}
            value={fBusiness}
            onChange={(v: BusinessType | undefined) => {
              setFBusiness(v);
              setPage(1);
            }}
            options={businessOptions.map((d) => ({ value: d.value, label: d.label }))}
          />
          <Select
            placeholder="责任企业"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 220 }}
            value={fEnterprise}
            onChange={(v: string | undefined) => {
              setFEnterprise(v);
              setPage(1);
            }}
            options={enterpriseOptions.map((e) => ({
              value: e.enterpriseCode,
              label: e.enterpriseName + '（' + e.enterpriseCode + '）',
            }))}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void load(page, size, fDistrict, fBusiness, fEnterprise)}
          >
            刷新
          </Button>
          <span style={{ color: '#8c8c8c' }}>
            共 <b>{total}</b> 条分析记录
          </span>
        </Space>

        {loadError ? (
          <Result
            status="error"
            title="加载分析库失败"
            subTitle={loadError}
            extra={
              <Button
                type="primary"
                onClick={() => void load(page, size, fDistrict, fBusiness, fEnterprise)}
              >
                重试
              </Button>
            }
          />
        ) : (
          <Table<AnalysisRecordItem>
            rowKey="analysisId"
            size="middle"
            loading={loading}
            dataSource={rows}
            scroll={{ x: 1250 }}
            locale={{
              emptyText: firstLoaded ? (
                <Empty description="当前筛选条件下暂无已闭环进入分析库的诉求" />
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
            columns={[
              {
                title: '诉求',
                dataIndex: 'complaintId',
                width: 190,
                ellipsis: true,
                render: (v: string, r: AnalysisRecordItem) => (
                  <a onClick={() => navigate('/complaints/' + encodeURIComponent(r.complaintId))}>{v}</a>
                ),
              },
              { title: '业务类型', dataIndex: 'businessTypeName', width: 100, render: (v: string) => <Tag>{v}</Tag> },
              { title: '诉求类型', dataIndex: 'complaintTypeName', width: 100, render: (v: string) => <Tag>{v}</Tag> },
              { title: '区域', dataIndex: 'districtName', width: 110, render: (v: string | null) => v ?? DASH },
              {
                title: '责任企业',
                dataIndex: 'enterpriseName',
                width: 190,
                ellipsis: true,
                render: (v: string | null) => v ?? DASH,
              },
              {
                title: '摘要',
                dataIndex: 'summary',
                ellipsis: true,
                render: (v: string | null) => v ?? DASH,
              },
              {
                title: '企业处置结果',
                dataIndex: 'disposalResult',
                width: 220,
                ellipsis: true,
                render: (v: string | null) => v ?? DASH,
              },
              {
                title: '纠偏确认时间',
                dataIndex: 'confirmedAt',
                width: 170,
                render: (v: string | null) => fmt(v),
              },
              {
                title: '操作',
                width: 90,
                fixed: 'right' as const,
                render: (_: unknown, r: AnalysisRecordItem) => (
                  <Button type="link" size="small" onClick={() => void openDetail(r.analysisId)}>
                    下钻
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Drawer
        title={detail && detail.record ? '分析记录 · ' + detail.record.analysisId : '分析记录'}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetail(null);
          setDetailError(null);
        }}
        width={720}
      >
        {detailLoading && <Empty description="加载中…" />}
        {detailError && <Result status="error" title="加载分析记录失败" subTitle={detailError} />}

        {shapeMismatch && (
          <Alert
            type="warning"
            showIcon
            message="响应形状与前端约定不一致"
            description="约定 GET /analysis/records/:analysisId 返回 { record, complaint, dispatch, approvalTraces, corrections, reportTodo }。当前响应里没有 record 字段，请与后端核对形状。"
          />
        )}

        {detail && !shapeMismatch && (
          <>
            <Descriptions bordered column={1} size="small" title="分析记录">
              <Descriptions.Item label="分析记录号">{detail.record.analysisId}</Descriptions.Item>
              <Descriptions.Item label="诉求">{detail.record.complaintId}</Descriptions.Item>
              <Descriptions.Item label="交办">{detail.record.assignmentId ?? DASH}</Descriptions.Item>
              <Descriptions.Item label="业务类型">{detail.record.businessTypeName}</Descriptions.Item>
              <Descriptions.Item label="诉求类型">{detail.record.complaintTypeName}</Descriptions.Item>
              <Descriptions.Item label="区域">{detail.record.districtName ?? DASH}</Descriptions.Item>
              <Descriptions.Item label="责任企业">{detail.record.enterpriseName ?? DASH}</Descriptions.Item>
              <Descriptions.Item label="摘要">{detail.record.summary ?? DASH}</Descriptions.Item>
              <Descriptions.Item label="企业处置结果">{detail.record.disposalResult ?? DASH}</Descriptions.Item>
              <Descriptions.Item label="纠偏确认时间">{fmt(detail.record.confirmedAt)}</Descriptions.Item>
              <Descriptions.Item label="入库时间">{fmt(detail.record.createdAt)}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">关联诉求</Divider>
            {detail.complaint ? (
              <Descriptions bordered column={1} size="small">
                <Descriptions.Item label="诉求编号">{detail.complaint.complaintNo}</Descriptions.Item>
                <Descriptions.Item label="标题">{detail.complaint.title}</Descriptions.Item>
                <Descriptions.Item label="督办状态">
                  <Tag>{detail.complaint.supervisionStatusName}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="填报审批">
                  <Tag>{detail.complaint.reportingStatusName}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="本系统办结">
                  {detail.complaint.closedInSystem ? (
                    <Tag color="success">
                      已办结{detail.complaint.closedByName ? '（' + detail.complaint.closedByName + '）' : ''}
                    </Tag>
                  ) : (
                    <Tag>未办结</Tag>
                  )}
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Empty description="后端未返回关联诉求" />
            )}

            <Divider orientation="left">关联交办</Divider>
            {detail.dispatch ? (
              <Descriptions bordered column={1} size="small">
                <Descriptions.Item label="交办单号">{detail.dispatch.orderNo}</Descriptions.Item>
                <Descriptions.Item label="交办状态">
                  <Tag>{detail.dispatch.statusName}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="目标企业">
                  {detail.dispatch.targetEnterpriseName ?? DASH}
                </Descriptions.Item>
                <Descriptions.Item label="填报任务号">
                  {detail.dispatch.reportingTaskId ?? DASH}
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Empty description="后端未返回关联交办" />
            )}

            <Divider orientation="left">审批轨迹</Divider>
            {detail.approvalTraces && detail.approvalTraces.length > 0 ? (
              <Timeline
                items={detail.approvalTraces.map((t) => ({
                  children: (
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {t.summary ?? t.eventType}
                        {t.actorName ? ' — ' + t.actorName : ''}
                      </div>
                      <div style={{ color: '#8c8c8c', fontSize: 12 }}>
                        {fmt(t.occurredAt)}
                        {t.approvalConclusion ? ' · 结论 ' + t.approvalConclusion : ''}
                        {t.submissionVersion ? ' · 第 ' + t.submissionVersion + ' 版' : ''}
                      </div>
                    </div>
                  ),
                }))}
              />
            ) : (
              <Empty description="后端未返回审批轨迹" />
            )}

            <Divider orientation="left">纠偏项</Divider>
            {detail.corrections && detail.corrections.length > 0 ? (
              <Table
                rowKey="correctionId"
                size="small"
                pagination={false}
                dataSource={detail.corrections}
                columns={[
                  { title: '字段', dataIndex: 'fieldLabel', width: 100, render: (v: string | null, r) => v ?? r.fieldName },
                  { title: '旧值', dataIndex: 'oldValue', ellipsis: true, render: (v: string | null) => v ?? DASH },
                  { title: '新值', dataIndex: 'newValue', ellipsis: true, render: (v: string | null) => v ?? DASH },
                  { title: '状态', dataIndex: 'statusName', width: 90, render: (v: string) => <Tag>{v}</Tag> },
                  { title: '确认人', dataIndex: 'confirmerName', width: 90, render: (v: string | null) => v ?? DASH },
                  { title: '确认时间', dataIndex: 'confirmedAt', width: 165, render: (v: string | null) => fmt(v) },
                ]}
              />
            ) : (
              <Empty description="后端未返回纠偏项" />
            )}

            <Divider orientation="left">待查报告待办</Divider>
            {detail.reportTodo ? (
              <Descriptions bordered column={1} size="small">
                <Descriptions.Item label="待办编号">{detail.reportTodo.todoId}</Descriptions.Item>
                <Descriptions.Item label="状态">
                  <Tag>{detail.reportTodo.statusName}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="报告编号">{detail.reportTodo.reportId ?? DASH}</Descriptions.Item>
                <Descriptions.Item label="备注">{detail.reportTodo.note ?? DASH}</Descriptions.Item>
                <Descriptions.Item label="创建时间">{fmt(detail.reportTodo.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="更新时间">{fmt(detail.reportTodo.updatedAt)}</Descriptions.Item>
              </Descriptions>
            ) : (
              <Empty description="后端未返回待查报告待办" />
            )}

            <Divider />
            <Row>
              <Col>
                <Button
                  type="primary"
                  onClick={() => navigate('/complaints/' + encodeURIComponent(detail.record.complaintId))}
                >
                  打开诉求详情
                </Button>
              </Col>
            </Row>
          </>
        )}
      </Drawer>
    </div>
  );
};

export default Analysis;
