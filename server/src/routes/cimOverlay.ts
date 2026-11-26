/**
 * CIM 网格边界面代理（只读、只出图）
 *
 * GET /cim/grid-overlay?level=sqwg&bbox=W,S,E,N&w=1024&h=1024
 *   → image/png（透明底，黄色网格线；前端自己调色）
 *
 * GET /cim/grid-overlay/status
 *   → 配置摘要（是否配置 token、允许的图层、缓存目录/TTL、不含 token 本身）
 *
 * 为什么要后端代理：token 是 CIM 平台级凭证（不同图层共用一把），
 * 放前端等于把整个平台的地图权限交出去；且内网地址必须由服务端访问。
 */
import {Router} from 'express';
import {fetchGridOverlay, cimOverlaySummary, CIM_LEVELS} from '../services/cimGridOverlayService';

export const cimOverlayRouter = Router();

cimOverlayRouter.get('/cim/grid-overlay/status', (_req, res) => {
  res.json({code: 200, message: 'ok', data: cimOverlaySummary()});
});

cimOverlayRouter.get('/cim/grid-overlay', async (req, res) => {
  const level = String(req.query.level ?? 'sqwg').trim();
  const raw = String(req.query.bbox ?? '').trim();
  const parts = raw.split(',').map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    res.status(400).json({code: 400, message: 'bbox 需要 W,S,E,N 四个数字（EPSG:4490 经纬度）', data: {levels: Object.keys(CIM_LEVELS)}});
    return;
  }
  const width = Number(req.query.w ?? 1024) || 1024;
  const height = Number(req.query.h ?? 1024) || 1024;
  const out = await fetchGridOverlay({level, bbox: [parts[0], parts[1], parts[2], parts[3]], width, height});
  if (!out.ok || !out.png) {
    // 边界层是增强项：失败不回 500，前端据此安静降级并在状态条说明
    res.status(502).json({code: 502, message: out.reason ?? 'CIM 出图失败', data: {level}});
    return;
  }
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'private, max-age=1800');
  res.setHeader('x-cim-level', level);
  res.setHeader('x-cim-cache', out.fromCache ? 'hit' : 'miss');
  if (out.reason) res.setHeader('x-cim-note', encodeURIComponent(out.reason));
  res.end(out.png);
});
