import { Router } from 'express';
import { pool } from '../db/pool';
import { ok } from '../http/respond';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res, next) => {
  try {
    const [rows] = await pool.query('select 1 as ok');
    ok(res, {
      version: '1.0.0',
      uptime: process.uptime(),
      database: (rows as Array<{ ok: number }>)[0]?.ok === 1 ? 'up' : 'unknown',
    });
  } catch (err) {
    next(err);
  }
});
