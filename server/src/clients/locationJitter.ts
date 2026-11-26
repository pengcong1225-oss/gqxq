import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../config/env';

type Crs = 'EPSG:4326' | 'EPSG:4490';
interface Coordinates { longitude: number; latitude: number }
export interface JitterInput extends Coordinates { business_id: string }

export function inYichang(point: unknown): point is Coordinates {
  const { longitude, latitude } = (point ?? {}) as Partial<Coordinates>;
  return typeof longitude === 'number' && longitude >= 110 && longitude <= 112.3 &&
    typeof latitude === 'number' && latitude >= 29.5 && latitude <= 31.8;
}

function request(path: string, body?: object, idempotencyKey?: string): Promise<any> {
  const url = new URL(env.jitter.baseUrl.replace(/\/+$/, '') + '/api/v1/jitter/jobs' + path);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid_jitter_url');
  const content = body ? Buffer.from(JSON.stringify(body)) : undefined;
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, {
      method: body ? 'POST' : 'GET', rejectUnauthorized: !env.jitter.insecureTls,
      headers: { 'X-App-Id': env.jitter.appId, 'X-API-Key': env.jitter.apiKey,
        ...(content ? { 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/json', 'Content-Length': content.length } : {}) },
      signal: AbortSignal.timeout(env.jitter.timeoutMs),
    }, res => {
      const chunks: Buffer[] = [];
      let length = 0;
      res.on('error', reject);
      res.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024) req.destroy(new Error('jitter_response_limit'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('jitter_http_error'));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(content);
  });
}

export async function jitterLocations(crs: Crs, items: JitterInput[], key: string) {
  let job = await request('', { crs, items }, key);
  const jobId = job?.job_id;
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(jobId)) throw new Error('invalid_jitter_job');
  const expected = new Map(items.map(item => [item.business_id, item]));
  const points = new Map<string, Coordinates>();
  const seen = new Set<string>();
  const retry = new Set<string>();
  for (let poll = 0; ; poll++) {
    if (job?.job_id !== jobId || job?.simulated !== false || job?.crs !== crs) return { jobId, points, retry };
    if (!['queued', 'running'].includes(job.status)) break;
    if (poll >= env.jitter.pollMax) throw new Error('jitter_poll_timeout');
    await delay(env.jitter.pollMs);
    job = await request('/' + jobId);
  }
  if (job.status === 'interrupted') return { jobId, points, retry: new Set(expected.keys()) };
  if (!['succeeded', 'partial_failed', 'failed'].includes(job.status)) return { jobId, points, retry };

  for (let page = 1; page <= Math.ceil(items.length / 100); page++) {
    const result = await request(`/${jobId}/results?page=${page}&page_size=100`);
    if (result?.job_id !== jobId || result?.simulated !== false || !Array.isArray(result.items)) {
      throw new Error('invalid_jitter_results');
    }
    for (const item of result.items) {
      const original = expected.get(item?.business_id);
      if (!original) continue;
      const id = original.business_id;
      if (seen.has(id)) {
        points.delete(id);
        retry.delete(id);
        continue;
      }
      seen.add(id);
      if (item.simulated !== false || item.input?.business_id !== id || item.input.longitude !== original.longitude ||
          item.input.latitude !== original.latitude) continue;
      if (job.status !== 'failed' && item.status === 'success' &&
          (item.output?.crs === undefined || item.output.crs === crs) && inYichang(item.output)) points.set(id, item.output);
      if (item.status === 'failed' && item.error === 'upstream_unavailable') retry.add(id);
    }
    if (page * 100 >= result.total || !result.items.length) break;
  }
  return { jobId, points, retry };
}
