import React from 'react';
import {Alert, Select, Space, Tag} from 'antd';
import type {UtilityMode} from './types';
export const formatUtilityTime = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false}) : '—';
export const approvalLabel = {pending: '待审批', approved: '已审批', rejected: '已驳回'};
export const complaintTypeLabel: Record<string, string> = {complaint: '投诉', consult: '咨询', suggest: '建议', report: '举报', help: '求助', other: '其他', praise: '表扬'};
export function UtilityModeBar({mode, onChange}: {mode: UtilityMode; onChange: (mode: UtilityMode) => void}) {
  return <><Space wrap style={{marginBottom: 16}}><span>数据模式</span><Select aria-label="公共事业数据模式" value={mode} onChange={onChange} style={{width: 240}} options={[{value: 'simulation', label: '模拟数据（演示验收）'}, {value: 'real', label: '真实数据（来源填报系统）'}]}/><Tag>来源：公共事业管理的填报系统</Tag></Space>
    <Alert showIcon type={mode === 'simulation' ? 'warning' : 'info'} style={{marginBottom: 16}} message={mode === 'simulation' ? '模拟演示专区：新增、编辑、审批信息及推送结果均为模拟' : '真实记录：展示来源填报系统数据，审批信息只读'} description={mode === 'simulation' ? '模拟记录独立保存，可刷新核验；模拟推送不会发送到外部系统。' : '来源数据由有权限的管理员导入。外部系统连接尚待接入，当前不提供真实推送。'}/></>;
}
