import path from 'node:path';

import { fetchCodexModelCatalog } from './codex.js';
import { dataDir } from './paths.js';
import { readText, safeJsonParse, writeTextAtomic } from './utils.js';

export const FALLBACK_MODEL_CATALOG = Object.freeze([
  model('gpt-5.6-sol', 'GPT-5.6-Sol', 1, 'low', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  model('gpt-5.6-terra', 'GPT-5.6-Terra', 2, 'medium', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  model('gpt-5.6-luna', 'GPT-5.6-Luna', 3, 'medium', ['low', 'medium', 'high', 'xhigh', 'max']),
  model('gpt-5.5', 'GPT-5.5', 7, 'medium', ['low', 'medium', 'high', 'xhigh']),
  model('gpt-5.4', 'GPT-5.4', 16, 'medium', ['low', 'medium', 'high', 'xhigh']),
  model('gpt-5.4-mini', 'GPT-5.4-Mini', 23, 'medium', ['low', 'medium', 'high', 'xhigh']),
]);
const LEGACY_MODEL_IDS = new Set(['gpt-5.2']);

function model(id, label, priority, defaultReasoningEffort, supportedReasoningEfforts, contextWindowTokens = 128_000) {
  return Object.freeze({ id, label, priority, defaultReasoningEffort, contextWindowTokens, supportedReasoningEfforts: Object.freeze(supportedReasoningEfforts) });
}

function cachePath(root) {
  return path.join(dataDir(root), 'model-catalog.json');
}

export function normalizeModelCatalog(payload = {}) {
  const rawModels = Array.isArray(payload) ? payload : Array.isArray(payload.models) ? payload.models : [];
  const seen = new Set();
  return rawModels
    .filter((item) => item && (item.visibility === undefined || item.visibility === 'list') && item.supported_in_api !== false && item.supportedInApi !== false)
    .map((item, index) => {
      const id = String(item.slug || item.id || '').trim();
      const label = String(item.display_name || item.label || id).trim();
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const supportedReasoningEfforts = (item.supported_reasoning_levels || item.supportedReasoningEfforts || [])
        .map((level) => String(level?.effort || level || '').trim())
        .filter(Boolean);
      const defaultReasoningEffort = String(item.default_reasoning_level || item.defaultReasoningEffort || supportedReasoningEfforts[0] || 'medium').trim();
      const contextWindowTokens = Math.max(1, Number(item.context_window_tokens || item.contextWindowTokens || item.context_window || item.max_input_tokens || 128_000));
      return {
        id,
        label,
        priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index + 1000,
        defaultReasoningEffort,
        contextWindowTokens,
        supportedReasoningEfforts: supportedReasoningEfforts.length ? [...new Set(supportedReasoningEfforts)] : ['low', 'medium', 'high', 'xhigh'],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
}

export class ModelCatalog {
  constructor({ root, fetchCatalog = fetchCodexModelCatalog, getDefaultSelection = null } = {}) {
    this.root = root;
    this.fetchCatalog = fetchCatalog;
    this.getDefaultSelection = typeof getDefaultSelection === 'function' ? getDefaultSelection : null;
    this.refreshing = null;
    this.catalog = this.loadCachedCatalog();
  }

  loadCachedCatalog() {
    const cached = safeJsonParse(readText(cachePath(this.root), ''), null);
    const models = normalizeModelCatalog(cached?.models || []).filter((item) => !LEGACY_MODEL_IDS.has(item.id));
    if (!models.length) {
      return { models: [...FALLBACK_MODEL_CATALOG], updatedAt: '', source: 'bundled', error: '' };
    }
    return {
      models,
      updatedAt: String(cached.updatedAt || ''),
      source: 'cache',
      error: '',
    };
  }

  status() {
    return {
      models: this.catalog.models.map((item) => ({ ...item, supportedReasoningEfforts: [...item.supportedReasoningEfforts] })),
      updatedAt: this.catalog.updatedAt,
      source: this.catalog.source,
      error: this.catalog.error,
    };
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async refreshNow() {
    try {
      const payload = await this.fetchCatalog(this.root);
      const models = normalizeModelCatalog(payload);
      if (!models.length) throw new Error('Codex returned an empty visible model catalog.');
      const updatedAt = new Date().toISOString();
      this.catalog = { models, updatedAt, source: 'codex', error: '' };
      await writeTextAtomic(cachePath(this.root), `${JSON.stringify({ models, updatedAt }, null, 2)}\n`);
    } catch (error) {
      this.catalog = { ...this.catalog, error: String(error.message || error) };
    }
    return this.status();
  }

  resolveSelection({ model: requestedModel = '', reasoningEffort: requestedReasoning = '' } = {}) {
    const models = this.catalog.models.length ? this.catalog.models : FALLBACK_MODEL_CATALOG;
    const requested = String(requestedModel || '').trim();
    if (!requested) {
      const configured = this.getDefaultSelection?.() || {};
      const configuredModel = String(configured.model || '').trim();
      const selected = models.find((item) => item.id === configuredModel) || (configuredModel ? models[0] : null);
      if (!selected) return { model: '', reasoningEffort: String(requestedReasoning || configured.reasoningEffort || '').trim() };
      const reasoning = String(requestedReasoning || configured.reasoningEffort || '').trim();
      return {
        model: selected.id,
        reasoningEffort: selected.supportedReasoningEfforts.includes(reasoning) ? reasoning : selected.defaultReasoningEffort,
      };
    }
    const selected = models.find((item) => item.id === requested);
    if (!selected) {
      const knownModel = LEGACY_MODEL_IDS.has(requested) || FALLBACK_MODEL_CATALOG.some((item) => item.id === requested);
      if (!knownModel || !models[0]) throw new Error(`Unsupported Codex model: ${requested}`);
      const configured = this.getDefaultSelection?.() || {};
      const fallback = models.find((item) => item.id === String(configured.model || '').trim()) || models[0];
      const reasoning = String(requestedReasoning || configured.reasoningEffort || '').trim();
      return {
        model: fallback.id,
        reasoningEffort: fallback.supportedReasoningEfforts.includes(reasoning) ? reasoning : fallback.defaultReasoningEffort,
      };
    }
    const reasoning = String(requestedReasoning || '').trim();
    const resolvedReasoning = selected.supportedReasoningEfforts.includes(reasoning)
      ? reasoning
      : selected.defaultReasoningEffort;
    return { model: selected.id, reasoningEffort: resolvedReasoning };
  }
}
