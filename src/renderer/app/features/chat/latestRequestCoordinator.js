export function createLatestRequestCoordinator() {
  const latestVersionByKey = new Map();

  const normalizeKey = (key = '') => String(key || '').trim();

  return {
    begin(key = '') {
      const cleanKey = normalizeKey(key);
      if (!cleanKey) return 0;
      const version = (latestVersionByKey.get(cleanKey) || 0) + 1;
      latestVersionByKey.set(cleanKey, version);
      return version;
    },

    isLatest(key = '', version = 0) {
      const cleanKey = normalizeKey(key);
      return Boolean(cleanKey)
        && Number(version) > 0
        && latestVersionByKey.get(cleanKey) === Number(version);
    },
  };
}
