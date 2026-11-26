import { useState } from 'react';
import { Alert, Button, Modal, Space, Spin, Table, Typography } from 'antd';
import { applySourceCategoryBackfill, previewSourceCategoryBackfill, type SourceCategoryBackfillPreview } from '../api/masterData';
import { useWriteAccess } from '../stores/roleAccess';

export default function SourceCategoryBackfillDialog({ onApplied }: { onApplied: () => void }) {
  const { can } = useWriteAccess('complaint.correct');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SourceCategoryBackfillPreview | null>(null);
  const [successCount, setSuccessCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    setOpen(true);
    setPreview(null);
    setSuccessCount(null);
    setError(null);
    setBusy(true);
    try {
      setPreview(await previewSourceCategoryBackfill());
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取补齐预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function applyPreview() {
    if (!preview?.candidates || busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await applySourceCategoryBackfill(preview.digest);
      setSuccessCount(result.revised);
      onApplied();
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : '补齐分类失败');
    } finally {
      setBusy(false);
    }
  }

  if (!can) return null;
  return <>
    <Button onClick={() => void loadPreview()}>补齐来源分类</Button>
    <Modal
      open={open}
      title="补齐宜接就办来源分类"
      onCancel={() => setOpen(false)}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      footer={[
        <Button key="close" disabled={busy} onClick={() => setOpen(false)}>关闭</Button>,
        error && <Button key="retry" onClick={() => void loadPreview()}>重新预览</Button>,
        !!preview?.candidates && successCount === null && <Button key="apply" type="primary" loading={busy}
          onClick={() => void applyPreview()}>确认补齐 {preview.candidates} 件</Button>,
      ]}
    >
      <Spin spinning={busy}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>在当前账号授权范围核对缺大小类的诉求。来源名称与发布字典逐字匹配，已有人工处理及归库记录保留。</Typography.Text>
          {error && <Alert type="error" showIcon message={error} />}
          {successCount !== null && <Alert type="success" showIcon message={`已补齐 ${successCount} 件来源分类`} />}
          {preview && <Typography.Text>字典 v{preview.dictionaryVersion} · 可补齐 {preview.candidates} 件 · 保留待核 {preview.remaining} 件</Typography.Text>}
          {!!preview?.remaining && <Typography.Text type="secondary">
            已有人工决定 {preview.skipped.manualDecision} 件，已归库 {preview.skipped.analysisRecord} 件，来源与字典未能唯一匹配 {preview.skipped.noExactSourceCategory} 件。
          </Typography.Text>}
          {!!preview?.byCategory.length && <Table size="small" rowKey="minorCode" pagination={false} scroll={{ y: 240 }}
            dataSource={preview.byCategory}
            columns={[{ title: '诉求小类', dataIndex: 'minorName' }, { title: '编码', dataIndex: 'minorCode' }, { title: '件数', dataIndex: 'count' }]} />}
        </Space>
      </Spin>
    </Modal>
  </>;
}
