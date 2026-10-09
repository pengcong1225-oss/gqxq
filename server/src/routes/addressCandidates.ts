import { Router } from 'express';
import type { Request } from 'express';
import { ROLE_ADMIN } from '../auth/rolePolicy';
import { requirePermission } from '../middleware/requireRole';
import { ok } from '../http/respond';
import { executeAddressCandidateBackfill, previewAddressCandidateBackfill } from '../services/addressCandidateBackfillService';

export const addressCandidatesRouter = Router();

function operatorOf(req: Request) {
  return { userId: req.user?.id ?? null, userName: req.user?.username ?? null, clientIp: req.remoteIp ?? null };
}

addressCandidatesRouter.post('/address-candidates/backfill-preview', requirePermission('system.address.backfill'), async (_req, res, next) => {
  try { ok(res, await previewAddressCandidateBackfill()); } catch (err) { next(err); }
});

addressCandidatesRouter.post('/address-candidates/backfill', requirePermission('system.address.backfill'), async (req, res, next) => {
  try { ok(res, await executeAddressCandidateBackfill(operatorOf(req))); } catch (err) { next(err); }
});
