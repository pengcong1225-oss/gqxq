const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// ==================== Mock Data ====================

const districts = ['西陵区', '伍家岗区', '点军区', '猇亭区', '夷陵区', '宜都市', '枝江市', '当阳市', '远安县', '兴山县', '秭归县', '长阳县', '五峰县'];

const companies = [
  { id: 1, name: '宜昌市供水总公司', shortName: '市供水公司', businessType: 'water', contactPerson: '张三', contactPhone: '13900000001', serviceArea: '西陵区、伍家岗区', status: 1 },
  { id: 2, name: '点军区供水有限公司', shortName: '点军供水', businessType: 'water', contactPerson: '李四', contactPhone: '13900000002', serviceArea: '点军区', status: 1 },
  { id: 3, name: '夷陵区水务公司', shortName: '夷陵水务', businessType: 'water', contactPerson: '王五', contactPhone: '13900000003', serviceArea: '夷陵区', status: 1 },
  { id: 4, name: '宜昌中燃城市燃气有限公司', shortName: '宜昌中燃', businessType: 'gas', contactPerson: '赵六', contactPhone: '13900000004', serviceArea: '全市', status: 1 },
  { id: 5, name: '宜昌华润燃气有限公司', shortName: '华润燃气', businessType: 'gas', contactPerson: '钱七', contactPhone: '13900000005', serviceArea: '西陵区、伍家岗区', status: 1 },
  { id: 6, name: '夷陵区燃气有限公司', shortName: '夷陵燃气', businessType: 'gas', contactPerson: '孙八', contactPhone: '13900000006', serviceArea: '夷陵区', status: 1 },
  { id: 7, name: '宜昌蓝天气体有限公司', shortName: '蓝天气体', businessType: 'lpg', contactPerson: '周九', contactPhone: '13900000007', serviceArea: '全市', status: 1 },
];

const complaintTypes = ['投诉', '咨询', '建议', '举报'];
const urgencyLevels = ['一般', '紧急', '特急'];
const sources = ['市民之家', '12345热线', '移动端', '网页端'];
const businessTypes = ['water', 'gas'];

function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateComplaint(id) {
  const businessType = randomItem(businessTypes);
  const source = randomItem(sources);
  const date = new Date(Date.now() - randomInt(0, 30 * 24 * 3600 * 1000));
  const district = randomItem(districts);
  const urgency = randomItem(urgencyLevels);
  const cType = randomItem(complaintTypes);
  const dispatchStatuses = ['none', 'dispatched', 'processing', 'resolved'];
  const isSensitive = Math.random() < 0.05;

  const titles = {
    water: ['水压不足无法正常用水', '自来水有异味', '管道漏水无人处理', '水表计量异常', '停水未通知', '二次供水水质问题', '水费异常高'],
    gas: ['燃气气压不足无法做饭', '燃气管道有漏气声', '燃气表不走字', '停气未提前通知', '液化气配送超时', '燃气灶打不着火', '天然气缴费后未到账']
  };

  return {
    id, complaintNo: 'CS' + date.getFullYear() + String(date.getMonth()+1).padStart(2,'0') + String(date.getDate()).padStart(2,'0') + String(id).padStart(4,'0'),
    title: randomItem(titles[businessType]),
    content: '用户反馈：' + randomItem(titles[businessType]) + '，具体位置在' + district + '，已持续多日未解决，希望相关部门尽快处理。',
    source, businessType, complaintType: cType, urgencyLevel: urgency,
    companyId: businessType === 'water' ? randomInt(1, 3) : randomInt(4, 7),
    companyName: businessType === 'water' ? randomItem(['宜昌市供水总公司', '点军区供水有限公司', '夷陵区水务公司']) : randomItem(['宜昌中燃城市燃气有限公司', '宜昌华润燃气有限公司', '夷陵区燃气有限公司', '宜昌蓝天气体有限公司']),
    districtCode: district, districtName: district,
    locationLng: 111.2 + Math.random() * 0.5, locationLat: 30.6 + Math.random() * 0.4,
    isSensitive: isSensitive ? 1 : 0,
    dispatchStatus: isSensitive ? randomItem(['dispatched', 'processing']) : randomItem(dispatchStatuses),
    status: randomItem(['pending', 'processing', 'resolved', 'resolved', 'resolved']),
    receiverId: randomInt(1, 10),
    createdAt: date.toISOString(), receivedAt: new Date(date.getTime() + randomInt(1000, 3600000)).toISOString()
  };
}

// Generate 200 mock complaints
const complaints = Array.from({ length: 200 }, (_, i) => generateComplaint(i + 1));
const inboundSourceIds = new Set(complaints.map(c => c.sourceId).filter(Boolean));
const processLogs = [];
const syncLogs = [];
const dispatchArchives = [];

function preprocessComplaint(payload) {
  const text = [payload.title, payload.content, payload.address].filter(Boolean).join(' ');
  const businessType = /液化气|钢瓶|瓶装气/.test(text) ? 'lpg' : /燃气|天然气|漏气|气压|停气/.test(text) ? 'gas' : 'water';
  const complaintType = /举报|违法|偷水|盗气/.test(text) ? '举报' : /咨询|请问|如何|查询/.test(text) ? '咨询' : /建议|希望|优化/.test(text) ? '建议' : '投诉';
  const urgencyLevel = /爆炸|泄漏|中毒|大面积停|伤亡|群体/.test(text) ? '特急' : /爆管|断裂|污染|火灾|安全隐患/.test(text) ? '紧急' : '一般';
  const hitWords = ['爆管', '大面积停水', '燃气泄漏', '水质异常', '安全隐患'].filter(word => text.includes(word));

  return {
    businessType,
    complaintType,
    urgencyLevel,
    isSensitive: hitWords.length > 0 ? 1 : 0,
    sensitiveKeywords: hitWords,
    ruleConfidence: hitWords.length > 0 ? 0.88 : 0.72,
    correctionStatus: payload.locationLng && payload.locationLat ? 'none' : 'pending',
    correctionConfidence: payload.locationLng && payload.locationLat ? 0.9 : 0.45
  };
}

// ==================== API Routes ====================

// Health check
app.get('/api/v1/health', (req, res) => {
  res.json({ code: 200, message: 'ok', data: { version: '1.0.0', uptime: process.uptime() } });
});

// Auth
app.post('/api/v1/auth/login', (req, res) => {
  res.json({ code: 200, message: 'success', data: {
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiYWRtaW4ifQ.mock-token',
    userInfo: { id: 1, username: 'admin', realName: '系统管理员', roles: ['admin'], permissions: ['*'] }
  }});
});

app.get('/api/v1/auth/user-info', (req, res) => {
  res.json({ code: 200, data: { id: 1, username: 'admin', realName: '系统管理员', roles: ['admin'], permissions: ['*'] } });
});

// Dashboard APIs
app.get('/api/v1/dashboard/overview', (req, res) => {
  const todayTotal = complaints.filter(c => {
    const d = new Date(c.createdAt);
    const t = new Date();
    return d.toDateString() === t.toDateString();
  }).length;
  const waterCount = complaints.filter(c => c.businessType === 'water').length;
  const gasCount = complaints.filter(c => c.businessType === 'gas').length;
  const sensitive = complaints.filter(c => c.isSensitive === 1).length;
  const overtime = complaints.filter(c => c.dispatchStatus !== 'resolved').length;

  res.json({ code: 200, data: {
    todayTotal: todayTotal || 1247, waterCount: waterCount || 683, gasCount: gasCount || 564,
    sensitiveCount: sensitive || 28, overtimeCount: overtime || 15, avgProcessHours: 4.2,
    waterTrend: [15, 8, 35, 68, 82, 55, 42],
    gasTrend: [12, 5, 28, 55, 70, 48, 35],
    weekTrend: { dates: ['5/22','5/23','5/24','5/25','5/26','5/27','5/28'], gasValues: [320,280,350,410,380,420,390], lpgValues: [85,72,90,105,95,110,98] },
    waterTypes: [{ name:'水压不足', value:245 },{ name:'管道漏水', value:186 },{ name:'水质问题', value:120 },{ name:'水表故障', value:82 },{ name:'其他', value:50 }],
    gasTypes: [{ name:'气压不足', value:198 },{ name:'管道漏气', value:156 },{ name:'用气安全', value:98 },{ name:'表具故障', value:72 },{ name:'其他', value:40 }],
    regionRank: [{ name:'西陵区', value:356 },{ name:'伍家岗区', value:298 },{ name:'点军区', value:215 },{ name:'猇亭区', value:178 },{ name:'夷陵区', value:200 }],
    waterInfo: { companyCount: 3, plantCount: 12, dailyCapacity: 68, pipelineLength: 3826, population: 168, dn100Length: 1245, pumpRoomCount: 326, monitorCount: 458 },
    gasInfo: { companyCount: 4, stationCount: 6, dailyCapacity: 120, pipelineLength: 2154, userCount: 52, lpgStationCount: 38, regulatorCount: 1280, monitorCount: 326 },
    alarms: { water: 12, gas: 8 }
  }});
});

// Complaints list
app.get('/api/v1/complaints', (req, res) => {
  const { page = 1, size = 20, businessType, complaintType, status, districtCode, keyword, startDate, endDate } = req.query;
  let filtered = [...complaints];

  if (businessType) filtered = filtered.filter(c => c.businessType === businessType);
  if (complaintType) filtered = filtered.filter(c => c.complaintType === complaintType);
  if (status) filtered = filtered.filter(c => c.status === status);
  if (districtCode) filtered = filtered.filter(c => c.districtCode === districtCode);
  if (keyword) filtered = filtered.filter(c => c.title.includes(keyword) || c.content.includes(keyword));
  if (startDate) filtered = filtered.filter(c => new Date(c.createdAt) >= new Date(startDate));
  if (endDate) filtered = filtered.filter(c => new Date(c.createdAt) <= new Date(endDate));

  const total = filtered.length;
  const p = parseInt(page), s = parseInt(size);
  const content = filtered.slice((p - 1) * s, p * s);

  res.json({ code: 200, data: { content, total, page: p, size: s, totalPages: Math.ceil(total / s) } });
});

app.get('/api/v1/complaints/:id', (req, res) => {
  const c = complaints.find(c => c.id === parseInt(req.params.id));
  if (!c) return res.status(404).json({ code: 404, message: '诉求不存在' });
  res.json({ code: 200, data: c });
});

// Scheme B: Yijiejieban inbound, rule preprocessing and address correction
app.post('/api/v1/external/yijiejieban/appeal', (req, res) => {
  const payload = req.body || {};
  const sourceId = payload.sourceId || payload.appealId;
  if (!sourceId) return res.status(400).json({ code: 400, message: 'sourceId 必填' });

  if (inboundSourceIds.has(sourceId)) {
    syncLogs.push({ appCode: 'gqxq', sourceSystem: 'yijiejieban', sourceId, result: 'duplicate', createdAt: new Date().toISOString() });
    return res.json({ code: 200, message: 'duplicate', data: { duplicate: true, sourceId } });
  }

  const ruleResult = preprocessComplaint(payload);
  const id = complaints.length + 1;
  const complaint = {
    id,
    sourceId,
    sourceSystem: '宜接就办',
    complaintNo: 'CS' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + String(id).padStart(4, '0'),
    title: payload.title || '宜接就办推送诉求',
    content: payload.content || '',
    source: payload.source || payload.sourceChannel || '宜接就办',
    districtCode: payload.districtCode || payload.districtName || '西陵区',
    districtName: payload.districtName || payload.districtCode || '西陵区',
    address: payload.address || '',
    locationLng: payload.locationLng || payload.longitude,
    locationLat: payload.locationLat || payload.latitude,
    companyName: payload.companyName || '待匹配企业',
    status: 'pending',
    dispatchStatus: 'none',
    syncStatus: 'success',
    createdAt: payload.createdAt || payload.createTime || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    ...ruleResult
  };

  complaints.unshift(complaint);
  inboundSourceIds.add(sourceId);
  processLogs.push({ complaintId: id, action: '规则引擎预处理', content: JSON.stringify(ruleResult), createdAt: new Date().toISOString() });
  res.json({ code: 200, message: 'success', data: { duplicate: false, complaint } });
});

app.get('/api/v1/address-correction/pending', (req, res) => {
  const content = complaints
    .filter(c => c.correctionStatus === 'pending' || (!c.locationLng && !c.locationLat))
    .slice(0, 20)
    .map(c => ({
      id: c.id,
      complaintNo: c.complaintNo,
      title: c.title,
      rawAddress: c.address || c.districtName,
      confidence: c.correctionConfidence || 0.45,
      sourceSystem: c.sourceSystem || '宜接就办'
    }));
  res.json({ code: 200, data: { content, total: content.length } });
});

app.post('/api/v1/address-correction/batch', (req, res) => {
  const items = req.body?.items || req.body || [];
  const list = Array.isArray(items) ? items : [items];
  list.forEach(item => {
    const c = complaints.find(row => row.id === Number(item.id) || row.complaintNo === item.complaintNo);
    if (c) {
      c.correctedAddress = item.correctedAddress;
      c.locationLng = item.locationLng || item.lng || c.locationLng;
      c.locationLat = item.locationLat || item.lat || c.locationLat;
      c.correctionStatus = 'corrected';
      c.correctionConfidence = 0.92;
      processLogs.push({ complaintId: c.id, action: '地址纠偏', content: c.correctedAddress, createdAt: new Date().toISOString() });
    }
  });
  res.json({ code: 200, message: 'success', data: { updated: list.length } });
});

app.get('/api/v1/complaints/:id/sync', (req, res) => {
  syncLogs.push({ appCode: 'gqxq', sourceSystem: 'yijiejieban', complaintId: req.params.id, result: 'success', createdAt: new Date().toISOString() });
  res.json({ code: 200, message: 'success', data: { syncStatus: 'success', syncedAt: new Date().toISOString() } });
});

// Analysis
app.get('/api/v1/analysis/overview', (req, res) => {
  res.json({ code: 200, data: {
    totalComplaints: complaints.length,
    waterTotal: complaints.filter(c => c.businessType === 'water').length,
    gasTotal: complaints.filter(c => c.businessType === 'gas').length,
    resolvedRate: 78.5,
    sensitiveCount: complaints.filter(c => c.isSensitive).length,
    avgResolveHours: 5.8,
    monthOverMonth: 12.3
  }});
});

// Companies
app.get('/api/v1/companies', (req, res) => {
  res.json({ code: 200, data: { content: companies, total: companies.length } });
});

app.get('/api/v1/companies/:id', (req, res) => {
  const company = companies.find(c => c.id === parseInt(req.params.id));
  if (!company) return res.status(404).json({ code: 404, message: '企业不存在' });
  res.json({ code: 200, data: company });
});

// Grids
app.get('/api/v1/grids', (req, res) => {
  const grids = districts.slice(0, 5).map((d, i) => ({
    id: i + 1, gridCode: 'GRID' + String(i+1).padStart(3,'0'), gridName: d + '网格',
    districtCode: d, districtName: d, companyId: (i % 3) + 1, companyName: companies[i % 3].name,
    managerName: '负责人' + (i+1), status: 1, totalComplaints: randomInt(50, 400), resolvedComplaints: randomInt(30, 350)
  }));
  res.json({ code: 200, data: { content: grids, total: grids.length } });
});

// Shutdowns
app.get('/api/v1/shutdowns', (req, res) => {
  const shutdowns = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, appNo: 'SD202605' + String(i+1).padStart(3,'0'),
    companyId: randomInt(1, 7), companyName: randomItem(companies).name,
    businessType: randomItem(['water', 'gas']),
    shutdownType: randomItem(['planned', 'emergency']),
    reason: randomItem(['管道检修', '新用户接驳', '老旧管网改造', '突发爆管抢修']),
    plannedStartTime: new Date(Date.now() - randomInt(0, 7 * 24 * 3600 * 1000)).toISOString(),
    plannedEndTime: new Date(Date.now() + randomInt(0, 3 * 24 * 3600 * 1000)).toISOString(),
    status: randomItem(['draft', 'pending_approval', 'approved', 'in_progress', 'completed']),
    createdAt: new Date().toISOString()
  }));
  res.json({ code: 200, data: { content: shutdowns, total: shutdowns.length } });
});

// Pipeline projects
app.get('/api/v1/pipeline-projects', (req, res) => {
  const projects = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, projectNo: 'PJ2026' + String(i+1).padStart(3,'0'),
    projectName: randomItem(['西陵区供水管网改造一期', '伍家岗燃气管道更新工程', '点军区供水支管扩建', '夷陵区老旧管网更换']),
    companyId: randomInt(1, 7), companyName: randomItem(companies).name,
    businessType: randomItem(['water', 'gas']),
    pipelineLength: randomInt(100, 5000),
    startDate: new Date(Date.now() - randomInt(0, 90 * 24 * 3600 * 1000)).toISOString(),
    plannedEndDate: new Date(Date.now() + randomInt(0, 60 * 24 * 3600 * 1000)).toISOString(),
    status: randomItem(['pending', 'in_progress', 'completed']),
    budget: randomInt(100000, 5000000),
    createdAt: new Date().toISOString()
  }));
  res.json({ code: 200, data: { content: projects, total: projects.length } });
});

// Dispatch orders
app.get('/api/v1/dispatch/orders', (req, res) => {
  const orders = complaints.filter(c => c.isSensitive).map((c, i) => ({
    id: i + 1, orderNo: 'JB202605' + String(i+1).padStart(4,'0'),
    complaintId: c.id, complaintTitle: c.title,
    dispatchType: randomItem(['auto', 'manual']),
    triggerType: randomItem(['sensitive_word', 'manual_flag']),
    urgencyLevel: c.urgencyLevel,
    targetCompanyId: c.companyId, targetCompanyName: c.companyName,
    deadline: new Date(Date.now() + randomInt(1, 7) * 24 * 3600 * 1000).toISOString(),
    status: randomItem(['pending', 'processing', 'completed']),
    syncStatus: randomItem(['not_synced', 'syncing', 'success', 'failed']),
    externalStatus: randomItem(['pending', 'accepted', 'processing', 'completed', 'overtime']),
    dispatcherName: '管理员',
    createdAt: c.createdAt
  }));
  res.json({ code: 200, data: { content: orders, total: orders.length } });
});

app.post('/api/v1/dispatch/orders', (req, res) => {
  const body = req.body || {};
  const order = {
    id: Date.now(),
    orderNo: 'JB' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + String(randomInt(1, 9999)).padStart(4, '0'),
    assignmentId: body.assignmentId,
    complaintId: body.complaintId,
    complaintTitle: body.complaintTitle || body.title || '人工交办诉求',
    targetCompanyName: body.targetCompanyName || body.targetCompany || '待匹配企业',
    status: 'pending',
    syncStatus: 'not_synced',
    externalStatus: 'pending',
    createdAt: new Date().toISOString()
  };
  processLogs.push({ complaintId: order.complaintId, action: '创建交办单', content: order.orderNo, createdAt: new Date().toISOString() });
  res.json({ code: 200, data: order });
});

app.post('/api/v1/dispatch/orders/:id/push', (req, res) => {
  syncLogs.push({ appCode: 'tianbao', assignmentId: req.params.id, action: 'push', result: 'success', createdAt: new Date().toISOString() });
  res.json({ code: 200, message: 'success', data: { syncStatus: 'success', externalStatus: 'accepted' } });
});

app.post('/api/v1/dispatch/orders/:id/repush', (req, res) => {
  syncLogs.push({ appCode: 'tianbao', assignmentId: req.params.id, action: 'repush', result: 'success', createdAt: new Date().toISOString() });
  res.json({ code: 200, message: 'success', data: { syncStatus: 'success', externalStatus: 'accepted' } });
});

app.get('/api/v1/dispatch/orders/:id/sync', (req, res) => {
  syncLogs.push({ appCode: 'tianbao', assignmentId: req.params.id, action: 'sync', result: 'success', createdAt: new Date().toISOString() });
  res.json({ code: 200, message: 'success', data: { externalStatus: 'completed', resultContent: 'mock 填报系统已反馈处理结果' } });
});

app.post('/api/v1/dispatch/orders/:id/archive', (req, res) => {
  const archive = { assignmentId: req.params.id, archivedAt: new Date().toISOString(), result: req.body?.resultContent || '管理员确认归档' };
  dispatchArchives.push(archive);
  processLogs.push({ action: '交办归档', content: JSON.stringify(archive), createdAt: archive.archivedAt });
  res.json({ code: 200, message: 'success', data: archive });
});

app.post('/api/v1/external/tianbao/status-callback', (req, res) => {
  syncLogs.push({ appCode: 'tianbao', action: 'status-callback', payload: req.body, result: 'success', createdAt: new Date().toISOString() });
  res.json({ code: 200, message: 'success', data: { received: true } });
});

// Reports
app.get('/api/v1/reports', (req, res) => {
  const reports = [
    { id: 1, reportTitle: '2026年5月28日日报', reportType: 'daily', reportDate: '2026-05-28', status: 'completed', createdAt: '2026-05-28T18:00:00' },
    { id: 2, reportTitle: '2026年第22周周报', reportType: 'weekly', reportDate: '2026-05-25', status: 'completed', createdAt: '2026-05-25T18:00:00' },
    { id: 3, reportTitle: '2026年5月月报', reportType: 'monthly', reportDate: '2026-05-01', status: 'completed', createdAt: '2026-05-01T18:00:00' },
  ];
  res.json({ code: 200, data: { content: reports, total: reports.length } });
});

// Dicts
app.get('/api/v1/dicts/:code/items', (req, res) => {
  const dicts = {
    'complaint_type': [{ value: 'complaint', label: '投诉' },{ value: 'consult', label: '咨询' },{ value: 'suggest', label: '建议' },{ value: 'report', label: '举报' }],
    'business_type': [{ value: 'water', label: '供水' },{ value: 'gas', label: '燃气' }],
    'urgency_level': [{ value: 'normal', label: '一般' },{ value: 'urgent', label: '紧急' },{ value: 'critical', label: '特急' }],
    'source': [{ value: 'citizen_hall', label: '市民之家' },{ value: 'hotline_12345', label: '12345热线' },{ value: 'mobile_app', label: '移动端' },{ value: 'web', label: '网页端' }]
  };
  res.json({ code: 200, data: dicts[req.params.code] || [] });
});

// Heatmap
app.get('/api/v1/heatmap/data', (req, res) => {
  const points = Array.from({ length: 100 }, () => ({
    lng: 111.2 + Math.random() * 0.5, lat: 30.6 + Math.random() * 0.4, count: randomInt(1, 50)
  }));
  res.json({ code: 200, data: points });
});

// Users
app.get('/api/v1/users', (req, res) => {
  const users = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, username: 'user' + (i+1), realName: '工作人员' + (i+1),
    phone: '1380000' + String(i+1).padStart(4,'0'), email: 'user' + (i+1) + '@yichang.gov.cn',
    deptId: randomInt(1, 5), status: 1, createdAt: new Date().toISOString()
  }));
  res.json({ code: 200, data: { content: users, total: users.length } });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] 宜昌市供水燃气行业诉求分析平台 API 服务已启动`);
  console.log(`[Server] 地址: http://localhost:${PORT}`);
  console.log(`[Server] API 基础路径: http://localhost:${PORT}/api/v1`);
  console.log(`[Server] 健康检查: http://localhost:${PORT}/api/v1/health`);
});
