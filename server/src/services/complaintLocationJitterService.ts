import { createHash, randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { buildComplaintScopeSql, type AccessContext } from '../auth/accessScope';
import { inYichang, jitterLocations } from '../clients/locationJitter';
import { env } from '../config/env';
import { pool } from '../db/pool';
import type { Tx } from '../db/tx';
import { excludeIntegrationTestsSql } from '../domain/integrationTestPolicy';
import { rowsIn } from '../repositories/serviceGridRepo';
import type { SqlExecutor } from '../repositories/userRepo';
import type { ComplaintDisplayLocation } from '../types/locationCorrection';

const inputHash = `sha2(cast(json_array(c.address,c.district_code,c.admin_grid_code,c.community_code,
  c.location_lng,c.location_lat,c.location_coordinate_system,c.location_coordinate_source) as char),256)`;
const eligible = `coalesce(c.deleted,0)=0 and c.location_coordinate_system in ('WGS84','CGCS2000')
  and c.location_coordinate_source is not null and c.location_coordinate_source not like '待纠偏%'
  and c.location_lng between 110 and 112.3 and c.location_lat between 29.5 and 31.8
  and ${excludeIntegrationTestsSql('c')}`;
const currentInput = `c.complaint_id=j.complaint_id and j.input_hash=${inputHash}`;

/** Queue only from a location writer holding the complaint lock. A new input gets a new generation. */
export async function queueComplaintLocationJitter(tx: Tx, complaintId: string) {
  await tx.execute(`delete j from complaint_location_jitter j join complaint c on c.complaint_id=j.complaint_id
    where c.complaint_id=? and (j.input_hash<>${inputHash} or not (${eligible}))`, [complaintId]);
  await tx.execute(`insert into complaint_location_jitter(complaint_id,generation,input_hash,state,next_attempt_at)
    select c.complaint_id,?,${inputHash},'pending',now() from complaint c where c.complaint_id=? and ${eligible}
    on duplicate key update generation=complaint_location_jitter.generation`, [randomUUID(), complaintId]);
}

export async function readComplaintJitterPoints(db: SqlExecutor, ids: readonly string[], access: AccessContext) {
  const points = new Map<string, ComplaintDisplayLocation>();
  const scope = buildComplaintScopeSql(access, 'c');
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const rows = await rowsIn(db, `select c.complaint_id,c.location_coordinate_system,j.longitude,j.latitude
      from complaint_location_jitter j join complaint c on ${currentInput}
      where j.state='succeeded' and ${eligible} and ${scope.sql} and c.complaint_id in (${batch.map(() => '?').join(',')})`,
    [...scope.params, ...batch]);
    for (const row of rows) {
      if (row.longitude == null || row.latitude == null) continue;
      const point = { longitude: Number(row.longitude), latitude: Number(row.latitude) };
      const crs = row.location_coordinate_system;
      if (inYichang(point) && (crs === 'WGS84' || crs === 'CGCS2000')) {
        points.set(String(row.complaint_id), { ...point, coordinateSystem: crs, coordinateSource: 'jitter' });
      }
    }
  }
  return points;
}

interface QueuedRow extends RowDataPacket {
  complaint_id: string; generation: string; next_attempt_at: Date;
  location_lng: string; location_lat: string; location_coordinate_system: 'WGS84' | 'CGCS2000';
}

export async function processComplaintLocationJitter() {
  if (!env.jitter.baseUrl || !env.jitter.appId || !env.jitter.apiKey) return;
  const db = await pool.getConnection();
  const lock = 'concat(left(database(),38),\':location-jitter\')';
  let locked = false;
  try {
    const [[result]] = await db.query<RowDataPacket[]>('select get_lock(' + lock + ',0) acquired');
    locked = Number(result?.acquired) === 1;
    if (!locked) return;
    const limit = Math.min(1000, Math.max(1, Math.trunc(env.jitter.batchSize) || 200));
    const [due] = await db.query<QueuedRow[]>(`select c.complaint_id,c.location_lng,c.location_lat,c.location_coordinate_system,
      j.generation,j.next_attempt_at from complaint_location_jitter j join complaint c on ${currentInput}
      where j.next_attempt_at<=now() and ${eligible} order by j.next_attempt_at,j.complaint_id limit ?`, [limit]);
    for (const [system, crs] of [['WGS84', 'EPSG:4326'], ['CGCS2000', 'EPSG:4490']] as const) {
      const rows = due.filter(row => row.location_coordinate_system === system);
      if (!rows.length) continue;
      const key = createHash('sha256').update(JSON.stringify(rows.map(r => [r.generation, r.next_attempt_at]))).digest('hex');
      const items = rows.map(row => ({ business_id: row.generation, longitude: Number(row.location_lng), latitude: Number(row.location_lat) }));
      const result = await jitterLocations(crs, items, 'gqxq-' + key).catch(() => null);
      for (const row of rows) {
        const point = result?.points.get(row.generation);
        const retry = !result || result.retry.has(row.generation);
        // A concurrent human revision replaces the generation before any results can be applied.
        await db.execute(`update complaint_location_jitter set state=?,job_id=?,longitude=?,latitude=?,
          next_attempt_at=if(?,date_add(now(),interval 5 minute),null) where complaint_id=? and generation=?`,
        [point ? 'succeeded' : 'failed', result?.jobId ?? null, point?.longitude ?? null, point?.latitude ?? null,
          retry, row.complaint_id, row.generation]);
      }
    }
  } finally {
    try { if (locked) await db.query('select release_lock(' + lock + ')'); }
    finally { db.release(); }
  }
}

export function startComplaintLocationJitter() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await processComplaintLocationJitter(); }
    catch { console.error('[location-jitter] 待处理位置保留，稍后重试'); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void run(), 15000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
