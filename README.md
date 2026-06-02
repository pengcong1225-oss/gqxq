# 宜昌市城镇供水燃气行业诉求分析平台

> 建设周期：210天 | 编制单位：住新局水燃中心

## 项目概述

为宜昌市住新局水燃中心开发的行业诉求分析平台，整合供水供气企业数据、用户诉求信息、巡检记录等关键数据，实现诉求实时汇聚、智能分类、可视化分析预警。

## 项目结构

```
gqxq/
├── packages/
│   ├── web-admin/          # 管理后台 (React + Ant Design + ECharts)
│   └── web-dashboard/      # 数据大屏 (独立部署，全屏可视化)
├── server/                 # 后端API服务 (Node.js/Express Demo)
├── docs/                   # 项目文档
└── README.md
```

## 子系统

### 1. 诉求分析平台 (web-admin)
管理后台，包含12个功能模块：
- 诉求数据汇聚 - 多渠道数据实时接入
- 诉求数据分析 - 多维度统计分析
- 敏感诉求交办 - 自动识别+工作流
- 精准分类 - NLP自动分类
- 企业管理 - 企业档案+资质+考核
- 热力图管理 - GIS热力图可视化
- 网格管理 - 区域网格划分
- 字典管理 - 系统字典维护
- 停水停气申请 - 停供审批流程
- 管道施工改造 - 项目进度管理
- 数据分析报告 - 报告自动生成
- 停供超时数据对接 - 外部系统集成

### 2. 数据大屏 (web-dashboard)
全屏可视化展示模块：
- 顶部汇总指标 (6个核心KPI)
- 左侧供水总体态势面板
- 中间GIS地图地理信息可视化
- 右侧燃气总体态势面板
- 底部功能导航栏

## 快速启动

### 1. 启动后端Mock API服务
```bash
cd server
npm install
npm run dev
```
服务地址: http://localhost:3100

### 2. 启动数据大屏Demo
直接在浏览器中打开 `packages/web-dashboard/index.html`

### 3. 启动管理后台
```bash
cd packages/web-admin
npm install
npm run dev
```
访问地址: http://localhost:5173

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript |
| UI组件 | Ant Design 5 |
| 图表 | ECharts 5 |
| 状态管理 | Zustand |
| 后端 | Node.js/Express (Demo) / Spring Boot 3.2 (生产) |
| 数据库 | PostgreSQL + PostGIS |
| GIS | 天地图 JavaScript API |
| NLP | Python FastAPI + PaddleNLP |
| 消息队列 | RocketMQ |
| 搜索引擎 | Elasticsearch |
