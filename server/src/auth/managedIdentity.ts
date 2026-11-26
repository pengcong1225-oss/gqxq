import { readFile } from 'node:fs/promises';
import { env } from '../config/env';
import { pool, type Row } from '../db/pool';
import { withTransaction } from '../db/tx';
import { AppError } from '../http/errors';

type Binding = { issuer: string; subject: string; userId: string; fromLegacy?: boolean };
type Assignment = { active: boolean; assigned: boolean; legacy_account_id?: string; authorization_version: number };
type PlatformStatus = { active: boolean; subject: string; authVersion: number };
export type ManagedSession = { subject: string; assignmentVersion: number; authVersion: number; sessionJti?: string };
type PlatformContext = Pick<ManagedSession, 'authVersion' | 'sessionJti'>;
type Event = { app_id: string; issuer: string; subject: string; legacy_account_id?: string; operation_id: string; sequence: number };
type AssignmentPage = { items: Event[]; next_cursor: number; has_more: boolean };

const appId = 'gqxq-service';
const assignmentFile = process.env.GQXQ_SUBJECT_ASSIGNMENT_CREDENTIALS_FILE;
const platformFile = process.env.GQXQ_PLATFORM_SUBJECT_VERIFICATION_FILE;
const assignmentUrl = process.env.GQXQ_SUBJECT_ASSIGNMENT_BASE_URL ?? 'http://127.0.0.1:8096';
const platformUrl = process.env.GQXQ_PLATFORM_SUBJECT_VERIFICATION_URL ?? 'http://127.0.0.1:8088/api/integrations/subjects/verify';
const assignmentPath = '/api/v1/subsystem-integration';
const lookupColumns = 'select issuer, subject, user_id as userId, (from_legacy = 1) as fromLegacy from managed_platform_identity';

function serviceUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('invalid identity integration URL');
  }
  return url;
}

async function secret(file: string | undefined, key: string): Promise<string> {
  if (!file) throw new Error('identity integration not configured');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'))[key];
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) throw new Error('invalid identity integration credential');
  return value;
}

async function serviceJson<T>(url: URL, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('identity integration unavailable');
  return await response.json() as T;
}

async function assignmentCall<T>(route: string, body?: unknown): Promise<T> {
  const headers = {
    'X-App-Id': appId,
    'X-API-Key': await secret(assignmentFile, 'api_key'),
    'Content-Type': 'application/json',
  };
  return serviceJson<T>(serviceUrl(`${assignmentUrl.replace(/\/$/, '')}${assignmentPath}${route}`), {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function verifySubject(subject: string, context?: PlatformContext): Promise<PlatformStatus> {
  const headers = { 'X-Integration-Key': await secret(platformFile, 'integration_key'), 'Content-Type': 'application/json' };
  return serviceJson<PlatformStatus>(serviceUrl(platformUrl), { method: 'POST', headers, body: JSON.stringify({ subject, ...context }) });
}

function currentAccess(binding: Binding, assignment: Assignment, platform: PlatformStatus): boolean {
  return assignment.active === true && assignment.assigned === true && (assignment.legacy_account_id === binding.userId || (binding.fromLegacy === true && !assignment.legacy_account_id))
    && Number.isSafeInteger(assignment.authorization_version) && assignment.authorization_version > 0
    && platform.active === true && platform.subject === binding.subject
    && Number.isSafeInteger(platform.authVersion) && platform.authVersion >= 0;
}

export function sessionHasCurrentAccess(
  binding: Binding, assignment: Assignment, platform: PlatformStatus, session?: ManagedSession,
): boolean {
  return currentAccess(binding, assignment, platform) && session?.subject === binding.subject
    && session.assignmentVersion === assignment.authorization_version && session.authVersion === platform.authVersion
    && (session.sessionJti === undefined || (typeof session.sessionJti === 'string' && session.sessionJti.length > 0));
}

async function gate(binding: Binding, context?: PlatformContext) {
  try {
    const query = new URLSearchParams({ issuer: binding.issuer, subject: binding.subject });
    const [assignment, platform] = await Promise.all([
      assignmentCall<Assignment & { app_id?: string; issuer?: string; subject?: string }>(`/assignment?${query}`),
      verifySubject(binding.subject, context),
    ]);
    if (assignment.app_id !== appId || assignment.issuer !== binding.issuer || assignment.subject !== binding.subject) {
      throw new Error('unexpected assignment identity');
    }
    return { assignment, platform };
  } catch {
    throw new AppError('SOURCE_ADAPTER_UNAVAILABLE', '统一身份授权核验暂不可用');
  }
}

export async function createManagedSession(binding: Binding, context?: PlatformContext): Promise<ManagedSession> {
  const { assignment, platform } = await gate(binding, context);
  if (!currentAccess(binding, assignment, platform) || (context && platform.authVersion !== context.authVersion)) {
    throw AppError.unauthenticated('诉求应用权限已停用或尚未开通');
  }
  return { subject: binding.subject, assignmentVersion: assignment.authorization_version, authVersion: platform.authVersion, sessionJti: context?.sessionJti };
}

export async function checkManagedSession(binding: Binding, session?: ManagedSession): Promise<void> {
  if (!session || session.subject !== binding.subject || !Number.isSafeInteger(session.authVersion)) {
    throw AppError.unauthenticated('登录状态已失效，请重新登录');
  }
  const { assignment, platform } = await gate(binding, { authVersion: session.authVersion, sessionJti: session.sessionJti });
  if (!sessionHasCurrentAccess(binding, assignment, platform, session)) {
    throw AppError.unauthenticated('诉求应用权限已停用或已变更，请重新登录');
  }
}

async function lookup(where: string, values: string[]): Promise<Binding | null> {
  try {
    const [rows] = await pool.query<(Row & Binding)[]>(`${lookupColumns} where ${where} limit 1`, values);
    const binding = rows[0];
    return binding ? { ...binding, fromLegacy: Boolean(binding.fromLegacy) } : null;
  } catch (error) {
    // Installations without managed identity can still use their existing local authentication.
    if (!assignmentFile && !platformFile && (error as { code?: string }).code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}

/** Check a legacy platform association while its central event is still in flight. */
export async function checkLegacyPlatformAccess(
  userId: string,
  claims?: { sub?: string; jti?: string; auth_version?: number },
): Promise<void> {
  if (!assignmentFile || !platformFile) return;
  const [bindings] = await pool.query<(Row & Binding)[]>(
    'select issuer, subject, user_id as userId from platform_identity where user_id = ? and issuer = ?',
    [userId, env.platformIdentityIssuer],
  );
  for (const binding of bindings) {
    if (claims && claims.sub !== binding.subject) continue;
    const context = claims && { authVersion: claims.auth_version ?? 0, sessionJti: claims.jti };
    const { assignment, platform } = await gate(binding, context);
    if (assignment.assigned === true || platform.active !== true || platform.subject !== binding.subject) {
      throw AppError.unauthenticated('诉求应用权限已停用或正在同步，请重新登录');
    }
  }
}

export function findManagedBySubject(issuer: string, subject: string) {
  return lookup('issuer = ? and subject = ?', [issuer, subject]);
}

export function findManagedByUser(userId: string) {
  return lookup('user_id = ?', [userId]);
}

async function bindEvent(event: Event): Promise<string | undefined> {
  if (event.app_id !== appId || event.issuer !== env.platformIdentityIssuer || typeof event.subject !== 'string' || !event.subject || event.subject.length > 191) {
    return 'invalid_subject';
  }
  return withTransaction(async (tx) => {
    const [existingRows] = await tx.query<(Row & Binding)[]>(`${lookupColumns} where issuer = ? and subject = ? for update`, [event.issuer, event.subject]);
    const existing = existingRows[0];
    const [oldSubject] = await tx.query<(Row & Binding)[]>(
      'select issuer, subject, user_id as userId from platform_identity where issuer = ? and subject = ? for update',
      [event.issuer, event.subject],
    );
    const oldBinding = oldSubject.find((row) => row.issuer === event.issuer && row.subject === event.subject);
    const legacyId = event.legacy_account_id ?? existing?.userId ?? oldBinding?.userId;
    if (!legacyId) return undefined;
    if (typeof legacyId !== 'string' || legacyId.length > 64) return 'legacy_account_required';
    const [users] = await tx.query<(Row & { user_id: string })[]>('select user_id from app_user where user_id = ? for update', [legacyId]);
    if (users[0]?.user_id !== legacyId) return 'legacy_account_not_found';
    const [managed] = await tx.query<(Row & Binding)[]>(`${lookupColumns} where user_id = ? for update`, [legacyId]);
    const [legacy] = await tx.query<(Row & Binding)[]>(
      'select issuer, subject, user_id as userId from platform_identity where (issuer = ? and subject = ?) or user_id = ? for update',
      [event.issuer, event.subject, legacyId],
    );
    if (existing && existing.userId !== legacyId || [...managed, ...legacy].some((row) => row.issuer !== event.issuer || row.subject !== event.subject || row.userId !== legacyId)) {
      return 'legacy_account_conflict';
    }
    if (!existing) await tx.query('insert into managed_platform_identity (issuer, subject, user_id, from_legacy) values (?, ?, ?, ?)', [event.issuer, event.subject, legacyId, Number(Boolean(oldBinding))]);
    return undefined;
  });
}

async function syncAssignments(): Promise<void> {
  const [rows] = await pool.query<(Row & { last_sequence: number })[]>('select last_sequence from platform_access_sync where app_id = ?', [appId]);
  let after = Number(rows[0]?.last_sequence ?? 0);
  const page = await assignmentCall<AssignmentPage>(`/changes?after=${after}&limit=50`);
  for (const event of page.items) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= after || typeof event.operation_id !== 'string' || !event.operation_id) {
      throw new Error('invalid assignment event sequence');
    }
    const reason = await bindEvent(event);
    await assignmentCall('/receipts', { operation_id: event.operation_id, sequence: event.sequence, status: reason ? 'failed' : 'applied', reason });
    await pool.query('insert into platform_access_sync (app_id, last_sequence) values (?, ?) on duplicate key update last_sequence = greatest(last_sequence, ?)', [appId, event.sequence, event.sequence]);
    after = event.sequence;
  }
}

export async function startSubjectAssignmentSync(): Promise<() => void> {
  if (!assignmentFile && !platformFile) return () => undefined;
  if (!assignmentFile || !platformFile || !env.platformIdentityEnabled || !env.platformIdentityIssuer) throw new Error('incomplete subject integration configuration');
  await pool.query(`${lookupColumns} limit 0`);
  await pool.query('select last_sequence from platform_access_sync limit 0');
  let running = false;
  let reportingFailure = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await syncAssignments();
      reportingFailure = false;
    } catch {
      if (!reportingFailure) console.error('[identity] assignment synchronization unavailable; will retry');
      reportingFailure = true;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void poll(), 2000);
  timer.unref();
  void poll();
  return () => clearInterval(timer);
}
