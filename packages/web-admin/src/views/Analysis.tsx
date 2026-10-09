import React, { useState } from 'react';
import { Tabs } from 'antd';
import StatisticsPanel from '../components/StatisticsPanel';
import AnalysisRecordBrowser from '../components/AnalysisRecordBrowser';
import { useAppStore } from '../stores/appStore';
export default function Analysis() {
    const user = useAppStore(s => s.userInfo);
    const canStatistics = Boolean(user && !user.mustChangePassword && user.permissions.includes('statistics.read') && user.permissions.includes('analysis.read'));
    const [selected, setSelected] = useState<'statistics' | 'records'>(() => canStatistics ? 'statistics' : 'records');
    const active = canStatistics ? selected : 'records';
    return <><Tabs activeKey={active} onChange={key => setSelected(key as 'statistics' | 'records')} items={[{ key: 'statistics', label: '分析库统计', disabled: !canStatistics }, { key: 'records', label: '入库记录浏览' }]}/>{active === 'statistics' ? <StatisticsPanel initialDataset="analysis"/> : <AnalysisRecordBrowser />}</>;
}
