import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, InputNumber, Space, Switch, Table, Tag, Typography } from 'antd';
import { validateWarningRules } from './researchModel';
import type { SupportWarningConfig, SupportWarningRule } from './types';

interface SupportWarningRulesProps {
  config: SupportWarningConfig;
  onSaveRules: (rules: SupportWarningRule[]) => Promise<void>;
  canManage: boolean;
}

const scenarioNames = { winter: '冬季供气', summer: '夏季供水', planned: '计划停供', installation: '安装问题' };

export default function SupportWarningRules({ config, onSaveRules, canManage }: SupportWarningRulesProps) {
  const [draft, setDraft] = useState(() => config.rules.map(r => ({ ...r })));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const generation = useRef(0);
  const submittedRules = useRef<string | null>(null);
  useEffect(() => { generation.current++; submittedRules.current = null; setDraft(config.rules.map(r => ({ ...r }))); setFeedback(null); setSaving(false); }, [canManage]);
  useEffect(() => {
    setDraft(config.rules.map(r => ({ ...r })));
    setFeedback(submittedRules.current === JSON.stringify(config.rules) ? { type: 'success', text: '预警规则已保存，预警按已保存配置计算。' } : null);
  }, [config]);
  const change = (scenario: SupportWarningRule['scenario'], patch: Partial<SupportWarningRule>) => { setDraft(rules => rules.map(r => r.scenario === scenario ? { ...r, ...patch } : r)); setFeedback(null); };
  async function save() {
    if (!canManage || saving) return;
    const error = validateWarningRules(draft);
    if (error) { setFeedback({ type: 'error', text: error }); return; }
    const currentGeneration = generation.current;
    submittedRules.current = JSON.stringify(draft);
    setSaving(true); setFeedback(null);
    try { await onSaveRules(draft.map(r => ({ ...r }))); if (generation.current === currentGeneration) setFeedback({ type: 'success', text: '预警规则已保存，预警按已保存配置计算。' }); }
    catch (error) { if (generation.current === currentGeneration) { submittedRules.current = null; setFeedback({ type: 'error', text: error instanceof Error ? error.message : '保存失败，请重试。' }); } }
    finally { if (generation.current === currentGeneration) setSaving(false); }
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(config.rules);
  return <Card title="预警场景与规则配置" extra={<Tag>规则版本 {config.revision}</Tag>}>
      <Typography.Paragraph type="secondary">每个场景从核算截止日向前按自然日观察，达到阈值时触发预警。规则保存后生效。</Typography.Paragraph>
      {!canManage && <Alert type="info" message="当前账号只有规则查看权限。" style={{ marginBottom: 12 }} />}
      <Table size="small" rowKey="scenario" pagination={false} scroll={{ x: 780 }} dataSource={draft} columns={[
        { title: '场景', render: (_, r) => scenarioNames[r.scenario] },
        { title: '启用', render: (_, r) => <Switch aria-label={`${scenarioNames[r.scenario]}启用`} checked={r.enabled} disabled={!canManage || saving} onChange={enabled => change(r.scenario, { enabled })} /> },
        { title: '观察天数', render: (_, r) => <InputNumber aria-label={`${scenarioNames[r.scenario]}观察天数`} min={1} max={3660} precision={0} value={r.days} disabled={!canManage || saving} onChange={days => change(r.scenario, { days: days ?? 0 })} addonAfter="天" /> },
        { title: '触发阈值', render: (_, r) => <InputNumber aria-label={`${scenarioNames[r.scenario]}触发阈值`} min={1} precision={0} value={r.threshold} disabled={!canManage || saving} onChange={threshold => change(r.scenario, { threshold: threshold ?? 0 })} addonAfter="件" /> },
      ]} />
      <Space style={{ marginTop: 12 }} wrap><Button type="primary" loading={saving} disabled={!canManage || !dirty} onClick={save}>保存预警规则</Button><Button disabled={!canManage || !dirty || saving} onClick={() => { setDraft(config.rules.map(r => ({ ...r }))); setFeedback(null); }}>恢复已保存规则</Button><Typography.Text type="secondary">{dirty ? '存在未保存修改' : '已使用服务器保存规则'}</Typography.Text></Space>
      {feedback && <Alert role="status" type={feedback.type} showIcon message={feedback.text} style={{ marginTop: 12 }} />}
  </Card>;
}
