import React from 'react';
import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
export default function UnavailablePage() {
  const navigate = useNavigate();
  return <Result status="info" title="停供管理尚未开放" subTitle="该模块尚未接入实际业务数据。"
    extra={<Button onClick={() => navigate(-1)}>返回上一页</Button>} />;
}
