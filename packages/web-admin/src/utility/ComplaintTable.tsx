import React, {useState} from 'react';
import {Button, Descriptions, Modal, Table} from 'antd';
import {Link} from 'react-router-dom';
import type {UtilityComplaint, UtilityMode, UtilityOptions} from './types';
import {complaintTypeLabel, formatUtilityTime} from './shared';

export default function ComplaintTable({complaints, mode, options}: {complaints: UtilityComplaint[]; mode: UtilityMode; options?: UtilityOptions}) {
  const [selected, setSelected] = useState<UtilityComplaint>();
  return <><Table<UtilityComplaint> rowKey="id" size="small" dataSource={complaints} pagination={{pageSize: 6}} columns={[
    {title: '编号', dataIndex: 'id'},
    {title: '诉求', dataIndex: 'title', render: (title, row) => <Button type="link" onClick={() => setSelected(row)}>{title}</Button>},
    {title: '类型', dataIndex: 'type', render: (v: string) => complaintTypeLabel[v] ?? v},
    {title: '发生时间', dataIndex: 'occurredAt', render: formatUtilityTime},
    {title: '网格', dataIndex: 'gridId', render: (v: string) => options?.grids.find(g => g.id === v)?.name ?? v},
  ]}/>{selected && <Modal open title={`${mode === 'simulation' ? '【模拟】' : ''}关联诉求明细`} onCancel={() => setSelected(undefined)} footer={<Button onClick={() => setSelected(undefined)}>关闭</Button>}>
    <Descriptions bordered column={1} items={[
      {key: 'id', label: '诉求编号', children: selected.id}, {key: 'title', label: '诉求内容', children: selected.title},
      {key: 'type', label: '诉求类型', children: complaintTypeLabel[selected.type] ?? selected.type}, {key: 'date', label: '发生时间', children: formatUtilityTime(selected.occurredAt)},
      {key: 'grid', label: '网格', children: options?.grids.find(g => g.id === selected.gridId)?.name ?? selected.gridId},
      {key: 'mode', label: '数据模式', children: mode === 'simulation' ? '模拟数据（演示验收）' : '真实诉求'},
    ]}/>{mode === 'real' && <div style={{marginTop: 12}}><Link to={`/complaints/${encodeURIComponent(selected.id)}`}>打开诉求完整档案</Link></div>}
  </Modal>}</>;
}
