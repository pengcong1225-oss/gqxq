import { amapConfigured } from '../clients/amapGeocoder';
import { pool } from '../db/pool';
import type { Tx } from '../db/tx';
import { parseFieldState, type EffectiveFieldState } from '../domain/effectiveFieldPolicy';
import { mayRefineLocation, shouldImproveLocation } from '../domain/locationCandidates';
import { fallbackLocation, type InitialPoint } from '../domain/locationFallback';
import { insertAudit } from '../repositories/auditLogRepo';
import { insertFieldVersions } from '../repositories/complaintFieldVersionRepo';
import { loadEffectiveFieldState } from '../repositories/effectiveFieldRepo';
import { complaintAddressQuery, matchComplaintGridIn, registeredCommunityPoint, verifyComplaintAddress } from './complaintAddressResolution';
import { recognizeCommunityIn } from './communityRecognitionService';
import { queueComplaintLocationJitter } from './complaintLocationJitterService';

const JOB_VERSION = '地址归网v5：';
const fingerprint = "sha2(concat_ws(char(0),coalesce(c.address,''),coalesce(c.title,''),coalesce(c.content,''),coalesce(c.district_code,''),coalesce(c.district_name,''),coalesce(a.candidate_text,''),coalesce(a.parent_match,''),coalesce(a.district_code,'')),256)";
const locationFields = ['location_lng', 'location_lat', 'location_coordinate_system', 'location_coordinate_source'];
const addressFields = ['address', 'district_code', 'district_name', 'street_name', 'community_name', 'community_code', 'grid_name', 'admin_grid_code'];
type LocationUpdates = Record<string, { value: string | number; reason: string }>;

async function initializationState(db: Tx, row: Record<string, unknown>): Promise<EffectiveFieldState> {
  const raw = parseFieldState(row.effective_field_state);
  const states = await loadEffectiveFieldState(db, row);
  const fields = [...locationFields, ...addressFields];
  const [manual] = await db.query<any[]>(
    "select distinct field_name from complaint_field_version where complaint_id=? and change_source='manual_edit' and field_name in (" +
    fields.map(() => '?').join(',') + ')', [row.complaint_id, ...fields]);
  for (const entry of manual) {
    const field = String(entry.field_name);
    if (!states[field] || states[field].resolution === 'unresolved') {
      states[field] = { resolution: 'needs_verification', value: row[field] ?? null,
        version: Number(row.edit_version), reason: '存在人工字段决定，保留有效值' };
    }
  }

  // Legacy imported records with empty coordinates can be located if no human position decision exists.
  // This exception is limited to coordinates. Historical address / area decisions still require proof.
  if (row.location_lng == null && row.location_lat == null && !raw.location_lng && !raw.location_lat &&
      !manual.some(entry => locationFields.includes(entry.field_name) || ['address', 'district_code', 'district_name'].includes(entry.field_name))) {
    const [history] = await db.query<any[]>(
      "select 1 from correction_item where complaint_id=? and field_name in ('location_lng','location_lat','location_group','address','district_name') and status in ('confirmed','rejected') limit 1",
      [row.complaint_id]);
    if (!history.length) for (const field of ['location_lng', 'location_lat']) {
      states[field] = { resolution: 'unresolved', value: null, version: Number(row.edit_version),
        reason: '已授权初始化原始导入空坐标，未发现人工位置决定' };
    }
  }
  return states;
}

function protectedField(fields: EffectiveFieldState, field: string): boolean {
  const entry = fields[field];
  return !!entry && (entry.resolution !== 'unresolved' || !!entry.correctionId);
}

function availableField(row: Record<string, unknown>, fields: EffectiveFieldState, field: string): boolean {
  return !protectedField(fields, field) && (row[field] == null || row[field] === '');
}

function mayUseLocation(row: Record<string, unknown>, fields: EffectiveFieldState): boolean {
  return !Number(row.closed_in_system) && locationFields.every(field => !protectedField(fields, field)) &&
    mayRefineLocation({ ...row, effective_field_state: fields });
}

export async function initializeLocations(limit = 20, complaintId?: string) {
  const counts = { processed: 0, matched: 0, review: 0, retry: 0, preserved: 0 };
  const db = await pool.getConnection();
  let locked = false;
  try {
    // Keep the advisory lock on this connection; perform external requests before opening a transaction.
    for (let attempt = 0; attempt < (complaintId ? 10 : 1); attempt++) {
      const [[lock]] = await db.query<any[]>("select get_lock('gqxq-location-init',0) acquired");
      if (lock?.acquired) { locked = true; break; }
      if (complaintId) await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!locked) return counts;
    const [rows] = await db.query<any[]>(
      `select c.*,a.parent_match,${fingerprint} init_hash,
        case when j.input_hash=${fingerprint} then coalesce(j.attempts,0) else 0 end attempts
        from complaint c left join complaint_address_candidate a on a.complaint_id=c.complaint_id
        left join complaint_location_initialization j on j.complaint_id=c.complaint_id
        where coalesce(c.deleted,0)=0 and coalesce(c.closed_in_system,0)=0
          and ((c.location_lng is null and c.location_lat is null) or c.location_coordinate_source like '待纠偏：%')
          and (j.complaint_id is null or j.input_hash<>${fingerprint} or
            (j.state='retry' and j.next_attempt_at<=now()) or (j.state='review' and j.reason not like ?))
          ${complaintId ? 'and c.complaint_id=?' : ''}
        order by (c.created_at > date_sub(now(), interval 10 minute)) desc, j.updated_at is not null, j.updated_at, c.id limit ?`,
      [JOB_VERSION + '%', ...(complaintId ? [complaintId] : []), Math.min(100, Math.max(1, limit))]);

    for (const row of rows) {
      const priorState = await initializationState(db, row);
      const input = complaintAddressQuery({ ...row, effective_field_state: priorState });
      const mayLocate = mayUseLocation(row, priorState);
      const addressCleared = !row.address && protectedField(priorState, 'address');
      const resolution = mayLocate && input && amapConfigured() ? await verifyComplaintAddress(row, input) : null;
      let state: keyof Omit<typeof counts, 'processed'> = 'review';
      let reason = '缺少可可靠定位的详细地址，待人工核验';
      let point: InitialPoint | null = null;
      if (!mayLocate) {
        state = 'preserved';
        reason = '保留既有位置或人工核验决定';
      } else if (input && !amapConfigured()) {
        state = 'retry';
        reason = '未配置高德 Key，保留地址待配置后重试';
      } else if (resolution && resolution.state !== 'verified') {
        state = resolution.state;
        reason = resolution.reason;
        point = resolution.point ?? null;
      }
      if (mayLocate && !addressCleared && !input?.gridName && resolution?.state !== 'verified') {
        if (!resolution || resolution.state === 'retry' || point) {
          const registered = await registeredCommunityPoint(db, { ...row, effective_field_state: priorState }, input);
          if (registered) {
            point = registered;
            reason = `${registered.source}；${reason}`;
          }
        }
        if (!point) point = fallbackLocation(row);
      }

      await db.beginTransaction();
      try {
        // Master-data writers lock grid and community before complaint/related rows.
        const verified = resolution?.state === 'verified' ? resolution.evidence : null;
        const gridMatch = verified ? await matchComplaintGridIn(db, verified) : null;
        const communities = gridMatch?.grid && verified?.communityName
          ? (await db.query<any[]>('select code,name from community where admin_grid_code=? and name=? order by code for share',
            [gridMatch.grid.code, verified.communityName]))[0].filter(entry => entry.name === verified.communityName)
          : [];
        const [[current]] = await db.query<any[]>('select * from complaint where complaint_id=? for update', [row.complaint_id]);
        const [[evidence]] = await db.query<any[]>(
          `select ${fingerprint} init_hash from complaint c left join complaint_address_candidate a on a.complaint_id=c.complaint_id where c.complaint_id=? for update`,
          [row.complaint_id]);
        if (!current || Number(current.deleted) || evidence?.init_hash !== row.init_hash || Number(current.edit_version) !== Number(row.edit_version)) {
          await db.rollback();
          continue;
        }

        const fields = await initializationState(db, current);
        const updates: LocationUpdates = {};
        const fill = (field: string, value: string | null, basis: string) => {
          if (value && availableField(current, fields, field)) updates[field] = { value, reason: basis };
        };
        let usedGrid: NonNullable<typeof gridMatch>['grid'] = null;
        const storedSource = String(current.location_coordinate_source ?? '');
        if (storedSource.startsWith('待纠偏：') && storedSource.includes('实际精度兴趣点') && !Number(current.closed_in_system) &&
            [...locationFields, 'address', 'district_code', 'district_name'].every(field => !protectedField(fields, field)) &&
            await recognizeCommunityIn(db, row.complaint_id)) {
          await queueComplaintLocationJitter(db, row.complaint_id);
          state = 'review';
          reason = '已沿用既有小区级位置自动认可，网格待核验';
          point = null;
        } else if (!mayUseLocation(current, fields)) {
          state = 'preserved';
          reason = '保留既有位置或人工核验决定';
          point = null;
        } else if (verified?.namedGrid && gridMatch && !gridMatch.grid) {
          reason = gridMatch.reason;
        } else if (verified && input && gridMatch) {
          point = verified.namedGrid ? null : verified.point;
          const locationBasis = verified.namedGrid ? gridMatch.reason : verified.point.source;
          if (!verified.namedGrid) fill('address', input.address, locationBasis);
          fill('district_name', verified.districtName, locationBasis);
          fill('district_code', verified.districtCode, locationBasis);
          fill('street_name', verified.streetName, '高德逆地理编码与批准的宜昌区划名录一致');
          fill('community_name', verified.communityName, '文本小区名称与高德标准地址一致');

          const notes: string[] = verified.namedGrid ? ['详细地址和坐标待核验'] : [];
          if (!verified.namedGrid && current.address && current.address !== input.address) notes.push('保留既有地址，提取地址待核验');
          if (!verified.namedGrid && !verified.streetName) notes.push('街道未匹配批准的区划名录，待核验');
          const compatible = (field: string, value: string | null) => Boolean(value) &&
            (String(current[field] ?? '') === value || availableField(current, fields, field));
          const grid = gridMatch.grid;
          if (grid && compatible('district_code', verified.districtCode) && compatible('district_name', verified.districtName) &&
              (!current.street_name || current.street_name === verified.streetName) &&
              compatible('admin_grid_code', grid.code) && compatible('grid_name', grid.name)) {
            fill('admin_grid_code', grid.code, gridMatch.reason);
            fill('grid_name', grid.name, gridMatch.reason);
            usedGrid = grid;
            if (communities.length === 1 && compatible('community_name', verified.communityName)) {
              fill('community_code', String(communities[0].code), '正式网格内小区主数据名称唯一匹配');
              if (!compatible('community_code', String(communities[0].code))) notes.push('既有小区编码保留，小区待核验');
            }
          } else {
            notes.push(grid ? '既有区划或网格字段保留，网格待核验' : gridMatch.reason);
          }
          if (verified.communityName && communities.length !== 1) notes.push('小区主数据编码缺少唯一对应，待核验');
          state = notes.length ? 'review' : 'matched';
          reason = notes.length ? [locationBasis, ...notes].join('；') : locationBasis + '；' + gridMatch.reason;
        }

        if (point && shouldImproveLocation(current, point)) {
          const values = { location_lng: point.longitude, location_lat: point.latitude,
            location_coordinate_system: point.coordinateSystem, location_coordinate_source: point.source };
          for (const [field, value] of Object.entries(values)) updates[field] = { value, reason: point.source };
        }
        const changes = Object.entries(updates);
        if (changes.length) {
          const version = Number(current.edit_version) + 1;
          for (const [field, { value, reason }] of changes) fields[field] = { resolution: 'unresolved', value, version, reason };
          await db.query('update complaint set ' + changes.map(([field]) => field + '=?').join(',') +
            ',effective_field_state=?,edit_version=? where complaint_id=?',
            [...changes.map(([, change]) => change.value), JSON.stringify(fields), version, row.complaint_id]);
          if (verified && updates.location_lng) await queueComplaintLocationJitter(db, row.complaint_id);
          const now = new Date();
          await insertFieldVersions(db, changes.map(([field, change]) => ({ complaintId: row.complaint_id,
            fieldName: field, oldValue: current[field] == null ? null : String(current[field]), newValue: String(change.value),
            changeSource: 'rule_engine', reason: change.reason, operatorId: null, operatorName: null, changedAt: now })));
          await insertAudit(db, { userId: null, appCode: 'gqxq', resourceCode: 'location', action: 'LOCATION_AUTO_INITIALIZE',
            bizType: 'complaint', bizId: row.complaint_id, result: 'success', clientIp: null, createdAt: now,
            detail: { provider: point?.level === '区县代表点' ? 'datav-district' : point?.source.includes('小区主数据匹配') ? 'community' : 'amap',
              addressEvidence: input?.evidence ?? null, coordinateSystem: point?.coordinateSystem,
              needsCorrection: state !== 'matched', level: point?.level, districtCode: verified?.districtCode,
              streetCode: verified?.streetCode, fields: changes.map(([field]) => field), grid: usedGrid } });
        }
        await db.query(
          'insert into complaint_location_initialization(complaint_id,input_hash,state,reason,attempts,next_attempt_at,updated_at) values(?,?,?,?,?,date_add(now(),interval 5 minute),now()) ' +
          'on duplicate key update input_hash=values(input_hash),state=values(state),reason=values(reason),attempts=values(attempts),next_attempt_at=values(next_attempt_at),updated_at=now()',
          [row.complaint_id, row.init_hash, state, (JOB_VERSION + reason).slice(0, 500), Number(row.attempts) + 1]);
        await db.commit();
        counts.processed++;
        counts[state]++;
      } catch (error) {
        await db.rollback();
        throw error;
      }
    }
    return counts;
  } finally {
    try { if (locked) await db.query("select release_lock('gqxq-location-init')"); }
    finally { db.release(); }
  }
}

/** The same initializer handles direct intake, file imports and queued retries. */
export function startLocationInitializer() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await initializeLocations();
      if (result.processed) console.log('[location-init]', JSON.stringify(result));
    } catch {
      console.error('[location-init] initialization retained for retry');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void run(), 15000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
