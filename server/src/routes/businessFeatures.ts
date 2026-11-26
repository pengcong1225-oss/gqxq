import {Router,type Request} from 'express';
import {pool} from '../db/pool';
import {ok} from '../http/respond';
import {currentAccessContext} from '../auth/accessScope';
import {listBusinessRules,saveBusinessRule,publishBusinessRule,previewAlertBaseline} from '../services/businessRuleService';
import {compareGrids,historicalAssessment,seasonalAssessment,seasonalDetails,assessmentAdminGrids} from '../services/businessAssessmentService';
import {yichangDistrictBoundaries,amapBoundaryConfigured,districtSnapshotSummary} from '../services/adminBoundaryService';
import {getStreetBoundariesCached} from '../services/streetBoundaryService';
import {boundaryPackSummary} from '../services/boundaryPackService';
import {listBusinessAlerts,listBusinessAlertRules,evaluateBusinessAlerts,actOnBusinessAlert,alertHistory} from '../services/businessAlertService';
import {loadPipelineLayer,loadPipelineProject} from '../services/pipelineLayerService';
import {loadShutdownLayer} from '../services/shutdownLayerService';
import {findPipelineComplaintClues} from '../services/pipelineComplaintClues';
import {AppError} from '../http/errors';
import type {BusinessEventContext} from '../types/businessEvents';
const context=(req:Request):BusinessEventContext=>({userId:req.user!.id,userName:req.user!.username,clientIp:req.ip,permissionCodes:req.user?.permissionCodes??[],access:req.accessContext??currentAccessContext()});
export const businessFeaturesRouter=Router();
businessFeaturesRouter.get('/business-rules',async(req,res,next)=>{try{ok(res,await listBusinessRules(context(req)));}catch(e){next(e);}});
businessFeaturesRouter.post('/business-rules',async(req,res,next)=>{try{ok(res,await saveBusinessRule(req.body,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.post('/business-rules/baseline',async(req,res,next)=>{try{ok(res,await previewAlertBaseline(req.body,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.post('/business-rules/:id/publish',async(req,res,next)=>{try{ok(res,await publishBusinessRule(req.params.id,req.body?.expectedVersion,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.get('/assessment/admin-grids',async(req,res,next)=>{try{ok(res,(await assessmentAdminGrids(pool,context(req))).map(r=>({code:r.code,name:r.name,version:r.version,hasGeometry:!!r.geometry})));}catch(e){next(e);}});
/**
 * 行政区/网格边界（标书 1.2「社区网格图层」「区域分布采用真实边界」）。
 *
 * 两级：
 *   district（6 位码）：真实行政边界，来自高德（服务端持 key + GCJ02→WGS84 + 缓存 12h）
 *   street （9 位码）：优先 `admin_grid.geometry`（甲方正式边界）；缺失时用「同街道小区点位凸包」近似
 *
 * 响应：
 *   { boundaries, source, configured, level, streetSource }
 *   streetSource: 'official' | 'hull' | 'mixed' | 'none'，前端据此如实标注边界来源。
 *
 * 甲方灌入 admin_grid.geometry 后，无需改前端，接口自动切换为 official。
 */
businessFeaturesRouter.get('/assessment/admin-boundaries',async(req,res,next)=>{
  try{
    const [districtBoundaries,streetBoundaries]=await Promise.all([
      yichangDistrictBoundaries(),
      getStreetBoundariesCached(pool),
    ]);
    const officialCount=streetBoundaries.filter(s=>s.source==='official').length;
    const packCount=streetBoundaries.filter(s=>s.source==='pack').length;
    const bufferCount=streetBoundaries.filter(s=>s.source==='buffer').length;
    const packMatched=streetBoundaries.filter(s=>s.source==='pack'&&s.packMatched).length;
    const kinds=[officialCount?1:0,packCount?1:0,bufferCount?1:0].reduce((a,b)=>a+b,0);
    const streetSource: 'official'|'pack'|'buffer'|'mixed'|'none'=
      kinds>1?'mixed':officialCount?'official':packCount?'pack':bufferCount?'buffer':'none';
    /**
     * pack：边界数据包（OSM 底稿 / 商业授权 / 甲方导出）。
     * 为什么要透出 metadata：客户与验收方必须一眼看到「这些面从哪来、什么时候抓的、
     * 许可是什么、多少网格没对上官方编码」，否则 OSM 底稿会被当成正式边界。
     */
    const pack=boundaryPackSummary();
    /*
     * 区县边界来源：amap=高德实时 / snapshot=本地快照（高德不可用或缺部分时补齐）。
     * 必须透出：验收方要能区分"官方实时边界"和"快照兜底"，不能让快照冒充实时数据。
     */
    const districtAmap=districtBoundaries.filter(s=>s.source==='amap').length;
    const districtSnapshot=districtBoundaries.filter(s=>s.source==='snapshot').length;
    ok(res,{
      boundaries:[...districtBoundaries,...streetBoundaries],
      source:'amap',
      configured:amapBoundaryConfigured(),
      level:'district+street',
      streetSource,
      streetCount:{official:officialCount,pack:packCount,buffer:bufferCount},
      packMatched,
      pack,
      districtSource:{amap:districtAmap,snapshot:districtSnapshot},
      districtSnapshot:districtSnapshot>0?districtSnapshotSummary():null,
    });
  }catch(e){next(e);}
});
/**
 * 管线图层（标书 1.2.7 管线图层对接）。
 *
 * 口径：**落图单位是「改造项目涉及的网格」，不是管线几何**。
 * 投标技术方案第 755 行已定稿「缺少精确管线几何时展示真实上报的影响网格和范围，不画虚构管线」，
 * 因此本接口只返回按网格聚合的项目数据，由前端画网格色块。
 *
 * 查询参数：
 *   businessType = water | gas | all（默认 all；前端两个图层开关各取一种）
 * 响应：{ businessType, cells[], gridCount, projectCount, unlocatedProjects[], statusNote, dataNote }
 *   cells = [{ gridCode, projectCount, inProgressCount, statusCounts, projects[] }]
 *   dataNote 如实说明数据缺失（表为空 / 项目缺「涉及网格」），不粉饰。
 */
businessFeaturesRouter.get('/assessment/pipeline-layer',async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  try{
    if(!req.user?.permissionCodes?.includes('pipeline.read'))throw AppError.forbidden('缺少施工查询权限');
    const bt=String(req.query.businessType??'all').toLowerCase();
    const type: 'water'|'gas'|'all'=bt==='water'||bt==='gas'?bt:'all';
    ok(res,await loadPipelineLayer(pool,type,req.accessContext??currentAccessContext()));
  }catch(e){next(e);}
});
businessFeaturesRouter.get('/assessment/pipeline-layer/projects/:projectId/complaints', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    const ctx = context(req);
    if (!ctx.permissionCodes.includes('pipeline.read') || !ctx.permissionCodes.includes('complaint.read')) {
      throw AppError.forbidden('缺少施工或诉求工单查询权限');
    }
    const projectId = req.params.projectId;
    const gridCode = typeof req.query.gridCode === 'string' ? req.query.gridCode.trim() : '';
    const rawPage = req.query.page ?? '1';
    const page = typeof rawPage === 'string' && /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
    const revision = req.query.sourceRevision;
    if (!projectId || projectId.length > 128 || !gridCode || gridCode.length > 128 ||
        !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * 10) ||
        (revision !== undefined && typeof revision !== 'string')) {
      throw AppError.validation('项目编号、网格编码、页码或版本无效');
    }
    const project = await loadPipelineProject(pool, projectId, ctx.access);
    if (!project || !project.gridCodes.includes(gridCode)) throw AppError.notFound('该网格无此改造项目，或项目已不可见');
    if (revision !== undefined && revision !== project.sourceRevision) throw AppError.conflict('项目已更新，请重新拉取改造项目图层');
    ok(res, await findPipelineComplaintClues(pool, project, gridCode, page, ctx.access));
  } catch (error) { next(error); }
});
/**
 * 停水停气图层（标书 1.2.6）
 *
 * 口径：**落图单位是「事件 × 涉及网格」的打点标识**，不是色块。
 * 同一事件涉及多个网格 → 多个标识，前端按 eventId 联动高亮（标书明确要求）。
 *
 * 查询参数：
 *   category = planned_water | planned_gas | emergency_water | emergency_gas | all（默认 all）
 * 响应：{ category, events[], markers[], gridHistory{}, categoryCounts, gridCount,
 *        dataNote, mappingNote, blocker }
 *   blocker 如实量化数据堵点（来源多少条、卡在哪一跳、修好能落多少、待业主确认哪几家企业），
 *   绝不造 mock 事件、绝不画虚构几何。
 */
businessFeaturesRouter.get('/assessment/shutdown-layer',async(req,res,next)=>{
  try{
    const raw=String(req.query.category??'all').toLowerCase();
    const allowed=['planned_water','planned_gas','emergency_water','emergency_gas'] as const;
    const type=(allowed as readonly string[]).includes(raw)?raw as typeof allowed[number]:'all';
    res.set('Cache-Control','no-store');
    ok(res,await loadShutdownLayer(pool,type,req.accessContext??currentAccessContext()));
  }catch(e){next(e);}
});
businessFeaturesRouter.get('/assessment/grid-comparison',async(req,res,next)=>{try{ok(res,await compareGrids(req.query,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.get('/assessment/historical',async(req,res,next)=>{try{ok(res,await historicalAssessment(req.query,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.get('/assessment/seasonal',async(req,res,next)=>{try{ok(res,await seasonalAssessment(req.query,context(req)));}catch(e){next(e);}});
/**
 * 保障季明细（按需拉取）。
 *
 * 主接口 /assessment/seasonal 为走覆盖索引只取 5 列，拿不到案号/标题；
 * 明细由本接口分页提供，只在用户点开某一季时才请求。
 */
businessFeaturesRouter.get('/assessment/seasonal/details',async(req,res,next)=>{try{ok(res,await seasonalDetails(req.query,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.get('/business-alerts',async(req,res,next)=>{try{ok(res,await listBusinessAlerts(context(req)));}catch(e){next(e);}});
businessFeaturesRouter.get('/business-alerts/rules',async(req,res,next)=>{
 try{res.set('Cache-Control','no-store');ok(res,await listBusinessAlertRules(context(req)));}catch(e){next(e);}
});
businessFeaturesRouter.post('/business-alerts/evaluate',async(req,res,next)=>{try{ok(res,await evaluateBusinessAlerts(req.body?.day,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.get('/business-alerts/:id/history',async(req,res,next)=>{try{ok(res,await alertHistory(req.params.id,context(req)));}catch(e){next(e);}});
businessFeaturesRouter.post('/business-alerts/:id/actions',async(req,res,next)=>{try{ok(res,await actOnBusinessAlert(req.params.id,req.body,context(req)));}catch(e){next(e);}});
