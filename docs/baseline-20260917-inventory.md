# G0 基线固化记录（tag: baseline-20260917）

> 生成时间：2026-09-17。对应《2026-09-17-诉求平台落地计划.md》第 5 节 G0 批次。
> 本文件只记录“改动前是什么样”，不做任何业务判断。

## 1. 基线标识

| 项 | 值 |
| --- | --- |
| 仓库 | `D:\aiProject\workspace-opc\gqxq` |
| 远端 | `git@github.com:pengcong1225-oss/gqxq.git`（本次**不推送**） |
| 基线前 HEAD | `3a07779 feat: init project`（主分支唯一提交） |
| 基线 commit | 见下方 `git log -1 baseline-20260917` |
| tag | `baseline-20260917` |
| 回退方式 | `git checkout baseline-20260917` |

## 2. 运行环境（基线时实测）

| 项 | 实测结果 |
| --- | --- |
| Node | v24.19.0 |
| npm | 11.17.0 |
| MySQL | MySQL Server 8.0 已安装，服务 `MySQL80` Running，监听 3306；命令行客户端 `C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`（未加入 PATH） |
| Docker | 未安装 |
| 后端启动 | `node src/index.js` 在 3101 端口实测 200（3100 被历史遗留进程 PID 32788 占用） |
| 前端构建 | `npm run build`（packages/web-admin）成功，29.67s，产物 `dist/assets/index-CF-qiZNL.js` 2380.55 kB |

> 注意：`packages/web-admin` 的 `build` 脚本只有 `vite build`，**没有 `tsc --noEmit`**，因此构建成功不代表类型检查通过。G1 需补上类型检查门禁。

## 3. 已修改文件清单（11 个，共 +1065 / -151）

| 文件 | +/− | 改动性质 |
| --- | --- | --- |
| `.gitignore` | +5 / -0 | 新增 `.dev-logs/`、`*.log` 忽略规则（本次 G0 追加） |
| `packages/web-admin/src/App.tsx` | +4 / -0 | 新增 `address-correction`、`dispatch/archive` 两条路由 |
| `packages/web-admin/src/assets/styles/global.css` | +20 / -0 | 新增 `.mock-map` 占位地图样式 |
| `packages/web-admin/src/layouts/MainLayout.tsx` | +4 / -1 | 菜单新增“地址纠偏”“交办归档” |
| `packages/web-admin/src/main.tsx` | +36 / -10 | **改为 qiankun 微前端子应用生命周期**（`bootstrap`/`mount`/`unmount`、`__POWERED_BY_QIANKUN__` 判断、`basePath`） |
| `packages/web-admin/src/views/ComplaintDetail.tsx` | +10 / -1 | Mock 详情补充来源系统/来源 ID/纠偏/规则预处理字段，时间线把“NLP自动分类”改为“规则引擎预处理” |
| `packages/web-admin/src/views/ComplaintList.tsx` | +17 / -0 | Mock 列表新增来源系统、纠偏、同步三列及对应 Mock 字段 |
| `packages/web-admin/src/views/DispatchOrders.tsx` | +11 / -2 | Mock 交办单新增 syncStatus/externalStatus，新增“推送/同步”按钮（`message.success` 假成功） |
| `packages/web-admin/vite.config.ts` | +3 / -0 | dev server 增加 `Access-Control-Allow-Origin: *` 响应头（qiankun 需要） |
| `packages/web-dashboard/index.html` | +807 / -137 | 数据大屏单文件重写（内联样式与图表配置） |
| `server/src/index.js` | +148 / -0 | 新增宜接就办接收、地址纠偏、交办 push/repush/sync/archive、tianbao 回调等 Mock 接口 |

## 4. 本次一并入库的未跟踪文件（11 个）

| 文件 | 说明 |
| --- | --- |
| `docs/2026-09-17-诉求平台设计与落地方案.md` | 设计与落地方案（上游依据） |
| `docs/2026-09-17-诉求平台落地计划.md` | 可执行落地计划（G0–G6） |
| `packages/web-admin/src/views/AddressCorrection.tsx` | 新增页面 |
| `packages/web-admin/src/views/DispatchArchive.tsx` | 新增页面 |
| `packages/web-admin/package-lock.json` | 前端依赖锁 |
| `server/package-lock.json` | 后端依赖锁 |
| `方案A-可用AI.md`、`方案B-政务网离线.md` | 两条技术路线说明 |
| `宜昌市供水供气数据大屏需求文档.docx`（1.7 MB） | 业主需求原文 |
| `宜昌市供水供气行业诉求分析平台PRD-202605.docx` | 业主 PRD |
| `宜昌市供水供气行业诉求分析平台项目报价方案-宜昌博川云泓科技有限公司-20万元.docx` | 报价方案 |

被排除的目录：`node_modules/`、`dist/`、`.claude/`、`.dev-logs/`（均已在 `.gitignore`）。

## 5. 复现与核对命令

```powershell
cd D:\aiProject\workspace-opc\gqxq
git log -1 --oneline baseline-20260917
git show --stat baseline-20260917
git status --short            # 应为空
git checkout baseline-20260917  # 完整回退
```

## 6. 基线遗留问题（G1 起必须处理）

1. `server/src/index.js` 启动时随机生成 200 条内存数据，重启即丢；无任何数据库依赖。
2. `GET /api/v1/dashboard/overview` 硬编码兜底 `todayTotal || 1247`、`sensitiveCount || 28`、`resolvedRate: 78.5` 及全天候静态数组。
3. `GET /api/v1/dispatch/orders` 现场 `randomItem()` 生成，`id` 为数组下标；`POST /api/v1/dispatch/orders` 不落库。
4. `views/` 下 0 处 API 调用，`api/request.ts` 无任何页面引用。
5. `packages/web-admin` 构建脚本缺类型检查。
6. 3100 端口存在 2026-09-16 启动的遗留 `node src/index.js` 进程（PID 32788），后续联调前需确认是否保留。
