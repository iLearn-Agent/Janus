const LEDGER_PREFIX = 'social:automation_ledger_v1';
const MAX_LEDGER_ITEMS = 10_000;
const MAX_LEDGER_SCOPES = 1_000;

function segment(value = '') {
  return encodeURIComponent(String(value || '').trim() || '_');
}

function bucketKey({ userId = '', workspaceId = '', automationType = '' } = {}) {
  return `${LEDGER_PREFIX}:${segment(userId)}:${segment(workspaceId)}:${segment(automationType)}`;
}

function emptyBucket() {
  return { items: Object.create(null), scopes: Object.create(null) };
}

function boundedObject(value = {}, limit = 1) {
  const entries = Object.entries(value || {});
  return Object.assign(Object.create(null), Object.fromEntries(
    entries.slice(Math.max(0, entries.length - Math.max(1, limit))),
  ));
}

export function createSocialAutomationLedger({ store } = {}) {
  const cache = new Map();
  const loadBucket = (identity = {}) => {
    const key = bucketKey(identity);
    if (cache.has(key)) return { key, bucket: cache.get(key) };
    let bucket = emptyBucket();
    try {
      const parsed = JSON.parse(String(store?.settingGet?.(key, '') || ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bucket = {
          items: Object.assign(Object.create(null), parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items) ? parsed.items : {}),
          scopes: Object.assign(Object.create(null), parsed.scopes && typeof parsed.scopes === 'object' && !Array.isArray(parsed.scopes) ? parsed.scopes : {}),
        };
      }
    } catch {
      bucket = emptyBucket();
    }
    cache.set(key, bucket);
    return { key, bucket };
  };
  const saveBucket = (key, bucket) => {
    bucket.items = boundedObject(bucket.items, MAX_LEDGER_ITEMS);
    bucket.scopes = boundedObject(bucket.scopes, MAX_LEDGER_SCOPES);
    cache.set(key, bucket);
    store?.settingSet?.(key, JSON.stringify(bucket));
  };
  const hasProcessed = (identity = {}) => {
    const sourceMessageId = String(identity.sourceMessageId || '').trim();
    return Boolean(sourceMessageId && Object.hasOwn(loadBucket(identity).bucket.items, sourceMessageId));
  };
  const markProcessed = (identity = {}, state = 'processed') => {
    const sourceMessageId = String(identity.sourceMessageId || '').trim();
    if (!sourceMessageId) return false;
    const { key, bucket } = loadBucket(identity);
    delete bucket.items[sourceMessageId];
    bucket.items[sourceMessageId] = { state, recordedAt: new Date().toISOString() };
    saveBucket(key, bucket);
    return true;
  };
  const scopeInitialized = (identity = {}) => {
    const scopeId = String(identity.scopeId || '').trim();
    return Boolean(scopeId && Object.hasOwn(loadBucket(identity).bucket.scopes, scopeId));
  };
  const markScopeInitialized = (identity = {}) => {
    const scopeId = String(identity.scopeId || '').trim();
    if (!scopeId) return false;
    const { key, bucket } = loadBucket(identity);
    delete bucket.scopes[scopeId];
    bucket.scopes[scopeId] = new Date().toISOString();
    saveBucket(key, bucket);
    return true;
  };
  const recordBaseline = (identity = {}, items = []) => {
    const { key, bucket } = loadBucket(identity);
    let recorded = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const sourceMessageId = String(item?.id || item?.sourceMessageId || '').trim();
      if (!sourceMessageId || Object.hasOwn(bucket.items, sourceMessageId)) continue;
      bucket.items[sourceMessageId] = { state: 'baseline', recordedAt: new Date().toISOString() };
      recorded += 1;
    }
    if (recorded) saveBucket(key, bucket);
    return recorded;
  };
  const establishScopeBaseline = (identity = {}, items = []) => {
    if (scopeInitialized(identity)) return false;
    const { key, bucket } = loadBucket(identity);
    for (const item of Array.isArray(items) ? items : []) {
      const sourceMessageId = String(item?.id || item?.sourceMessageId || '').trim();
      if (sourceMessageId && !Object.hasOwn(bucket.items, sourceMessageId)) {
        bucket.items[sourceMessageId] = { state: 'baseline', recordedAt: new Date().toISOString() };
      }
    }
    const scopeId = String(identity.scopeId || '').trim();
    if (scopeId) bucket.scopes[scopeId] = new Date().toISOString();
    saveBucket(key, bucket);
    return true;
  };
  return {
    hasProcessed,
    markProcessed,
    scopeInitialized,
    markScopeInitialized,
    recordBaseline,
    establishScopeBaseline,
  };
}
