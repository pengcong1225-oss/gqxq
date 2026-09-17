import React, { useState } from 'react';
import { Button, Card, Col, Descriptions, Form, Input, message, Row, Space, Table, Tag } from 'antd';
import { EnvironmentOutlined, SaveOutlined } from '@ant-design/icons';

const initialRows = Array.from({ length: 12 }, (_, i) => ({
  key: i + 1,
  complaintNo: 'CS202606' + String(i + 1).padStart(4, '0'),
  title: ['水压不足地址不详', '燃气气味明显', '停水范围不清', '液化气配送超时'][i % 4],
  rawAddress: ['西陵区沿江大道附近', '伍家岗中南路小区', '点军区江南大道', '夷陵区发展大道'][i % 4],
  confidence: [0.42, 0.58, 0.63, 0.31][i % 4],
  businessType: i % 2 === 0 ? 'water' : 'gas',
  sourceSystem: '宜接就办',
  status: 'pending'
}));

const AddressCorrection: React.FC = () => {
  const [rows, setRows] = useState(initialRows);
  const [selected, setSelected] = useState<any>(initialRows[0]);
  const [form] = Form.useForm();

  const submit = () => {
    form.validateFields().then((values) => {
      setRows(rows.map((row) => row.key === selected.key ? { ...row, ...values, status: 'corrected', confidence: 0.92 } : row));
      setSelected({ ...selected, ...values, status: 'corrected', confidence: 0.92 });
      message.success('纠偏结果已提交，已写入诉求流转记录');
    });
  };

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>地址纠偏工作台</h2>
      <Row gutter={16}>
        <Col span={14}>
          <Card title="待纠偏诉求">
            <Table
              rowKey="key"
              size="middle"
              dataSource={rows}
              pagination={{ pageSize: 8 }}
              onRow={(record) => ({ onClick: () => { setSelected(record); form.setFieldsValue({ correctedAddress: record.correctedAddress, lng: record.lng, lat: record.lat }); } })}
              columns={[
                { title: '诉求编号', dataIndex: 'complaintNo', width: 130 },
                { title: '标题', dataIndex: 'title', ellipsis: true },
                { title: '原始地址', dataIndex: 'rawAddress', ellipsis: true },
                { title: '置信度', dataIndex: 'confidence', width: 90, render: (v: number) => <Tag color={v < 0.5 ? 'red' : 'orange'}>{Math.round(v * 100)}%</Tag> },
                { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'corrected' ? 'success' : 'warning'}>{v === 'corrected' ? '已纠偏' : '待纠偏'}</Tag> }
              ]}
            />
          </Card>
        </Col>
        <Col span={10}>
          <Card title="纠偏确认" extra={<EnvironmentOutlined />}>
            {selected && (
              <>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="诉求编号">{selected.complaintNo}</Descriptions.Item>
                  <Descriptions.Item label="来源系统">{selected.sourceSystem}</Descriptions.Item>
                  <Descriptions.Item label="原始地址">{selected.rawAddress}</Descriptions.Item>
                </Descriptions>
                <div className="mock-map">
                  GIS 选点区
                  <span>政务网天地图/内部 GIS 接入后在此选点</span>
                </div>
                <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
                  <Form.Item name="correctedAddress" label="纠偏后地址" rules={[{ required: true, message: '请输入纠偏地址' }]}>
                    <Input placeholder="请输入标准地址" />
                  </Form.Item>
                  <Space>
                    <Form.Item name="lng" label="经度" rules={[{ required: true }]}>
                      <Input placeholder="111.286" />
                    </Form.Item>
                    <Form.Item name="lat" label="纬度" rules={[{ required: true }]}>
                      <Input placeholder="30.708" />
                    </Form.Item>
                  </Space>
                  <Button type="primary" icon={<SaveOutlined />} onClick={submit}>提交纠偏</Button>
                </Form>
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default AddressCorrection;
