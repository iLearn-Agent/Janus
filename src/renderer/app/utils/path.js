export function pathBasename(value = '') {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized || '工作目录';
}
