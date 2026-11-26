import React, { useState } from 'react';
import { Tabs } from 'antd';
import TenderStatisticsPanel from '../components/TenderStatisticsPanel';
import AnalysisRecordBrowser from '../components/AnalysisRecordBrowser';
import RepeatRatePanel from '../components/RepeatRatePanel';
import { useAppStore } from '../stores/appStore';
export default function Analysis() {
    const user = useAppStore(s => s.userInfo);
    const canStatistics = Boolean(user && !user.mustChangePassword && user.permissions.includes('statistics.read') && user.permissions.includes('analysis.read'));
    const [selected, setSelected] = useState<'statistics' | 'records' | 'repeat'>('statistics');
    const active = canStatistics ? selected : 'records';
    return <><Tabs activeKey={active} onChange={key => setSelected(key as 'statistics' | 'records' | 'repeat')} items={[{ key: 'statistics', label: '分析库统计', disabled: !canStatistics }, { key: 'repeat', label: '重复投诉率', disabled: !canStatistics }, { key: 'records', label: '入库记录浏览' }]}/>{active === 'statistics' ? <TenderStatisticsPanel initialDataset="analysis"/> : active === 'repeat' ? <RepeatRatePanel/> : <AnalysisRecordBrowser />}</>;
}
