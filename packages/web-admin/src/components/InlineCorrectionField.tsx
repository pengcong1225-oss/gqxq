import CategorySelector from './CategorySelector';
import {getDictItems} from '../api/dicts';
import type {DictItem} from '../types/api';
import type {CategoryRef} from '../types/masterData';
import React, { useEffect, useState } from 'react';
import { Button, Input, Select, Space, Typography } from 'antd';
import type { CorrectionItem, EnterpriseOption } from '../types/api';
import { correctionEffectiveText } from '../api/corrections';

export interface InlineCorrectionDraft { value: string; basis: string }

export interface InlineCorrectionFieldProps {
  item: CorrectionItem;
  enterpriseOptions: EnterpriseOption[];
  enterpriseLoading: boolean;
  enterpriseError?: string | null;
  disabled: boolean;
  saving: boolean;
  onSearchEnterprises: (keyword: string) => void;
  onSave: (value: string, basis: string) => void;
  draft?: InlineCorrectionDraft;
  onDraftChange?: (change: Partial<InlineCorrectionDraft>) => void;
}

/** 待处理字段就地录入；只有点击“保存该项”才交给调用方写入。 */
const InlineCorrectionField: React.FC<InlineCorrectionFieldProps> = ({
  item, enterpriseOptions, enterpriseLoading, enterpriseError, disabled, saving,
  onSearchEnterprises, onSave, draft, onDraftChange,
}) => {
  const [natureOptions,setNatureOptions]=useState<DictItem[]>([]);
  const [natureError,setNatureError]=useState('');
  useEffect(()=>{if(item.fieldName==='complaint_type')getDictItems('complaint_type').then(setNatureOptions).catch(e=>setNatureError(e.message??'诉求性质加载失败'));},[item.fieldName]);
  const isEnterprise = item.fieldName === 'enterprise_name';
  const label = item.fieldLabel ?? item.fieldName;
  const [localValue, setValue] = useState(isEnterprise ? '' : correctionEffectiveText(item));
  const [localBasis, setBasis] = useState(item.basis ?? '');
  const value = draft?.value ?? localValue;
  const basis = draft?.basis ?? localBasis;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(isEnterprise ? '' : correctionEffectiveText(item));
    setBasis(item.basis ?? '');
    setError(null);
  // A version-conflict refresh must keep this field's unsent value and basis.
  }, [item.correctionId, isEnterprise]);

  const changeValue = (next: string) => {
    setValue(next);
    setError(null);
    onDraftChange?.({ value: next });
  };
  const changeBasis = (next: string) => {
    setBasis(next);
    onDraftChange?.({ basis: next });
  };

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(isEnterprise ? '请先从企业主数据选择责任单位' : '请填写纠偏后的取值');
      return;
    }
    if (!isEnterprise && trimmed === correctionEffectiveText(item)) {
      setError('取值与原值相同；如已核实无误，请使用“核验无误”');
      return;
    }
    setError(null);
    onSave(trimmed, basis.trim());
  };

  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {item.fieldName==='formal_category'? <CategorySelector value={(()=>{try{return value?JSON.parse(value) as CategoryRef:null;}catch{return null;}})()} onChange={ref=>changeValue(ref?JSON.stringify(ref):'')} disabled={disabled}/>:item.fieldName==='complaint_type'? <><Select aria-label={'纠偏后取值：'+label} value={value||undefined} options={natureOptions} disabled={disabled||Boolean(natureError)} onChange={changeValue}/>{natureError&&<Typography.Text type='danger'>{natureError}</Typography.Text>}</>:isEnterprise ? (
        <Select
          aria-label={'纠偏后取值：' + label}
          value={value || undefined}
          showSearch
          allowClear
          filterOption={false}
          disabled={disabled}
          loading={enterpriseLoading}
          placeholder="搜索并选择登记企业"
          onSearch={onSearchEnterprises}
          onOpenChange={(open) => { if (open && enterpriseOptions.length === 0) onSearchEnterprises(''); }}
          onChange={(next) => changeValue(next ?? '')}
          options={enterpriseOptions.map((enterprise) => ({
            value: enterprise.enterpriseCode,
            label: enterprise.enterpriseName + '（' + enterprise.enterpriseCode + '）',
          }))}
          style={{ width: '100%' }}
        />
      ) : item.fieldName === 'summary' || item.fieldName === 'disposal_result' ? (
        <Input.TextArea
          aria-label={'纠偏后取值：' + label}
          value={value}
          onChange={(event) => changeValue(event.target.value)}
          disabled={disabled}
          autoSize={{ minRows: 2, maxRows: 4 }}
          placeholder="在此填写核实后的内容"
        />
      ) : (
        <Input
          aria-label={'纠偏后取值：' + label}
          value={value}
          onChange={(event) => changeValue(event.target.value)}
          disabled={disabled}
          placeholder="在此填写核实后的取值"
        />
      )}
      <Input
        aria-label={'核对依据：' + label}
        value={basis}
        onChange={(event) => changeBasis(event.target.value)}
        disabled={disabled}
        placeholder="核对依据（可选）"
      />
      {enterpriseError && isEnterprise ? <Typography.Text type="danger">企业主数据加载失败：{enterpriseError}</Typography.Text> : null}
      {error ? <Typography.Text type="danger" role="alert">{error}</Typography.Text> : null}
      <Button type="primary" size="small" loading={saving} disabled={disabled || (isEnterprise && Boolean(enterpriseError))} onClick={save}>
        保存该项
      </Button>
    </Space>
  );
};

export default InlineCorrectionField;
