// POST /api/v1/external/yijiejieban/appeal
// 宜接就办入站接收：zod 严格校验 -> 单事务落库/幂等/重传留痕/人工字段保护/审计。
// 认证口径：本路由挂在 /external 下，不要求 Bearer（由 routes/index.ts 保证）。
// 校验失败也必须留痕（complaint_source_log.result = 'rejected'），不允许静默丢弃报文。
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError, type FieldError } from '../http/errors';
import { ok } from '../http/respond';
import { payloadHashOf } from '../repositories/canonicalJson';
import {
  GQXQ_APP_CODE,
  YIJIEJIEBAN_SYSTEM,
  intakeAppeal,
  logRejectedIntake,
  toPayloadObject,
  type IntakeCommand,
} from '../services/intakeService';
import { isValidCode } from '../domain/enums';

export const externalRouter = Router();

/** Express 4 不会捕获 async handler 的 rejection，必须显式转交 errorHandler */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res).catch(next);
  };
}

const LOWER_CODE = /^[a-z][a-z0-9_]*$/;

const BodySchema = z.object({
  sourceId: z.string().max(128).nullish(),
  appealId: z.string().max(128).nullish(),
  title: z.string().nullish(),
  content: z.string().max(20000).nullish(),
  address: z.string().max(500).nullish(),
  districtCode: z.string().max(32).nullish(),
  districtName: z.string().max(64).nullish(),
  source: z.string().max(64).nullish(),
  businessType: z.string().max(32).nullish(),
  complaintType: z.string().max(32).nullish(),
  urgencyLevel: z.string().max(32).nullish(),
  longitude: z.number().finite().nullish(),
  latitude: z.number().finite().nullish(),
  createdAt: z.string().max(64).nullish(),
  // 来源原值残留（导出表里的「督办状态」「诉求类型」原文、二级单位、处理结果等）：
  // 平台没有对应列，但**不丢**——随整包落 complaint.source_payload，可追溯、可回放。
  metadata: z.record(z.unknown()).nullish(),
});

/** 宜昌辖区大致范围；超范围**不拒单**，置 null 并写告警 */
const LNG_MIN = 110.0;
const LNG_MAX = 113.0;
const LAT_MIN = 29.5;
const LAT_MAX = 32.0;

/** ISO-8601 且**必须带时区偏移**（Z 或 ±HH:MM / ±HHMM） */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})$/;

function optText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text === '') return null;
  return text.slice(0, max);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 被拒时也要能写出 source_system/source_id（列 not null） */
function salvageSourceId(raw: unknown): string {
  if (isPlainObject(raw)) {
    const candidate = raw.sourceId ?? raw.appealId;
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 128);
  }
  return '(unknown)';
}

externalRouter.post(
  '/yijiejieban/appeal',
  asyncHandler(async (req, res) => {
    const receivedAt = new Date();
    const raw = req.body as unknown;
    const remoteIp = req.remoteIp ?? null;
    const requestId = req.requestId ?? null;
    const payload = toPayloadObject(raw);

    /** 一旦校验不通过：先留痕（事务外），再按统一封套返回 400 */
    const reject = async (message: string, fieldErrors: FieldError[]): Promise<never> => {
      await logRejectedIntake({
        sourceSystem: YIJIEJIEBAN_SYSTEM,
        sourceId: salvageSourceId(raw),
        payload,
        payloadHash: payloadHashOf(payload),
        message: fieldErrors.length > 0 ? message + '：' + fieldErrors.map((e) => e.field + ' ' + e.message).join('; ') : message,
        remoteIp,
        requestId,
        receivedAt,
      });
      throw AppError.validation(message, fieldErrors);
    };

    if (!isPlainObject(raw)) {
      return reject('请求体必须是单个 JSON 对象', [{ field: 'body', message: '期望 JSON 对象，实际为 ' + (Array.isArray(raw) ? 'array' : typeof raw) }]);
    }
    const body = raw as Record<string, unknown>;

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      const errors: FieldError[] = parsed.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : 'body',
        message: issue.message,
      }));
      return reject('报文校验失败', errors);
    }
    const data = parsed.data;

    const errors: FieldError[] = [];

    // complaint.title 是 varchar(255)：这里必须**按列宽拦住并给 400**。
    // 之前截到 500，256–500 字的标题会一路走到 INSERT 撞 ER_DATA_TOO_LONG，
    // 统一封套就把"对方输入不合法（400）"报成了"我们崩了（500）"。
    // 完整标题本就在 source_payload 里，收敛列值不丢任何信息。
    const TITLE_MAX = 255;
    const titleRaw = data.title === null || data.title === undefined ? '' : String(data.title).trim();
    if (titleRaw === '') {
      errors.push({ field: 'title', message: 'title 必填' });
    } else if (titleRaw.length > TITLE_MAX) {
      errors.push({
        field: 'title',
        message: 'title 最长 ' + TITLE_MAX + ' 字，实际 ' + titleRaw.length + ' 字（完整报文已存 source_payload）',
      });
    }
    const title = titleRaw.slice(0, TITLE_MAX);

    const sourceId = optText(data.sourceId, 128) ?? optText(data.appealId, 128) ?? '';
    if (sourceId === '') errors.push({ field: 'sourceId', message: 'sourceId（或 appealId）必填' });

    // 分类码：给了就必须是小写合法码
    const codeFields: Array<[string, string | null | undefined, 'business_type' | 'complaint_type' | 'urgency_level']> = [
      ['businessType', data.businessType, 'business_type'],
      ['complaintType', data.complaintType, 'complaint_type'],
      ['urgencyLevel', data.urgencyLevel, 'urgency_level'],
    ];
    const explicit: Record<string, string | null> = { businessType: null, complaintType: null, urgencyLevel: null };
    for (const [field, value, dict] of codeFields) {
      const text = optText(value, 32);
      if (text === null) continue;
      if (!LOWER_CODE.test(text) || !isValidCode(dict, text)) {
        errors.push({ field, message: '不是合法的 ' + dict + ' 小写码：' + text });
        continue;
      }
      explicit[field] = text;
    }

    // 经纬度必须成对
    const hasLng = data.longitude !== null && data.longitude !== undefined;
    const hasLat = data.latitude !== null && data.latitude !== undefined;
    if (hasLng !== hasLat) {
      errors.push({ field: hasLng ? 'latitude' : 'longitude', message: 'longitude 与 latitude 必须成对提供' });
    }

    // createdAt 必须带时区偏移
    let sourceReportedAt: Date | null = null;
    const createdAtText = optText(data.createdAt, 64);
    if (createdAtText !== null) {
      if (!ISO_WITH_OFFSET.test(createdAtText)) {
        errors.push({ field: 'createdAt', message: 'createdAt 必须是带时区偏移的 ISO-8601（如 2026-09-14T08:30:00+08:00）' });
      } else {
        const parsedDate = new Date(createdAtText);
        if (Number.isNaN(parsedDate.getTime())) {
          errors.push({ field: 'createdAt', message: 'createdAt 不是合法时间：' + createdAtText });
        } else {
          sourceReportedAt = parsedDate;
        }
      }
    }

    if (errors.length > 0) {
      return reject('报文校验失败', errors);
    }

    // 超范围不拒单：置 null + 告警
    const warnings: string[] = [];
    let longitude: number | null = hasLng ? (data.longitude as number) : null;
    let latitude: number | null = hasLat ? (data.latitude as number) : null;
    if (longitude !== null && (longitude < LNG_MIN || longitude > LNG_MAX)) {
      warnings.push('longitude=' + longitude + ' 超出宜昌范围 [' + LNG_MIN + ', ' + LNG_MAX + ']，已置空');
      longitude = null;
    }
    if (latitude !== null && (latitude < LAT_MIN || latitude > LAT_MAX)) {
      warnings.push('latitude=' + latitude + ' 超出宜昌范围 [' + LAT_MIN + ', ' + LAT_MAX + ']，已置空');
      latitude = null;
    }
    if (longitude === null && latitude === null && (hasLng || hasLat)) {
      warnings.push('坐标已全部置空，落库 location_lng/location_lat 为 NULL');
    }

    const command: IntakeCommand = {
      sourceSystem: YIJIEJIEBAN_SYSTEM,
      sourceId,
      channel: optText(data.source, 64),
      title,
      content: optText(data.content, 20000),
      address: optText(data.address, 500),
      districtCode: optText(data.districtCode, 32),
      districtName: optText(data.districtName, 64),
      longitude,
      latitude,
      explicitBusinessType: explicit.businessType,
      explicitComplaintType: explicit.complaintType,
      explicitUrgencyLevel: explicit.urgencyLevel,
      sourceReportedAt,
      payload,
      payloadHash: payloadHashOf(payload),
      warnings,
      remoteIp,
      requestId,
    };

    const result = await intakeAppeal(command, { receivedAt });
    const message = result.result === 'created' ? 'success' : result.result === 'duplicate_same' ? 'duplicate' : 'updated';
    ok(res, result, message);
  })
);

export { asyncHandler, GQXQ_APP_CODE };
