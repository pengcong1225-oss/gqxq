import React from 'react';
import { Card, Descriptions, Drawer, Space, Table, Tag, Button } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';

const archiveRows = Array.from({ length: 10 }, (_, i) => ({
  key: i + 1,
  orderNo: 'JB202606' + String(i + 1).padStart(4, '0'),
  complaintNo: 'CS202606' + String(i + 12).padStart(4, '0'),
  targetCompany: ['宜昌市供水总公司', '宜昌中燃', '华润燃气', '夷陵区燃气有限公司'][i % 4],
  status: ['completed', 'rejected'][i % 5 === 0 ? 1 : 0],
  resultType: ['resolved', 'explained', 'transfer'][i % 3],
  archivedAt: new Date(Date.now() - i * 86400000).toISOString(),
  resultContent: '企业已反馈处理结果，管理员确认后归档。附件和现场照片通过统一附件对象预留。'
}));

const DispatchArchive: React.FC = () => {
  const [selected, setSelected] = React.useState<any>(null);

  return (
    <div>
      <DemoDataNotice batch="G5" />
      <h2 style={{ marginBottom: 16 }}>交办归档</h2>
      <Card>
        <Table
          rowKey="key"
          dataSource={archiveRows}
          columns={[
            { title: '交办单号', dataIndex: 'orderNo' },
            { title: '诉求编号', dataIndex: 'complaintNo' },
            { title: '目标企业', dataIndex: 'targetCompany' },
            { title: '反馈状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'completed' ? 'success' : 'error'}>{v === 'completed' ? '已完成' : '已退回'}</Tag> },
            { title: '结果类型', dataIndex: 'resultType', render: (v: string) => <Tag>{v}</Tag> },
            { title: '归档时间', dataIndex: 'archivedAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            { title: '操作', render: (_: any, row: any) => <Button type="link" icon={<EyeOutlined />} onClick={() => setSelected(row)}>查看</Button> }
          ]}
        />
      </Card>
      <Drawer title="归档详情" open={!!selected} onClose={() => setSelected(null)} width={520}>
        {selected && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="交办单号">{selected.orderNo}</Descriptions.Item>
              <Descriptions.Item label="诉求编号">{selected.complaintNo}</Descriptions.Item>
              <Descriptions.Item label="企业">{selected.targetCompany}</Descriptions.Item>
              <Descriptions.Item label="处理结果">{selected.resultContent}</Descriptions.Item>
            </Descriptions>
          </Space>
        )}
      </Drawer>
    </div>
  );
};

export default DispatchArchive;
