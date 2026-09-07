import { FOLLOWER_I18N_KEYS } from './keys.js';
import { FOLLOWER_ZH_CN } from './zh-CN.js';
import { FOLLOWER_EN } from './en.js';

export function followerText(key, language = 'zh-CN', params = {}) {
  const bundle = language === 'en' ? FOLLOWER_EN : FOLLOWER_ZH_CN;
  const fallback = FOLLOWER_ZH_CN[key] || key;
  return String(bundle[key] || fallback).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => String(params[name] ?? `{${name}}`));
}

export function followerI18nContract() {
  return { keys: FOLLOWER_I18N_KEYS, bundles: { 'zh-CN': FOLLOWER_ZH_CN, en: FOLLOWER_EN } };
}
