export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_REQUIREMENTS_MESSAGE = '密码至少需要 8 位，并同时包含字母和数字。';

export function passwordValidationMessage(password = '') {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH) return '密码至少需要 8 位。';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '密码必须同时包含字母和数字。';
  return '';
}
