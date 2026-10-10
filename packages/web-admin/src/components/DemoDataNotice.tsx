import React from 'react';
import { Tag } from 'antd';

/** Mark example data without exposing implementation details. */
const DemoDataNotice: React.FC<{ batch: string; detail?: string }> = () => (
  <Tag color="gold" data-demo="true" style={{ marginBottom: 12 }}>演示数据</Tag>
);

export default DemoDataNotice;
