import { Router } from 'express';
import { currentAccessContext } from '../auth/accessScope';
import { ok } from '../http/respond';
import { screenBootstrap, screenDemands, screenMapPickDemands, screenEvent, screenCompare, screenEvidence } from '../services/screenService';
export const screenRouter = Router();
screenRouter.get('/screen/bootstrap', async (req, res, next) => { try { res.set('Cache-Control', 'no-store'); ok(res, await screenBootstrap(req.query, req.accessContext ?? currentAccessContext(), req.user?.permissionCodes ?? [])); } catch (e) { next(e); } });
screenRouter.get('/screen/demands', (req, res, next) => { try { res.set('Cache-Control', 'no-store'); const { contextId, page, size, ...filters } = req.query; ok(res, screenDemands(contextId, page, size, req.accessContext ?? currentAccessContext(), req.user?.permissionCodes ?? [], filters)); } catch (e) { next(e); } });

/**
 * 地图点击浮层：按 communityCode / adminGridCode 查概况与明细。
 *
 * 与 `/screen/demands` 的区别：**不需要 contextId**。
 * 地图点击不应触发 bootstrap 重查（那会把左右列表全部重算，是"点一下数字归零"的根源），
 * 因此单独开一条只读、无副作用的查询通道。
 */
screenRouter.get('/screen/map-pick-demands', async (req, res, next) => { try { res.set('Cache-Control', 'no-store'); ok(res, await screenMapPickDemands(req.query as Record<string, unknown>, req.accessContext ?? currentAccessContext(), req.user?.permissionCodes ?? [])); } catch (e) { next(e); } });
screenRouter.get('/screen/events/:id', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    ok(res, await screenEvent(req.query.contextId, req.params.id, req.accessContext ?? currentAccessContext(),
      req.user?.permissionCodes ?? [], undefined, req.query.layerVersion));
  } catch (e) {
    next(e);
  }
});

screenRouter.get('/screen/compare', (req, res, next) => { try { res.set('Cache-Control', 'no-store'); ok(res, screenCompare(req.query.contextId, req.query.gridCodes, req.accessContext ?? currentAccessContext(), req.user?.permissionCodes ?? [])); } catch (e) { next(e); } });

screenRouter.get('/screen/evidence',(req,res,next)=>{try{res.set('Cache-Control','no-store');ok(res,screenEvidence(req.query.contextId,req.query.evidenceKey,req.query.page,req.query.size,req.accessContext??currentAccessContext(),req.user?.permissionCodes??[]));}catch(e){next(e);}});
