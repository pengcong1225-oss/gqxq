import React from 'react';
import { Alert } from 'antd';

/**
 * 原型演示数据显式标记。
 *
 * 用途：在仍是本地 Mock / 硬编码的页面上方显示统一提示，避免业主把演示数字当成真实业务数据。
 * 规格来源：《2026-09-17-诉求平台G1详细实施方案》§6.6。
 *
 * 说明：antd 的 AlertProps 未声明 data-* 透传，但运行时 otherProps 会经 pickAttrs({ data: true })
 * 落到 Alert 根 div 上，因此这里补一层类型，既保留 data-demo 属性又不引入 tsc 报错。
 */
type DemoAlertProps = React.ComponentProps<typeof Alert> & { 'data-demo'?: string };
const DemoAlert = Alert as unknown as React.ComponentType<DemoAlertProps>;

const DemoDataNotice: React.FC<{ batch: string; detail?: string }> = ({ batch, detail }) => (
  <DemoAlert
    type="warning"
    showIcon
    banner
    style={{ marginBottom: 16 }}
    data-demo="true"
    message={'本页为原型演示数据，尚未接入真实数据（实施批次 ' + batch + '）'}
    description={detail ?? '页面上的数字均为本地示例，不代表系统真实业务数据。'}
  />
);

export default DemoDataNotice;
