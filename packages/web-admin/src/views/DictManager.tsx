import MasterDataImportDialog from '../components/MasterDataImportDialog';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Select,
  InputNumber,
  Checkbox,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import {useAppStore} from '../stores/appStore';
import {usePermissionAccess} from '../stores/roleAccess';
import type {DictionaryType,DictionaryItem} from '../types/masterData';
import {listDictionaryTypes,listDictionaryItems,saveDictionaryType,saveDictionaryItem,deleteDictionaryItem,deleteDictionaryType,dictionaryReferences} from '../api/masterData';
import {
  createSensitiveWord,
  executeSensitiveRescan,
  listSensitiveWords,
  previewSensitiveRescan,
  updateSensitiveWord,
} from '../api/sensitiveWords';
import { listComplaints } from '../api/complaints';
import type {
  ApiError,
  ManagedSensitiveWord,
  SensitiveRescanPreview,
} from '../types/api';

function errorText(error: unknown): string {
  return (error as ApiError)?.message || '操作失败，请稍后重试';
}

export const SensitiveWordManager: React.FC = () => {
  const [rows, setRows] = useState<ManagedSensitiveWord[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentSensitiveCount, setCurrentSensitiveCount] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedSensitiveWord | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SensitiveRescanPreview | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [form] = Form.useForm<{ word: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listSensitiveWords());
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCurrentSensitiveCount = useCallback(async () => {
    try {
      const result = await listComplaints({ page: 1, size: 1, isSensitive: 1 });
      setCurrentSensitiveCount(result.stats?.sensitiveCount ?? result.total);
    } catch {
      setCurrentSensitiveCount(null);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCurrentSensitiveCount();
  }, [load, loadCurrentSensitiveCount]);

  const enabledCount = rows.filter((row) => row.status === 'enabled').length;
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return rows;
    return rows.filter((row) => row.word.toLocaleLowerCase().includes(term));
  }, [rows, search]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setEditorOpen(true);
  };

  const openEdit = (row: ManagedSensitiveWord) => {
    setEditing(row);
    form.setFieldsValue({ word: row.word });
    setEditorOpen(true);
  };

  const save = async () => {
    let values: { word: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateSensitiveWord(editing.itemId, { word: values.word });
        message.success('敏感词已更新');
      } else {
        await createSensitiveWord(values.word);
        message.success('敏感词已新增并立即用于新诉求识别');
      }
      setEditorOpen(false);
      form.resetFields();
      await load();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = (row: ManagedSensitiveWord) => {
    const enabling = row.status === 'disabled';
    Modal.confirm({
      title: enabling ? '启用敏感词' : '停用敏感词',
      content: enabling
        ? `启用“${row.word}”后，将立即用于新诉求识别。`
        : `停用“${row.word}”后不再用于新诉求识别，历史命中证据仍会保留。`,
      okText: enabling ? '确认启用' : '确认停用',
      okButtonProps: { danger: !enabling },
      cancelText: '取消',
      onOk: async () => {
        try {
          await updateSensitiveWord(row.itemId, {
            status: enabling ? 'enabled' : 'disabled',
          });
          message.success(enabling ? '敏感词已启用' : '敏感词已停用');
          await load();
        } catch (error) {
          message.error(errorText(error));
          throw error;
        }
      },
    });
  };

  const openPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await previewSensitiveRescan());
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setPreviewing(false);
    }
  };

  const runRescan = async () => {
    if (!preview) return;
    setRescanning(true);
    try {
      const result = await executeSensitiveRescan(preview.previewToken);
      message.success(`历史重扫完成，更新 ${result.updated} 条诉求`);
      setPreview(null);
      await Promise.all([load(), loadCurrentSensitiveCount()]);
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setRescanning(false);
    }
  };

  const columns: ColumnsType<ManagedSensitiveWord> = [
    { title: '敏感词', dataIndex: 'word', width: 260 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === 'enabled' ? 'success' : 'default'}>
          {status === 'enabled' ? '启用' : '停用'}
        </Tag>
      ),
    },
    { title: '历史证据行数', dataIndex: 'hitCount', width: 140 },
    {
      title: '操作',
      width: 180,
      render: (_, row) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger={row.status === 'enabled'}
            onClick={() => toggleStatus(row)}
          >
            {row.status === 'enabled' ? '停用' : '启用'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="规则说明"
        description="“当前敏感诉求”按 isSensitive=1 统计诉求数；表格中的历史证据行数按词条统计，可能因一件命中多个词而多于诉求数，停用词的历史证据仍保留。"
      />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}><Card size="small"><Statistic title="词条总数" value={rows.length} /></Card></Col>
        <Col xs={24} sm={8}><Card size="small"><Statistic title="当前启用" value={enabledCount} /></Card></Col>
        <Col xs={24} sm={8}><Card size="small"><Statistic title="当前敏感诉求" value={currentSensitiveCount ?? '—'} /></Card></Col>
      </Row>

      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索敏感词"
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ width: 220 }}
          allowClear
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增敏感词</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void Promise.all([load(), loadCurrentSensitiveCount()])} loading={loading}>刷新</Button>
        <Tag>共 {filtered.length} 条</Tag>
      </Space>

      <Table
        rowKey="itemId"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        size="middle"
        pagination={false}
      />

      <Card title="历史诉求重扫" size="small" style={{ marginTop: 20 }}>
        <Space direction="vertical" size={12}>
          <div>先计算影响范围，不会直接修改数据。确认执行时只更新敏感标记、关键词、规则置信度、规则版本、更新时间和命中证据，不改变交办、归库或人工处置状态。</div>
          <Button icon={<SyncOutlined />} loading={previewing} onClick={() => void openPreview()}>
            预览历史重扫
          </Button>
        </Space>
      </Card>

      <Modal
        title={editing ? '编辑敏感词' : '新增敏感词'}
        open={editorOpen}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
          form.resetFields();
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="word"
            label="敏感词"
            rules={[
              { required: true, whitespace: true, message: '请输入敏感词' },
              { max: 128, message: '敏感词最长 128 个字符' },
              {
                validator: (_, value?: string) =>
                  value && /[,，、]/u.test(value)
                    ? Promise.reject(new Error('敏感词不能包含逗号、中文逗号或顿号'))
                    : Promise.resolve(),
              },
            ]}
          >
            <Input placeholder="例如：燃气泄漏" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="历史重扫影响预览"
        open={preview !== null}
        onCancel={() => setPreview(null)}
        onOk={() => void runRescan()}
        okText="确认重扫并写入"
        cancelText="取消"
        confirmLoading={rescanning}
        okButtonProps={{ danger: true }}
      >
        {preview && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="请核对影响范围"
              description={`预览令牌仅当前管理员可使用一次，有效至 ${new Date(preview.expiresAt).toLocaleString()}。期间词表或诉求数据变化时，服务端会拒绝执行。`}
            />
            <Row gutter={[12, 12]}>
              <Col span={12}><Statistic title="扫描总数" value={preview.summary.total} /></Col>
              <Col span={12}><Statistic title="将变为敏感" value={preview.summary.wouldBecomeSensitive} /></Col>
              <Col span={12}><Statistic title="将取消敏感" value={preview.summary.wouldBecomeNonSensitive} /></Col>
              <Col span={12}><Statistic title="关键词将变化" value={preview.summary.keywordsChanged} /></Col>
              <Col span={12}><Statistic title="保持不变" value={preview.summary.unchanged} /></Col>
            </Row>
            <div>本次启用词：{preview.enabledWords.map((word) => <Tag key={word}>{word}</Tag>)}</div>
          </Space>
        )}
      </Modal>
    </div>
  );
};

const fixedCodes:Record<string,string[]>={business_type:['water','gas','lpg'],complaint_type:['complaint','consult','suggest','report','help','other','praise'],urgency_level:['normal','urgent','critical']};
const DictionaryAdmin: React.FC = () => {
    const user = useAppStore(s => s.userInfo), token = useAppStore(s => s.token);
    const authKey = JSON.stringify([token, user?.userId, user?.authorizationVersion, user?.roles, user?.permissions, user?.mustChangePassword]);
    const [active, setActive] = useState('complaint_category');
    const contextKey = JSON.stringify([authKey, active]);
    const keyRef = useRef(contextKey), epoch = useRef(0), serial = useRef(0), referenceSerial = useRef(0);
    if (keyRef.current !== contextKey) {
        keyRef.current = contextKey;
        epoch.current++;
        serial.current++;
        referenceSerial.current++;
    }
    type Owner = {
        key: string;
        epoch: number;
    };
    type ActionOwner = Owner & {
        action: number;
    };
    const actionSerial = useRef(0);
    const capture = (): Owner => ({ key: contextKey, epoch: epoch.current });
    const owns = (owner: Owner | null) => Boolean(owner && owner.key === keyRef.current && owner.epoch === epoch.current);
    const captureAction = (): ActionOwner => ({ ...capture(), action: ++actionSerial.current });
    const ownsAction = (owner: ActionOwner | null) => owns(owner) && owner!.action === actionSerial.current;
    const [typeState, setTypes] = useState<{
        key: string;
        value: DictionaryType[];
    }>({ key: authKey, value: [] });
    const types = typeState.key === authKey ? typeState.value : [];
    const [loaded, setLoaded] = useState<{
        owner: Owner;
        value: {
            type: DictionaryType;
            items: DictionaryItem[];
        };
    } | null>(null);
    const current = owns(loaded?.owner ?? null) && loaded?.value.type.code === active ? loaded.value : null;
    const [error, setError] = useState(''), [loading, setLoading] = useState(false), [editor, setEditor] = useState(false), [editing, setEditing] = useState<DictionaryItem | null>(null), [saving, setSaving] = useState(false), [typeEditor, setTypeEditor] = useState(false), [editingType, setEditingType] = useState<DictionaryType | null>(null);
    const itemOwner = useRef<(ActionOwner & {
        typeCode: string;
        typeVersion: number;
        itemVersion: number;
    }) | null>(null), typeOwner = useRef<ActionOwner | null>(null);
    const [referenceState, setReferences] = useState<{
        owner: Owner;
        value: Awaited<ReturnType<typeof dictionaryReferences>>;
    } | null>(null);
    const references = owns(referenceState?.owner ?? null) ? referenceState!.value : null;
    const [form] = Form.useForm(), [typeForm] = Form.useForm();
    const refresh = useCallback(async () => {
        const owner = { key: contextKey, epoch: epoch.current }, request = ++serial.current;
        const valid = () => owns(owner) && request === serial.current;
        setLoading(true);
        try {
            const types = await listDictionaryTypes();
            if (!valid())
                return;
            setTypes({ key: authKey, value: types });
            if (active !== 'sensitive_word') {
                const value = await listDictionaryItems(active);
                if (!valid())
                    return;
                if (value.type.code !== active)
                    throw Error('字典响应与当前选择不一致，请刷新');
                setLoaded({ owner, value });
            }
            if (valid())
                setError('');
        }
        catch (e) {
            if (valid())
                setError(errorText(e));
        }
        finally {
            if (valid())
                setLoading(false);
        }
    }, [contextKey, active, authKey]);
    useEffect(() => {
        setLoaded(null);
        setEditor(false);
        setTypeEditor(false);
        setReferences(null);
        setError('');
        setSaving(false);
        itemOwner.current = null;
        typeOwner.current = null;
        void refresh();
        return () => { epoch.current++; serial.current++; referenceSerial.current++; };
    }, [refresh]);
    const changeActive = (code: string) => { epoch.current++; serial.current++; referenceSerial.current++; setLoaded(null); setEditor(false); setTypeEditor(false); setReferences(null); setActive(code); };
    const openItem = (item: DictionaryItem | null) => {
        if (!current || current.type.code !== active)
            return;
        itemOwner.current = { ...captureAction(), typeCode: current.type.code, typeVersion: current.type.version, itemVersion: item?.version ?? 0 };
        setSaving(false);
        setEditing(item);
        form.setFieldsValue({ code: item?.code ?? '', label: item?.label ?? '', parentCode: item?.parentCode ?? null, sort: item?.sort ?? 0, status: item?.status ?? 'enabled', published: item?.published ?? false, cascadeDisable: false });
        setError('');
        setEditor(true);
    };
    const saveItem = async () => {
        const owner = itemOwner.current;
        if (!ownsAction(owner) || !current || owner!.typeCode !== active)
            return;
        try {
            const v = await form.validateFields();
            if (!ownsAction(owner))
                return;
            setSaving(true);
            await saveDictionaryItem(owner!.typeCode, { ...v, parentCode: v.parentCode ?? null, expectedVersion: owner!.itemVersion, expectedTypeVersion: owner!.typeVersion }, Boolean(editing));
            if (!ownsAction(owner))
                return;
            setEditor(false);
            await refresh();
        }
        catch (e) {
            if (ownsAction(owner) && !(e as {
                errorFields?: unknown;
            }).errorFields)
                setError(errorText(e));
        }
        finally {
            if (ownsAction(owner))
                setSaving(false);
        }
    };
    const openType = (type: DictionaryType | null) => { typeOwner.current = captureAction(); setSaving(false); setEditingType(type); typeForm.setFieldsValue({ code: type?.code ?? '', name: type?.name ?? '', status: type?.status ?? 'enabled', published: type?.published ?? false, cascadeDisable: false }); setTypeEditor(true); setError(''); };
    const saveType = async () => {
        const owner = typeOwner.current;
        if (!ownsAction(owner))
            return;
        try {
            const v = await typeForm.validateFields();
            if (!ownsAction(owner))
                return;
            setSaving(true);
            await saveDictionaryType({ ...v, expectedVersion: editingType?.version ?? 0 });
            if (!ownsAction(owner))
                return;
            setTypeEditor(false);
            if (v.code !== active)
                changeActive(v.code);
            else
                await refresh();
        }
        catch (e) {
            if (ownsAction(owner) && !(e as {
                errorFields?: unknown;
            }).errorFields)
                setError(errorText(e));
        }
        finally {
            if (ownsAction(owner))
                setSaving(false);
        }
    };
    const removeItem = (item: DictionaryItem) => {
        if (!current)
            return;
        const owner = captureAction(), typeCode = current.type.code;
        Modal.confirm({ title: '删除未发布草稿？编码以后也不能复用。', onOk: async () => { if (!ownsAction(owner))
                return; try {
                await deleteDictionaryItem(typeCode, item.code, item.version);
                if (ownsAction(owner))
                    await refresh();
            }
            catch (e) {
                if (ownsAction(owner))
                    setError(errorText(e));
            } } });
    };
    const readReferences = async (code?: string) => {
        if (!current)
            return;
        const owner = capture(), typeCode = current.type.code, request = ++referenceSerial.current;
        try {
            const value = await dictionaryReferences(typeCode, code);
            if (owns(owner) && request === referenceSerial.current)
                setReferences({ owner, value });
        }
        catch (e) {
            if (owns(owner) && request === referenceSerial.current)
                setError(errorText(e));
        }
    };
    const removeType = () => {
        if (!current)
            return;
        const owner = captureAction(), type = current.type;
        Modal.confirm({ title: '删除空草稿类型？编码以后不能复用。', onOk: async () => { if (!ownsAction(owner))
                return; try {
                await deleteDictionaryType(type.code, type.version);
                if (ownsAction(owner))
                    changeActive('complaint_category');
            }
            catch (e) {
                if (ownsAction(owner))
                    setError(errorText(e));
            } } });
    };
    const columns: ColumnsType<DictionaryItem> = [{ title: '编码', dataIndex: 'code' }, { title: '标签', dataIndex: 'label' }, { title: '父项', dataIndex: 'parentCode', render: v => v ?? '大类 / 根项' }, { title: '排序', dataIndex: 'sort' }, { title: '状态', dataIndex: 'status', render: v => <Tag>{v === 'enabled' ? '启用' : '停用'}</Tag> }, { title: '版本', dataIndex: 'version' }, { title: '发布', dataIndex: 'published', render: v => v ? '已发布' : '草稿' }, { title: '操作', render: (_, item) => <Space>{!current?.type.readOnly && <Button size="small" onClick={() => openItem(item)}>编辑条目</Button>}<Button size="small" onClick={() => void readReferences(item.code)}>引用</Button>{!item.published && !current?.type.readOnly && !current?.type.fixedCodes && <Button danger size="small" onClick={() => removeItem(item)}>删除草稿</Button>}</Space> }];
    return <div><h2>字典管理</h2><Space style={{ marginBottom: 12 }}><MasterDataImportDialog kinds={['dictionary_type', 'dictionary_item', 'category']} onImported={() => void refresh()}/><Button onClick={() => openType(null)}>新增字典类型</Button><Button onClick={() => void refresh()}>刷新字典</Button></Space>{error && !editor && !typeEditor && <Alert type="error" message={error}/>}
  <Tabs activeKey={active} onChange={changeActive} items={[...types.map(t => ({ key: t.code, label: t.name })), { key: 'sensitive_word', label: '敏感词' }]}/>
  {active === 'sensitive_word' ? <SensitiveWordManager /> : <Card loading={loading}>
   {current && <><Space wrap style={{ marginBottom: 16 }}><Tag>字典版本 {current.type.version}</Tag>{!current.type.readOnly && <><Button onClick={() => openType(current.type)}>编辑类型</Button><Button type="primary" onClick={() => openItem(null)}>新增字典项</Button>{!current.type.published && !current.type.fixedCodes && current.type.code !== 'complaint_category' && <Button danger onClick={removeType}>删除类型草稿</Button>}</>}<Button onClick={() => void readReferences()}>类型引用</Button></Space>
   {current.type.readOnly && <Alert type="info" message="状态机枚举仅供查看；状态流转由业务流程控制。"/>}{current.type.fixedCodes && <Alert type="info" message="协议编码固定，可维护合法编码的标签、排序和停用。停用仅限制新的人工选择，来源事实继续如实保留。"/>}
   <Table rowKey="itemId" columns={columns} dataSource={current.items} pagination={false}/></>}
  </Card>}
  <Modal key={contextKey + ':item:' + itemOwner.current?.action} title={editing ? '编辑字典条目' : '新增字典条目'} open={editor && ownsAction(itemOwner.current)} onCancel={() => { actionSerial.current++; setEditor(false); }} onOk={() => void saveItem()} okText="保存条目" confirmLoading={saving}>
   {error && <Alert type="error" message={error}/>}<Form form={form} layout="vertical">
    <Form.Item label="编码" name="code" rules={[{ required: true }]}>{current?.type.fixedCodes ? <Select aria-label="条目编码" disabled={Boolean(editing)} options={(fixedCodes[active] ?? []).filter(code => code === editing?.code || !current.items.some(i => i.code === code)).map(code => ({ value: code, label: code }))}/> : <Input aria-label="条目编码" disabled={Boolean(editing)}/>}</Form.Item>
    <Form.Item label="标签" name="label" rules={[{ required: true }]}><Input aria-label="条目标签"/></Form.Item>
    {!current?.type.fixedCodes && <Form.Item label="父项（不选为大类）" name="parentCode"><Select aria-label="条目父项" allowClear options={current?.items.filter(i => !i.parentCode && i.code !== editing?.code).map(i => ({ value: i.code, label: i.label }))}/></Form.Item>}
    <Form.Item label="排序" name="sort"><InputNumber aria-label="条目排序"/></Form.Item><Form.Item label="状态" name="status"><Select options={[{ value: 'enabled', label: '启用' }, { value: 'disabled', label: '停用' }]}/></Form.Item>
    <Form.Item name="published" valuePropName="checked"><Checkbox disabled={editing?.published}>发布后禁止物理删除</Checkbox></Form.Item><Form.Item name="cascadeDisable" valuePropName="checked"><Checkbox>明确确认：停用父项时同时停用所有小类</Checkbox></Form.Item>
   </Form>
  </Modal>
  <Modal key={contextKey + ':type:' + typeOwner.current?.action} title="字典类型" open={typeEditor && ownsAction(typeOwner.current)} onCancel={() => { actionSerial.current++; setTypeEditor(false); }} onOk={() => void saveType()} okText="保存类型" confirmLoading={saving}>{error && <Alert type="error" message={error}/>}<Form form={typeForm} layout="vertical"><Form.Item label="类型编码" name="code" rules={[{ required: true }]}><Input disabled={Boolean(editingType)}/></Form.Item><Form.Item label="类型名称" name="name" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="状态" name="status"><Select options={[{ value: 'enabled', label: '启用' }, { value: 'disabled', label: '停用' }]}/></Form.Item><Form.Item name="published" valuePropName="checked"><Checkbox disabled={editingType?.published}>发布类型</Checkbox></Form.Item><Form.Item name="cascadeDisable" valuePropName="checked"><Checkbox>明确确认停用该类型的全部条目</Checkbox></Form.Item></Form></Modal>
  <Modal key={contextKey} title="可见引用（最多100条诉求）" open={references !== null} onCancel={() => setReferences(null)} footer={null}><p>子项：{references?.children.join(' / ') || '无'}</p><Table rowKey="complaintId" dataSource={references?.complaints ?? []} columns={[{ title: '诉求编号', dataIndex: 'complaintNo' }]} pagination={false}/><p>列表按当前数据范围显示；历史或范围外引用也会阻止删除。</p></Modal>
 </div>;
};

const DictManager:React.FC=()=>{const access=usePermissionAccess('system.dict.manage');return access.can?<DictionaryAdmin/>:<Alert type="error" message="无权限，请联系管理员"/>;};
export default DictManager;
