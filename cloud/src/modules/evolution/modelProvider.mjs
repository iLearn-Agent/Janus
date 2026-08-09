import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;

export function evolutionModelProviderStatus({ env = process.env, fsImpl = fs } = {}) {
  const resolved = resolveEvolutionModelProvider({ env, fsImpl });
  return {
    available: resolved.available,
    source: resolved.source,
    code: resolved.code,
    model: resolved.model || '',
    reviewModel: resolved.reviewModel || resolved.model || '',
  };
}

export function evolutionModelDelegatedToWorker(env = process.env) {
  return String(env.JANUS_EVOLUTION_MODEL_DELEGATED_TO_WORKER || '').trim().toLowerCase() === 'true';
}

export function createEvolutionModelExecutor({ env = process.env, fetchImpl = globalThis.fetch, fsImpl = fs } = {}) {
  const executor = async ({ prompt = '', modelRole = '' } = {}) => {
    const provider = resolveEvolutionModelProvider({ env, fsImpl });
    if (!provider.available) {
      throw codedError(provider.code || 'evolution_worker_unavailable', provider.message || 'Platform evolution model is not configured.');
    }
    if (typeof fetchImpl !== 'function') throw codedError('evolution_model_transport_unavailable', 'Evolution model transport is unavailable.');
    const model = /review|judge|evaluator|hr/.test(String(modelRole || ''))
      ? provider.reviewModel || provider.model
      : provider.model;
    const timeoutMs = positiveInteger(env.JANUS_EVOLUTION_MODEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxAttempts = Math.min(5, positiveInteger(env.JANUS_EVOLUTION_MODEL_MAX_ATTEMPTS, 3));
    const body = { model, input: String(prompt || ''), store: false };
    if (provider.reasoningEffort) body.reasoning = { effort: provider.reasoningEffort };
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(provider.responsesUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = redactProviderText(payload?.error?.message || `Evolution model HTTP ${response.status}`, [provider.apiKey]);
          const failure = codedError('evolution_model_failed', detail);
          failure.retryable = response.status === 429 || response.status >= 500;
          throw failure;
        }
        const text = payload.output_text
          || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || item.output_text || '').join('\n')
          || '';
        if (!String(text).trim()) throw codedError('evolution_model_empty', 'Evolution model returned no text.');
        return String(text);
      } catch (error) {
        lastError = error?.name === 'AbortError'
          ? Object.assign(codedError('evolution_model_timeout', `Evolution model timed out after ${timeoutMs} ms.`), { retryable: true })
          : error?.code ? error
            : Object.assign(codedError('evolution_model_failed', redactProviderText(error?.message || error, [provider.apiKey])), { retryable: true });
        if (!lastError.retryable || attempt >= maxAttempts) throw lastError;
        await delay(Math.min(4000, 400 * (2 ** (attempt - 1))));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || codedError('evolution_model_failed', 'Evolution model request failed.');
  };
  Object.defineProperty(executor, 'available', {
    enumerable: false,
    get: () => evolutionModelProviderStatus({ env, fsImpl }).available,
  });
  Object.defineProperty(executor, 'providerStatus', {
    enumerable: false,
    value: () => evolutionModelProviderStatus({ env, fsImpl }),
  });
  return executor;
}

function resolveEvolutionModelProvider({ env, fsImpl }) {
  const explicit = {
    baseUrl: String(env.JANUS_EVOLUTION_PROVIDER_BASE_URL || '').trim(),
    apiKey: String(env.JANUS_EVOLUTION_PROVIDER_API_KEY || '').trim(),
    model: String(env.JANUS_EVOLUTION_MODEL || '').trim(),
    reviewModel: String(env.JANUS_EVOLUTION_REVIEW_MODEL || '').trim(),
    reasoningEffort: String(env.JANUS_EVOLUTION_REASONING_EFFORT || '').trim(),
  };
  if (explicit.baseUrl || explicit.apiKey || explicit.model || explicit.reviewModel) {
    if (!explicit.baseUrl || !explicit.apiKey || !explicit.model) return unavailable('environment', 'evolution_model_environment_incomplete');
    return readyProvider({ ...explicit, source: 'environment' });
  }

  const codexHome = String(env.JANUS_EVOLUTION_CODEX_HOME || '').trim();
  if (!codexHome) return unavailable('none', 'evolution_model_unavailable');
  try {
    const configPath = path.join(codexHome, 'config.toml');
    const authPath = path.join(codexHome, 'auth.json');
    assertRegularFile(fsImpl, configPath, { credential: false });
    assertRegularFile(fsImpl, authPath, { credential: true });
    const config = parseCodexConfig(fsImpl.readFileSync(configPath, 'utf8'));
    const providerName = String(config.model_provider || '').trim();
    const provider = config.model_providers?.[providerName];
    if (!providerName || !provider || typeof provider !== 'object') return unavailable('codex_home', 'evolution_codex_provider_missing');
    const auth = JSON.parse(fsImpl.readFileSync(authPath, 'utf8'));
    const envKey = String(provider.env_key || 'OPENAI_API_KEY').trim() || 'OPENAI_API_KEY';
    const input = {
      baseUrl: String(provider.base_url || '').trim(),
      apiKey: String(auth?.[envKey] || '').trim(),
      model: String(config.model || '').trim(),
      reviewModel: String(config.review_model || config.model || '').trim(),
      reasoningEffort: String(env.JANUS_EVOLUTION_REASONING_EFFORT || config.model_reasoning_effort || '').trim(),
      source: 'codex_home',
    };
    if (!input.baseUrl || !input.apiKey || !input.model) return unavailable('codex_home', 'evolution_codex_config_incomplete');
    return readyProvider(input);
  } catch (error) {
    const code = error?.code === 'evolution_codex_auth_permissions_insecure'
      ? error.code
      : 'evolution_codex_config_invalid';
    return unavailable('codex_home', code);
  }
}

function readyProvider(input) {
  let responsesUrl;
  try {
    responsesUrl = responsesEndpoint(input.baseUrl);
  } catch {
    return unavailable(input.source, 'evolution_provider_url_invalid');
  }
  return { available: true, code: 'ok', ...input, responsesUrl };
}

function unavailable(source, code) {
  return { available: false, source, code, message: 'Platform evolution model is not configured.' };
}

function responsesEndpoint(baseUrl) {
  const url = new URL(String(baseUrl || '').trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  if (/\/v1\/responses$/i.test(pathname)) url.pathname = pathname;
  else if (/\/v1$/i.test(pathname)) url.pathname = `${pathname}/responses`;
  else url.pathname = `${pathname}/v1/responses`.replace(/\/+/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

function assertRegularFile(fsImpl, filename, { credential }) {
  const stat = fsImpl.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw codedError('evolution_codex_config_invalid', 'Codex configuration must use regular files.');
  if (credential && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw codedError('evolution_codex_auth_permissions_insecure', 'Codex auth.json must not be readable by group or other users.');
  }
}

function parseCodexConfig(text) {
  const output = {};
  let section = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].split('.').map((item) => item.trim()).filter(Boolean);
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = parseTomlScalar(line.slice(separator + 1));
    let cursor = output;
    for (const item of section) {
      cursor[item] ||= {};
      cursor = cursor[item];
    }
    cursor[key] = value;
  }
  return output;
}

function parseTomlScalar(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function redactProviderText(value, secrets = []) {
  let text = String(value || 'Evolution model request failed.');
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]').slice(0, 2000);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
