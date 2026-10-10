import React from 'react';
import {Alert,Form,Input,Select,Space,Typography} from 'antd';
import type {FormInstance} from 'antd';
import type {LocationCorrectionInput,LocationCorrectionOptions} from '../types/locationCorrection';
export interface LocationDraft {districtCode?:string|null;address?:string;lng?:string;lat?:string;adminGridCode?:string|null;communityCode?:string|null;coordinateSystem?:'WGS84'|'unknown'|null;coordinateSource?:string;basis?:string}
function coordinate(value:string|undefined,min:number,max:number):number|null {
 if(!value?.trim())return null;const result=Number(value);if(!Number.isFinite(result)||result<min||result>max)throw new Error('请输入有效经纬度');return result;
}
export function locationDraftInput(complaintId:string,expectedVersion:number,value:LocationDraft):LocationCorrectionInput {
 const longitude=coordinate(value.lng,-180,180),latitude=coordinate(value.lat,-90,90);
 if((longitude===null)!==(latitude===null))throw new Error('经纬度必须成对填写或清空');
 return {complaintId,expectedVersion,districtCode:value.districtCode??null,address:value.address?.trim()||null,longitude,latitude,adminGridCode:value.adminGridCode??null,communityCode:value.communityCode??null,
  coordinateSystem:longitude===null?null:value.coordinateSystem??'unknown',coordinateSource:longitude===null?null:value.coordinateSource?.trim()||'人工录入，坐标系未核实',basis:value.basis?.trim()||''};
}
export const LocationCorrectionFields:React.FC<{form:FormInstance;options:LocationCorrectionOptions|null;optionsError:string|null}>=({form,options,optionsError})=>{
 const district=Form.useWatch('districtCode',form),admin=Form.useWatch('adminGridCode',form),lng=Form.useWatch('lng',form),lat=Form.useWatch('lat',form),crs=Form.useWatch('coordinateSystem',form);
 const numericRule=(min:number,max:number)=>({validator:async(_:unknown,value:string)=>{coordinate(value,min,max);}});
 return <>
  <Alert type="info" showIcon message="区划、地址、坐标、行政网格和小区一起核对" description="地图不可用时可人工录入。坐标系未核实仍可凭人工依据保存，但不会标为已完成空间复核；清空坐标时须同时清空经纬度。" style={{marginBottom:12}}/>
  {optionsError&&<Alert type="warning" message={'区划及关联选择加载失败：'+optionsError+'。可保留现有关系，稍后重试。'}/>}
  <Form.Item name="districtCode" label="归属区划"><Select aria-label="位置组区划" allowClear options={options?.districts.map(d=>({value:d.code,label:d.name+'（'+d.code+'）'}))} onChange={()=>form.setFieldsValue({adminGridCode:null,communityCode:null})}/></Form.Item>
  <Form.Item name="address" label="核实后的地址"><Input aria-label="位置组地址" maxLength={500} placeholder="人工核对后填写地址；留空表示清空"/></Form.Item>
  <Space style={{display:'flex'}} align="start">
   <Form.Item name="lng" label="经度" rules={[numericRule(-180,180)]}><Input aria-label="位置组经度"/></Form.Item>
   <Form.Item name="lat" label="纬度" rules={[numericRule(-90,90)]}><Input aria-label="位置组纬度"/></Form.Item>
  </Space>
  <Form.Item name="adminGridCode" label="行政网格"><Select aria-label="位置组行政网格" allowClear options={options?.adminGrids.filter(a=>a.districtCode===district).map(a=>({value:a.code,label:a.name+'（'+a.code+'）'}))} onChange={()=>form.setFieldsValue({communityCode:null})}/></Form.Item>
  <Form.Item name="communityCode" label="小区"><Select aria-label="位置组小区" allowClear options={options?.communities.filter(c=>c.adminGridCode===admin).map(c=>({value:c.code,label:c.name+'（'+c.code+'）'}))}/></Form.Item>
  <Form.Item name="coordinateSystem" label="坐标系状态"><Select aria-label="位置组坐标系" disabled={!lng?.trim()&&!lat?.trim()} options={[{value:'unknown',label:'未核实（不进行空间判定）'},{value:'WGS84',label:'全球大地坐标系（操作者声明并提供来源）'}]} onChange={value=>{if(value==='WGS84')form.setFieldsValue({coordinateSource:''});}}/></Form.Item>
  <Form.Item name="coordinateSource" label="坐标来源说明" rules={crs==='WGS84'?[{required:true,whitespace:true,message:'请说明坐标资料来源；此项记录为操作者声明'}]:[]}><Input aria-label="位置组坐标来源" maxLength={500} disabled={!lng?.trim()&&!lat?.trim()} placeholder="来源或核验方式；不把操作者声明当作地图认证"/></Form.Item>
  <Typography.Text type="secondary">空间复核采用保存当日生效覆盖，不代表诉求发生时的历史关系。同名或重叠候选请按稳定编码人工选择。</Typography.Text>
  <Form.Item name="basis" label="核对依据" rules={[{required:true,whitespace:true,message:'请填写人工核对依据'}]} style={{marginTop:12}}><Input.TextArea aria-label="位置组依据" maxLength={500} rows={2} placeholder="例如：现场核对、来电确认及资料来源"/></Form.Item>
 </>;
};
