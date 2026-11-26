import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, DatePicker, Empty, Row, Segmented, Space, Statistic, Table, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import dayjs, { type Dayjs } from 'dayjs';
import { getRepeatRate, type RepeatRateResult } from '../api/repeatRate';

/**
 * 重复投诉率：同一市民同内容重复来电占比。
 * 分母 = 同期受理诉求总数（含重复，不合并），分子 = repeat_flag=1。
 */
export default function RepeatRatePanel() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(4, 'year').startOf('year'), dayjs()]);
  const [groupBy, setGroupBy] = useState<'month' | 'enterprise' | 'district'>('month');
  const [businessType, setBusinessType] = useState<'all' | 'water' | 'gas'>('all');
  const [data, setData] = useState<RepeatRateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getRepeatRate({
        from: range[0].format('YYYY-MM-DD'),
        to: range[1].format('YYYY-MM-DD'),
        groupBy,
        ...(businessType === 'all' ? {} : { businessType }),
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const option = useMemo(() => {
    if (!data) return {};
    const labels = data.series.map((s) => s.label);
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['诉求量', '重复来电', '重复率'] },
      grid: { left: 48, right: 48, top: 40, bottom: 60 },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate: labels.length > 12 ? 45 : 0 } },
      yAxis: [
        { type: 'value', name: '件' },
        { type: 'value', name: '%', max: 20, axisLabel: { formatter: '{value}%' } },
      ],
      series: [
        { name: '诉求量', type: 'bar', data: data.series.map((s) => s.total), itemStyle: { color: '#91caff' } },
        { name: '重复来电', type: 'bar', data: data.series.map((s) => s.repeat), itemStyle: { color: '#ff7875' } },
        { name: '重复率', type: 'line', yAxisIndex: 1, smooth: true, data: data.series.map((s) => s.rate), itemStyle: { color: '#fa8c16' } },
      ],
    };
  }, [data]);

  return (
    <Card
      title="重复投诉率"
      extra={
        <Space wrap>
          <Segmented value={businessType} onChange={(v) => setBusinessType(v as 'all' | 'water' | 'gas')} options={[{ label: '全部', value: 'all' }, { label: '供水', value: 'water' }, { label: '燃气', value: 'gas' }]} />
          <Segmented value={groupBy} onChange={(v) => setGroupBy(v as 'month' | 'enterprise' | 'district')} options={[{ label: '按月份', value: 'month' }, { label: '按企业', value: 'enterprise' }, { label: '按区县', value: 'district' }]} />
          <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
          <Button type="primary" loading={loading} onClick={() => void load()}>统计</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        重复投诉率 = 重复来电诉求数 ÷ 同期受理诉求总数 × 100%。重复来电只打标不合并，诉求总量口径不变。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {data ? (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={24} sm={8}><Card><Statistic title="受理诉求总量" value={data.overall.total} suffix="件" /></Card></Col>
            <Col xs={24} sm={8}><Card><Statistic title="重复来电" value={data.overall.repeat} suffix="件" valueStyle={{ color: '#cf1322' }} /></Card></Col>
            <Col xs={24} sm={8}><Card><Statistic title="重复投诉率" value={data.overall.rate ?? 0} precision={2} suffix="%" /></Card></Col>
          </Row>
          {data.series.length ? <ReactECharts option={option} style={{ height: 340 }} notMerge /> : <Empty description="所选期间无数据" />}
          <Table
            style={{ marginTop: 16 }}
            size="small"
            rowKey={(r) => r.key}
            dataSource={data.series}
            pagination={data.series.length > 20 ? { pageSize: 20 } : false}
            columns={[
              { title: groupBy === 'month' ? '月份' : groupBy === 'enterprise' ? '企业' : '区县', dataIndex: 'label' },
              { title: '诉求量', dataIndex: 'total', width: 100 },
              { title: '重复来电', dataIndex: 'repeat', width: 110 },
              { title: '重复率', dataIndex: 'rate', width: 100, render: (v: number | null) => (v === null ? '—' : v.toFixed(2) + '%') },
            ]}
          />
        </>
      ) : loading ? <Typography.Text type="secondary">统计中…</Typography.Text> : null}
    </Card>
  );
}
