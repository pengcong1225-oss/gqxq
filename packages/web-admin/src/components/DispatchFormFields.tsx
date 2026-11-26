import { DatePicker, Form, Input } from 'antd';
import type { Dayjs } from 'dayjs';

export interface DispatchFormValues {
  targetEnterpriseCode: string;
  targetEnterpriseName: string;
  deadline: Dayjs;
  requirement: string;
  reason?: string;
}

export default function DispatchFormFields() {
  const trim = (value?: string) => value?.trim();
  return (
    <>
      <Form.Item name="deadline" label="企业填报截止时间" rules={[{ required: true, message: '请选择企业填报截止时间' }]}>
        <DatePicker showTime style={{ width: '100%' }} placeholder="选择日期和时间" />
      </Form.Item>
      <Form.Item
        name="requirement"
        label="企业处置说明"
        rules={[
          { required: true, whitespace: true, message: '请填写企业处置说明' },
          { max: 1000, transform: trim, message: '企业处置说明不能超过 1000 字符' },
        ]}
      >
        <Input.TextArea rows={2} placeholder="填写需要企业核实、处置和反馈的具体事项" />
      </Form.Item>
    </>
  );
}
