import React from 'react';
import { Alert, Card, Space, Tag, Typography } from 'antd';
import type { LocationClueView } from '../types/api';

const clueKindName: Record<LocationClueView['kind'], string> = {
  township: '乡镇／街道',
  settlement: '村／社区／小区',
};

const LocationClues: React.FC<{ clues: LocationClueView[]; conflict: boolean }> = ({ clues, conflict }) => {
  if (clues.length === 0) return null;
  return (
    <Card size="small" title="待核实位置线索" style={{ marginTop: 12 }}>
      {conflict && <Alert type="warning" showIcon message="位置冲突：详细地址候选和位置线索仅供查看，请人工核实" style={{ marginBottom: 12 }} />}
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {clues.map((clue, index) => (
          <div key={`${clue.kind}-${clue.sourceField}-${clue.value}-${index}`} style={{ borderLeft: '3px solid #91caff', paddingLeft: 10 }}>
            <Space wrap size={6}>
              <Tag color="blue">{clueKindName[clue.kind]}</Tag>
              <Typography.Text strong>{clue.value}</Typography.Text>
              <Typography.Text type="secondary">所属区县：{clue.districtName ?? '待核实'}</Typography.Text>
            </Space>
            <div><Typography.Text type="secondary">证据：{clue.evidence}（{clue.sourceField === 'title' ? '标题' : '正文'}）</Typography.Text></div>
            <div><Typography.Text type="secondary">规则 {clue.extractorVersion} · 名录 {clue.snapshotId}</Typography.Text></div>
          </div>
        ))}
      </Space>
    </Card>
  );
};

export default LocationClues;
