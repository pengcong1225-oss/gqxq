/** Local-only offline preview. Never mount in the production app. */
process.env.GQXQ_DB_USER = 'offline-preview';
process.env.GQXQ_DB_NAME = 'offline-preview';
process.env.GQXQ_JWT_SECRET = 'offline-preview-only-no-production-credentials';
async function main() {
  const { screenBootstrap, screenDemands, screenCompare, screenEvent, screenEvidence } = await import('../src/services/screenService');
  const access = { userId: 'offline-preview', roles: ['readonly'], scopeVersion: 1, rules: [{ kind: 'all' as const }], canReadSource: false };
  const grants = ['statistics.read', 'dashboard.read', 'complaint.read', 'grid.read', 'heatmap.read', 'enterprise.read', 'shutdown.read', 'pipeline.read'];
  if (process.argv.includes('--fixture')) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    const result = await screenBootstrap({ mode: 'simulation', from: '2026-11-01', to: '2026-11-10' }, access, grants);
    const output = { ...result, contextId: 'offline-fixture-not-a-session' };
    const folder = path.resolve(__dirname, '../tests/fixtures'); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'screen-simulation.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
    return;
  }
  const express = (await import('express')).default;
  const app = express(); app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('X-Screen-Preview', 'SIMULATION ONLY'); res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/v1/screen/bootstrap', async (req, res, next) => { try { if (req.query.mode !== undefined && req.query.mode !== 'simulation') return res.status(400).json({ code: 400, message: '仅支持模拟' }); const data = await screenBootstrap({ ...req.query, mode: 'simulation' }, access, grants); return res.json({ code: 200, message: 'SIMULATION ONLY', data }); } catch (e) { next(e); } });
  app.get('/api/v1/screen/demands', (req, res, next) => { try { const { contextId, page, size, ...filters } = req.query; res.json({ code: 200, message: 'SIMULATION ONLY', data: screenDemands(contextId, page, size, access, grants, filters) }); } catch (e) { next(e); } });
  app.get('/api/v1/screen/evidence',(req,res,next)=>{try{res.json({code:200,message:'SIMULATION ONLY',data:screenEvidence(req.query.contextId,req.query.evidenceKey,req.query.page,req.query.size,access,grants)});}catch(e){next(e);}});
  app.get('/api/v1/screen/compare', (req, res, next) => { try { res.json({ code: 200, message: 'SIMULATION ONLY', data: screenCompare(req.query.contextId, req.query.gridCodes, access, grants) }); } catch (e) { next(e); } });
  app.get('/api/v1/screen/events/:id', async (req, res, next) => { try { res.json({ code: 200, message: 'SIMULATION ONLY', data: await screenEvent(req.query.contextId, req.params.id, access, grants) }); } catch (e) { next(e); } });
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ code: err.status ?? 500, message: err.message ?? 'preview error', data: null }));
  const port = Number(process.env.SCREEN_PREVIEW_PORT ?? 3199); if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('invalid preview port');
  app.listen(port, '127.0.0.1', () => console.log(`SIMULATION ONLY: http://127.0.0.1:${port}`));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
