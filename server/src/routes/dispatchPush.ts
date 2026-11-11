import { reportingResult, reportingAttachment, reconcileReporting } from '../services/reportingEvidenceService';
import { Router } from 'express';
import type { Request } from 'express';
import { ok } from '../http/respond';
import { listPushLogs, pushDispatch, preflightDispatch } from '../services/dispatchPushService';
import type { OperatorContext } from '../services/dispatchService';

// Authenticated push/repush register durable intent. Only the server-owned worker sends.
export const dispatchPushRouter = Router();

/** 操作者上下文：用户来自 requireAuth 注入的 req.user，IP 来自 requestContext */
function ctxOf(req: Request): OperatorContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.username ?? null,
    clientIp: req.remoteIp ?? null,
  };
}

dispatchPushRouter.post('/dispatch/orders/:assignmentId/push', async (req, res, next) => {
  try {
    ok(res, await pushDispatch(String(req.params.assignmentId), ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

dispatchPushRouter.post('/dispatch/orders/:assignmentId/repush', async (req, res, next) => {
  try {
    ok(res, await pushDispatch(String(req.params.assignmentId), ctxOf(req)));
  } catch (err) {
    next(err);
  }
});

dispatchPushRouter.get('/dispatch/orders/:assignmentId/push-logs', async (req, res, next) => {
  try {
    ok(res, await listPushLogs(String(req.params.assignmentId)));
  } catch (err) {
    next(err);
  }
});

dispatchPushRouter.post('/dispatch/orders/:assignmentId/preflight',async(req,res,next)=>{try{ok(res,await preflightDispatch(String(req.params.assignmentId)));}catch(err){next(err);}});

dispatchPushRouter.get('/dispatch/orders/:assignmentId/reporting-result',async(req,res,next)=>{try{ok(res,await reportingResult(String(req.params.assignmentId)));}catch(err){next(err);}});
dispatchPushRouter.post('/dispatch/orders/:assignmentId/reconcile',async(req,res,next)=>{try{ok(res,await reconcileReporting(String(req.params.assignmentId)));}catch(err){next(err);}});
dispatchPushRouter.get('/dispatch/orders/:assignmentId/reporting-attachments/:attachmentId',async(req,res,next)=>{try{const a=await reportingAttachment(String(req.params.assignmentId),String(req.params.attachmentId));res.setHeader('Content-Type',a.contentType);res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(a.fileName));res.setHeader('Cache-Control','no-store');res.send(a.bytes);}catch(err){next(err);}});
