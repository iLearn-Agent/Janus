export class ApiError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details && typeof details === 'object' ? details : {};
  }
}

export function apiError(code, message, status = 400, details = {}) {
  return new ApiError(code, message, status, details);
}

export function errorResponse(error) {
  const status = Number(error?.status || 500);
  const code = error?.code || 'internal_error';
  const message = error?.message || '服务器开小差了，请稍后再试。';
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  return {
    status,
    body: {
      error: {
        code,
        message,
        details,
      },
    },
  };
}

export function mapPgError(error) {
  if (error?.code !== '23505') return null;
  const constraint = String(error.constraint || error.message || '');
  if (constraint.includes('users_email')) {
    return apiError('email_already_registered', '该邮箱已被注册。', 409);
  }
  if (constraint.includes('users_username')) {
    return apiError('username_already_taken', '该用户名已被其他账号使用。', 409);
  }
  return apiError('conflict', '数据已存在，请刷新后重试。', 409);
}
