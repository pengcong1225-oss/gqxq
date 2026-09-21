// 统一错误码与错误类型。HTTP 状态码与响应体 code 保持一致（见方案 §5.1）。

export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE_CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  PAYLOAD_TOO_LARGE: 413,
  /** G6：来源适配器调用失败。用 502 而不是 500，便于与「我方缺陷」区分 */
  SOURCE_ADAPTER_UNAVAILABLE: 502,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface FieldError {
  field: string;
  message: string;
}

// 只承载 JWT 里真实存在的信息（sub / username / roles）。
// realName、permissions 等明细由 GET /auth/user-info 查库返回，不放进令牌。
export interface AuthUser {
  /** app_user.user_id */
  id: string;
  username: string;
  roles: string[];
}

export class AppError extends Error {
  readonly errorCode: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: FieldError[];
  readonly extra?: Record<string, unknown>;

  constructor(
    errorCode: ErrorCode,
    message: string,
    options: { fieldErrors?: FieldError[]; extra?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'AppError';
    this.errorCode = errorCode;
    this.status = ERROR_STATUS[errorCode];
    this.fieldErrors = options.fieldErrors;
    this.extra = options.extra;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  static validation(message: string, fieldErrors?: FieldError[]): AppError {
    return new AppError('VALIDATION_FAILED', message, { fieldErrors });
  }
  static notFound(message: string): AppError {
    return new AppError('NOT_FOUND', message);
  }
  static unauthenticated(message = '未认证或登录已过期'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }
  /** 401 与 403 语义分开：令牌没问题但角色不够，才是这里（见映射表 §4-3） */
  static forbidden(message = '无权限，请联系管理员'): AppError {
    return new AppError('FORBIDDEN', message);
  }
  static conflict(message: string): AppError {
    return new AppError('DUPLICATE_CONFLICT', message);
  }
  static notImplemented(message: string, batch: string): AppError {
    return new AppError('NOT_IMPLEMENTED', message, { extra: { batch } });
  }
  static internal(message: string, cause?: unknown): AppError {
    return new AppError('INTERNAL_ERROR', message, { cause });
  }
}
