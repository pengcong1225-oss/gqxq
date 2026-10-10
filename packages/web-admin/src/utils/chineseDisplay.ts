/** Presentation only: never feed translated values back into API requests. */
const dictionaries: Record<string, Record<string, string>> = {
 business_type:{water:'供水',gas:'燃气',lpg:'液化气'},
 complaint_type:{complaint:'投诉',consult:'咨询',suggest:'建议',report:'举报',help:'求助',other:'其他',praise:'表扬'},
 urgency_level:{normal:'一般',urgent:'紧急',critical:'特急'},
 source_system:{local_acceptance:'本地验收来源',local_excel:'本地表格导入',yijiejiuban:'宜接就办',yijie:'宜接就办',yjjb:'宜接就办',zhuxin_platform:'填报平台'},
 source_channel:{hotline:'热线',web:'网页端',grid:'网格上报',phone:'电话',telephone:'电话',wechat:'微信',dingtalk:'钉钉',api:'接口接入',manual:'人工录入',excel:'表格导入',excel_import:'表格导入',local_excel:'表格导入',local_acceptance:'本地验收渠道'},
 source_event_status:{unknown:'未接入',accepted:'已受理',processing:'处置中',completed:'来源已办结',closed:'来源已关闭'},
 supervision_status:{none:'未交办',pending_match:'待匹配单位',pending:'待推送',pushed:'已推送待签收',accepted:'企业已签收',processing:'企业办理中',returned:'审批退回待补正',completed:'填报审批最终通过',rejected:'审批不同意',archived:'已归档',cancelled:'已受控撤销'},
 reporting_status:{not_started:'未推送',pushed:'已推送',accepted:'企业已签收',submitted:'企业已提交',returned:'退回补正',approved:'最终同意',rejected:'审批不同意'},
 correction_status:{none:'无需纠偏',pending:'待纠偏',corrected:'已纠偏',failed:'纠偏失败',confirmed:'已确认',resolved:'已处理'},
 dispatch_type:{auto:'自动交办',manual:'人工交办'},trigger_type:{sensitive_word:'敏感词命中',manual_flag:'人工标记'},
 role:{admin:'系统管理员',handler:'业务经办',readonly:'只读查看'},
 report_todo_status:{pending:'待处理',in_progress:'处理中',done:'已完成'},
 event_type:{TASK_ACCEPTED:'已签收',TASK_SUBMITTED:'已提交',TASK_RETURNED:'待修正',TASK_REJECTED:'已否决',TASK_APPROVED:'最终通过',TASK_PROGRESS:'审批推进'},
};
const labels:Record<string,string>={
 auto:'自动交办',sensitive_word:'敏感词命中',manual_flag:'人工标记',in_progress:'处理中',done:'已完成',FeatureCollection:'边界集合',Feature:'边界要素',Polygon:'多边形',MultiPolygon:'多重多边形',docx:'文档',xlsx:'表格',create:'新增',created:'已新增',update:'更新',updated:'已更新',unchanged:'不变',skip:'跳过',skipped:'已跳过',duplicate:'重复',error:'校验失败',
 succeeded:'成功',success:'成功',failed:'失败',rejected:'已拒绝',unknown:'未知',pending:'待处理',queued:'排队中',sending:'发送中',running:'处理中',generating:'生成中',
 applied:'已应用',ignored:'已忽略',expired:'已过期',draft:'草稿',maintained:'已发布',published:'已发布',confirmed:'已确认',enabled:'启用',disabled:'停用',active:'正常',inactive:'停用',locked:'已锁定',cancelled:'已撤销',archived:'已归档',
 accepted:'已签收',processing:'办理中',completed:'已完成',closed:'已关闭',submitted:'已提交',approved:'已同意',returned:'已退回',pushed:'已推送',not_started:'未开始',none:'无',
 internal:'内部账号',external:'外部账号',local:'本地账号',dingtalk:'钉钉',all:'全域',restricted:'限定范围',
 '来源导出 metadata.坐席满意度':'来源坐席评价记录',received_fallback:'平台接收时间（来源时间不可用）',unavailable:'不可用',available:'可用',withheld:'暂未展示',replay:'重复请求',conflict:'存在冲突',auth_failed:'身份校验失败',payload_too_large:'数据超过大小限制',validation_failed:'校验未通过',timeout:'请求超时',network_error:'连接失败',
 green:'绿色',blue:'蓝色',yellow:'黄色',orange:'橙色',red:'红色',lower:'下界',upper:'上界',null:'不设等级',
 UNCONFIGURED:'尚未配置规则',POLICY_INCOHERENT:'规则配置相互冲突',POLICY_INCOMPLETE:'规则配置尚未完整',CATEGORY_SELECTION_REQUIRED:'请先选择类别',ZERO_UNCLASSIFIED:'零值不设等级',BELOW_FIRST:'低于首档，不设等级',ABOVE_TOP:'高于最高界，不设等级',
 PASSWORD_CHANGE_REQUIRED:'须先完成首次口令设置',READONLY_WRITE_DENIED:'只读账号无法修改',UNREGISTERED_ENDPOINT:'此功能尚未开放',MISSING_PERMISSION:'未取得所需权限',unknown_user:'账号不存在',bad_password:'口令不正确',disabled_user:'账号已停用',
 source:'来源系统',source_snapshot:'来源快照',manual:'人工录入',manual_correction:'人工纠偏',operator_declared:'操作者声明',operator:'操作者',source_agent:'来源坐席',source_payload:'来源原始记录',effective:'当前有效值',snapshot:'入库快照',
 satisfied:'满意',dissatisfied:'不满意',unevaluated:'未评价',not_evaluated:'未评价',WGS84:'全球大地坐标系',
 ledger:'诉求总账',analysis:'分析库',current:'当前有效值',category:'正式分类',business:'业务类型',nature:'诉求类型',district:'行政区划',enterprise:'企业',
 received_at:'平台接收时间',source_reported_at:'来源上报时间',source_updated_at:'来源更新时间',confirmed_at:'纠偏确认时间',
 enterprise_mapping:'来源部门映射',department_mapping:'来源部门映射',household:'服务户数',dictionary_type:'字典类型',dictionary_item:'字典条目',admin_grid:'行政网格',community:'小区',service_grid:'企业服务网格',grid_coverage:'覆盖关系',grid_boundary:'行政网格边界',
 shanghai_inclusive:'按自然日（含首尾日）',exact_only:'仅匹配当前分类',minor_then_major:'小类优先，未匹配时使用大类',query_end:'查询结束日',
 enqueue:'等待发送',delivery:'外发处理',revise:'修订',conclude:'确认结论',
};
export const actionLabels:Record<string,string>={
 LOGIN:'登录',LOGIN_FAILED:'登录失败',USER_CREATE:'创建账号',USER_UPDATE:'更新账号',USER_SCOPE_UPDATE:'调整账号数据范围',PASSWORD_RESET:'重置口令',PASSWORD_CHANGE:'修改口令',ROLE_CREATE:'创建角色',ROLE_UPDATE:'更新角色权限',ACCESS_DENIED:'权限拒绝',
 COMPLAINT_IMPORT_COMMIT:'导入诉求',MASTER_IMPORT_COMMIT:'导入基础数据',MASTER_IMPORT_FAILED:'基础数据导入失败',MASTER_IMPORT_ERRORS_DOWNLOAD:'下载导入错误明细',
 FOLLOWUP_CREATE:'登记回访',FOLLOWUP_REVISE:'修订回访',FOLLOWUP_CONCLUDE:'确认回访结论',REPORT_CREATE:'创建报告',REPORT_RETRY:'重试生成报告',REPORT_GENERATE:'生成报告',REPORT_DOWNLOAD:'下载报告',
 HEAT_DRAFT_SAVE:'保存热力规则草稿',HEAT_RULE_PUBLISH:'发布热力规则',SENSITIVE_WORD_CREATE:'新增敏感词',SENSITIVE_WORD_UPDATE:'修改敏感词',SENSITIVE_WORD_RESCAN:'重新检查敏感词',
 SERVICE_GRID_REGISTER:'登记服务网格',SERVICE_GRID_SAVE:'保存服务网格',ADMIN_GRID_SAVE:'保存行政网格',COMMUNITY_SAVE:'保存小区',ENTERPRISE_SAVE:'保存企业档案',ENTERPRISE_HOUSEHOLDS_SAVE:'维护企业服务户数',ENTERPRISE_MAPPING_SAVE:'维护来源部门映射',
 DICTIONARY_TYPE_SAVE:'保存字典类型',DICTIONARY_ITEM_SAVE:'保存字典条目',DICTIONARY_TYPE_DELETE:'删除字典类型草稿',DICTIONARY_ITEM_DELETE:'删除字典条目草稿',CATEGORY_REVISE:'调整诉求分类',CORRECTION_LOCATION_GROUP:'纠偏位置信息',CORRECTION_GENERATE:'生成纠偏项',CORRECTION_CONFIRM:'确认纠偏',CORRECTION_REJECT:'拒绝纠偏',CORRECTION_RESOLVE:'完成纠偏',ANALYSIS_INCLUDED:'纳入分析库',
 DISPATCH_CREATE:'创建交办',DISPATCH_CANCEL:'撤销交办',DISPATCH_PUSH:'推送交办',DISPATCH_ARCHIVE:'归档交办',ASSIGN_ENTERPRISE:'分配责任企业',COMPLAINT_CLOSE:'办结诉求',COMPLAINT_DISPOSITION:'登记处置结果',SOURCE_DOCUMENT_READ:'查看来源原始记录',
 CALLBACK_APPLIED:'应用审批回调',CALLBACK_IGNORED:'忽略审批回调',CALLBACK_CONFIG_ERROR:'审批回调配置错误',CALLBACK_AUTH_FAILED:'审批回调身份校验失败',CALLBACK_REJECTED:'拒绝审批回调',CALLBACK_DUPLICATE:'重复审批回调',
 INTAKE_CREATE:'接收诉求',INTAKE_REJECTED:'拒绝接收诉求',INTAKE_DUPLICATE_SAME:'重复接收诉求',INTAKE_REDELIVERY:'更新来源诉求',LOCATION_CLUE_BACKFILL_ROW:'补充位置线索',
};
export function chineseLabel(value:unknown,domain?:string,fallback='未知状态'):string {
 if(value===null||value===undefined||value==='')return '—';
 const text=String(value);
 return (domain?dictionaries[domain]?.[text]:undefined)??labels[text]??actionLabels[text]??(domain==='role'?'其他角色':/[\u3400-\u9fff]/.test(text)?text:fallback);
}
export function namedLabel(code:unknown,name:unknown,domain?:string):string {
 return typeof name==='string'&&/[\u3400-\u9fff]/.test(name)?name:chineseLabel(code,domain);
}
export function sourceLabel(value:unknown,kind:'system'|'channel'):string {
 if(value===null||value===undefined||value==='')return '—';
 const text=String(value).trim();if(!text)return '—';
 return dictionaries[kind==='system'?'source_system':'source_channel'][text.toLowerCase()]??(/[\u3400-\u9fff]/.test(text)?text:kind==='system'?'来源系统待核实':'来源渠道待核实');
}
const fields:Record<string,string>={
 before:'变更前',after:'变更后',oldValue:'原值',newValue:'新值',effectiveValue:'当前有效值',fieldName:'字段',fieldLabel:'字段名称',changed:'变更字段',changes:'字段变化',decisions:'处理结论',
 status:'状态',state:'状态',statusBefore:'原状态',statusAfter:'新状态',fromStatus:'原状态',toStatus:'新状态',dispatchStatusBefore:'原交办状态',dispatchStatusAfter:'新交办状态',supervisionStatusBefore:'原督办状态',supervisionStatusAfter:'新督办状态',
 userId:'用户编号',targetUserId:'目标用户编号',username:'用户名',realName:'姓名',operator:'操作人',operatorId:'操作人编号',operatorName:'操作人姓名',roles:'角色',role:'角色',roleCode:'角色',permissionCodes:'功能权限',accountType:'账号类型',enabled:'启用',builtIn:'内置',passwordSet:'已设置口令',forceChange:'首次登录设置口令',
 name:'名称',label:'名称',code:'业务编码',kind:'类型',type:'类型',typeCode:'字典类型',itemCode:'字典条目',parentCode:'父项',sort:'排序',published:'发布状态',verified:'已核验',rules:'数据范围规则',enterpriseCodes:'企业范围',districtCodes:'区划范围',
 complaintId:'诉求编号',complaintNo:'诉求单号',sourceId:'来源案件编号',sourceSystem:'来源系统',sourceChannel:'来源渠道',source:'来源渠道',sourceDepartmentCode:'来源部门编码',title:'标题',content:'诉求内容',address:'地址',correctedAddress:'纠偏地址',districtCode:'区划编码',districtName:'区划名称',
 businessType:'业务类型',complaintType:'诉求类型',urgencyLevel:'紧急程度',isSensitive:'敏感诉求',sensitiveKeywords:'敏感词',enterpriseCode:'企业编码',enterpriseName:'企业名称',disposalResult:'处置结果',
 majorCode:'大类编码',minorCode:'小类编码',oldMajorCode:'原大类编码',oldMinorCode:'原小类编码',formalCategory:'正式分类',category:'分类',dictionaryVersion:'字典版本',oldDictionaryVersion:'原字典版本',
 version:'版本',editVersion:'记录版本',scopeVersion:'数据范围版本',authorizationVersion:'权限版本',templateVersion:'模板版本',templateCode:'报告模板',previewVersion:'预览版本',publishedVersion:'发布版本',ruleId:'规则编号',ruleVersion:'规则版本',ruleConfidence:'识别可信度',policyId:'政策编号',policyVersion:'政策版本',
 validFrom:'生效日期',validTo:'失效日期',effectiveFrom:'生效日期',createdAt:'创建时间',updatedAt:'更新时间',receivedAt:'接收时间',sourceReportedAt:'来源上报时间',sourceUpdatedAt:'来源更新时间',closedAt:'办结时间',completedAt:'完成时间',expiresAt:'有效期',
 total:'总行数',duplicates:'重复行数',created:'新增数量',updated:'更新数量',unchanged:'未变化数量',skipped:'跳过数量',itemCount:'条目数',writtenBack:'已写回',analysisEntered:'已纳入分析',analysisIncluded:'已纳入分析',analysisId:'分析记录编号',closedInSystem:'平台已办结',
 batchId:'批次编号',requestId:'请求编号',assignmentId:'交办编号',taskId:'任务编号',eventId:'事件编号',eventType:'审批进度',approvalConclusion:'审批结论',reportingStatus:'填报状态',supervisionStatus:'督办状态',sourceEventStatus:'来源状态',correctionStatus:'纠偏状态',deliveryState:'推送状态',syncStatus:'同步状态',externalStatus:'填报状态',attempts:'尝试次数',stage:'阶段',operation:'操作',
 reason:'原因',reasonCode:'原因',failureReason:'失败原因',basis:'依据',message:'说明',description:'说明',result:'结果',contentHash:'内容摘要',byteLength:'文件大小',format:'文件格式',fence:'任务版本',
 followupId:'回访编号',contacted:'已接通',evaluationCode:'评价',provenance:'信息来源',provenanceKind:'信息来源',
 features:'边界要素',properties:'附加属性',coordinates:'坐标',sourcePayload:'来源原始内容',sourceFields:'来源字段',sourcePayloadHash:'原始内容摘要',metadata:'来源附加信息',reportedAt:'上报时间',occurredAt:'发生时间',overtimeFlag:'超期情况',
 locationLng:'经度',locationLat:'纬度',lng:'经度',lat:'纬度',adminGridCode:'行政网格编码',communityCode:'小区编码',adminGridCodes:'行政网格',communityCodes:'小区',adminGridCount:'行政网格数量',communityCount:'小区数量',hasGeometry:'已配置边界',geometry:'网格边界',geometrySource:'边界来源',coordinateSystem:'坐标系',locationCoordinateSystem:'坐标系',coordinateSource:'坐标来源',locationCoordinateSource:'坐标来源',spatialStatus:'空间核验状态',spatialReason:'空间核验说明',validationDate:'核验日期',coverageEvidence:'覆盖依据',sources:'来源说明',households:'服务户数',closedVersion:'已结束版本',
 enterpriseDisposalResult:'企业处置结果',handlingResult:'办理结果',handlingOpinion:'办理意见',opinion:'意见',summary:'摘要',attachments:'附件',fileName:'文件名',size:'大小',submissionVersion:'提交版本',eventSequence:'审批顺序',
 anchor:'系数锚点',endpointOwner:'端点归属',zero:'零值处理',belowFirst:'首档以下',top:'最高界以上',day:'天数计算',classFallback:'类目回退',noRule:'无规则行为',ruleSelection:'规则日期',policy:'规则配置',coefficients:'五档系数',
};
const normalize=(key:string)=>key.replace(/_/g,'').toLowerCase();
const fieldNames=Object.fromEntries(Object.entries(fields).map(([key,value])=>[normalize(key),value]));
export function fieldLabel(key:unknown):string {
 const text=String(key??'');return fieldNames[normalize(text)]??(/[\u3400-\u9fff]/.test(text)?text:'其他信息');
}
export function fieldNameLabel(key:string,name?:string|null):string {
 return name&&/[\u3400-\u9fff]/.test(name)?name:fieldLabel(key);
}
export function systemMessage(value:unknown,fallback='请求失败，请稍后重试'):string {
 const text=typeof value==='string'?value:'';
 if(/timeout|timed out/i.test(text))return '请求超时，请稍后重试';
 if(/network error/i.test(text))return '无法连接服务，请检查网络后重试';
 return /[\u3400-\u9fff]/.test(text)?text:fallback;
}
const enumDomains:Record<string,string>={sourceSystem:'source_system',dispatchStatusBefore:'supervision_status',dispatchStatusAfter:'supervision_status',supervisionStatusBefore:'supervision_status',supervisionStatusAfter:'supervision_status',businessType:'business_type',complaintType:'complaint_type',urgencyLevel:'urgency_level',sourceEventStatus:'source_event_status',supervisionStatus:'supervision_status',reportingStatus:'reporting_status',correctionStatus:'correction_status',dispatchType:'dispatch_type',triggerType:'trigger_type',role:'role',roles:'role',roleCode:'role',eventType:'event_type'};
const domains=Object.fromEntries(Object.entries(enumDomains).map(([key,value])=>[normalize(key),value]));
const enumKeys=new Set(['type','format','status','state','statusBefore','statusAfter','fromStatus','toStatus','dispatchStatusBefore','dispatchStatusAfter','supervisionStatusBefore','supervisionStatusAfter','accountType','deliveryState','syncStatus','externalStatus','evaluationCode','approvalConclusion','provenance','provenanceKind','kind','stage','operation','coordinateSystem','locationCoordinateSystem','spatialStatus','reasonCode','anchor','endpointOwner','zero','belowFirst','top','day','classFallback','noRule','ruleSelection'].map(normalize));
const permissionNames:Record<string,string>={
 'followup.create':'人工回访登记及本人更正','followup.conclude':'主管独立回访结论','complaint.read':'诉求查询','complaint.assign':'责任单位匹配','complaint.import':'诉求 Excel 导入（另需诉求查询及全域范围）','complaint.disposition':'诉求归库','complaint.correct':'诉求纠偏','complaint.close':'本系统办结','complaint.source_sync':'来源状态回填','enterprise.read':'企业查询','enterprise.manage':'企业维护','dashboard.read':'大屏查询','statistics.read':'候选统计查询（另需数据集与明细权限）','dict.read':'字典查询','dispatch.read':'交办查询及填报材料','dispatch.create':'创建交办','dispatch.cancel':'撤销交办','dispatch.push':'推送交办','dispatch.reconcile':'交办核对','dispatch.archive':'交办归档','analysis.read':'分析查询','report.read':'报告查询','report.generate':'报告生成','report.download':'报告下载','report.retry':'报告重试','source_document.read':'来源文档查询','source_status.read':'来源状态查询','grid.read':'网格查询','grid.manage':'网格维护','shutdown.read':'停供查询','pipeline.read':'施工查询','heatmap.read':'热力图查询','heatmap.manage':'热力草稿与规则发布',
 'system.users.manage':'平台账号管理','system.roles.manage':'角色授权管理','system.audit.read':'审计查询','system.dict.manage':'字典维护','system.address.backfill':'地址候选补提取','system.integration.manage':'旧集成管理','masterdata.import':'基础数据导入（另需目标维护权限与范围）'};
export function fieldValue(key:string,value:unknown):string {
 if(value===null||value===undefined||value==='')return '—';
 if(typeof value==='boolean')return value?'是':'否';
 const normalized=normalize(key);
 if(normalized==='sourcesystem')return sourceLabel(value,'system');
 if(normalized==='sourcechannel'||normalized==='source')return sourceLabel(value,'channel');
 if(normalized==='status'&&(value===1||value===0))return value===1?'启用':'停用';
 if(normalized==='formalcategory'&&typeof value==='string'){try{return detailLines(JSON.parse(value));}catch{return '分类信息待核对';}}
 if(normalized==='failurereason')return systemMessage(value,'处理失败，请稍后重试');
 if(normalized==='fieldname')return fieldLabel(value);
 if(normalized==='changed')return fieldLabel(value);
 if(normalized==='permissioncodes')return permissionNames[String(value)]??'其他功能权限';
 if(domains[normalized]||enumKeys.has(normalized))return chineseLabel(value,domains[normalized],normalized.includes('status')||normalized==='state'?'未知状态':'其他配置');
 return String(value);
}
/** Render the authorized response as Chinese field/value lines, without mutating it. */
export function detailLines(value:unknown,key='',depth=0):string {
 if(depth>12)return '详情层级过多';
 if(Array.isArray(value))return value.map((entry,index)=>typeof entry==='object'&&entry!==null?`第 ${index+1} 项：\n${detailLines(entry,key,depth+1)}`:fieldValue(key,entry)).join('、')||'—';
 if(value&&typeof value==='object'){
  const obj=value as Record<string,unknown>;
  return Object.entries(obj).map(([field,entry])=>{
   const context=['oldValue','newValue','effectiveValue'].includes(field)&&typeof obj.fieldName==='string'?obj.fieldName:field;
   return `${fieldLabel(field)}：${detailLines(entry,context,depth+1)}`;
  }).join('\n')||'—';
 }
 return fieldValue(key,value);
}
