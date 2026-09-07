import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { codexTemplateDir } from './paths.js';
import { loadDevelopmentTrialProvider, loadEmbeddedTrialProvider } from './trialProvider.js';
import { ensureDirSync, readText, safeJsonParse, writeTextAtomicSync } from './utils.js';

const DEFAULT_REQUEST_MAX_RETRIES = 4;
const DEFAULT_STREAM_MAX_RETRIES = 5;
const PROVIDER_MODE_VERSION = 2;

export function configTemplate(baseUrl = '') {
  const providerUrl = baseUrl || process.env.JANUS_CODEX_BASE_URL || '';
  return `model_provider = "custom"
model = "gpt-5.6-sol"
review_model = "gpt-5.6-sol"
model_reasoning_effort = "medium"
disable_response_storage = true

[features]
multi_agent = true
memories = true

[memories]
generate_memories = false
use_memories = true
disable_on_external_context = true

[tools]
web_search = true

[sandbox_workspace_write]
network_access = true

[model_providers.custom]
name = "custom"
base_url = "${providerUrl.replaceAll('"', '\\"')}"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
request_max_retries = ${DEFAULT_REQUEST_MAX_RETRIES}
stream_max_retries = ${DEFAULT_STREAM_MAX_RETRIES}
`;
}

export function authTemplate() {
  return '{\n  "OPENAI_API_KEY": ""\n}\n';
}

export function writeCodexTemplates(root) {
  const dir = codexTemplateDir(root);
  ensureDirSync(dir);
  const configPath = path.join(dir, 'config.toml');
  const authPath = path.join(dir, 'auth.json');
  const configTemplatePath = path.join(dir, 'config.toml.template');
  const authTemplatePath = path.join(dir, 'auth.json.template');
  if (!fs.existsSync(configPath)) writeTextAtomicSync(configPath, '');
  if (!fs.existsSync(authPath)) writeTextAtomicSync(authPath, '');
  if (!fs.existsSync(configTemplatePath)) writeTextAtomicSync(configTemplatePath, configTemplate());
  if (!fs.existsSync(authTemplatePath)) writeTextAtomicSync(authTemplatePath, authTemplate());
  const currentConfig = readText(configPath, '');
  if (currentConfig.trim()) {
    const upgradedConfig = codexMemoryConfig(currentConfig);
    if (currentConfig !== upgradedConfig) writeTextAtomicSync(configPath, upgradedConfig);
  }
}

export function codexConfigStatus(root) {
  const credentials = codexCredentialState(root);
  const { config, providerName, provider, authEnvKey } = credentials;
  return {
    configPath: sharedConfigPath(root),
    authPath: sharedAuthPath(root),
    providerName,
    model: String(config.model || ''),
    reviewModel: String(config.review_model || ''),
    reasoningEffort: String(config.model_reasoning_effort || ''),
    baseUrl: credentials.baseUrl,
    authEnvKey,
    hasApiKey: Boolean(credentials.apiKey),
    credentialSource: credentials.source,
    configurationMode: credentials.configurationMode,
    providerKeyApplicationEnabled: providerKeyApplicationUiEnabled(),
    userProviderOverrideValidated: credentials.storedOverrideValidated,
    adminProviderOverrideEnabled: credentials.adminProviderOverrideEnabled,
    adminProviderOverrideUsable: credentials.adminProviderOverrideEnabled && credentials.storedComplete,
    storedBaseUrl: credentials.storedBaseUrl,
    storedHasApiKey: Boolean(credentials.storedApiKey),
    embeddedTrialProviderAvailable: credentials.embedded.available,
    embeddedTrialProviderError: credentials.embedded.error || '',
    developmentTrialProviderAvailable: credentials.development.available,
    developmentTrialProviderError: credentials.development.error || '',
    requestMaxRetries: Number(provider.request_max_retries ?? DEFAULT_REQUEST_MAX_RETRIES),
    streamMaxRetries: Number(provider.stream_max_retries ?? DEFAULT_STREAM_MAX_RETRIES),
    webSearch: Boolean(config.tools?.web_search),
    sandboxNetwork: Boolean(config.sandbox_workspace_write?.network_access),
    memories: Boolean(config.features?.memories),
    generateMemories: Boolean(config.memories?.generate_memories),
    useMemories: Boolean(config.memories?.use_memories),
    disableMemoriesOnExternalContext: Boolean(config.memories?.disable_on_external_context),
  };
}

export function codexConfigTextForRuntime(root) {
  writeCodexTemplates(root);
  const credentials = codexCredentialState(root);
  const storedSource = readText(sharedConfigPath(root), '');
  const source = credentials.source === 'stored' && storedSource.trim()
    ? storedSource
    : configTemplate();
  if (!credentials.baseUrl) return source;
  if (['embedded', 'development'].includes(credentials.source)) {
    return managedProviderConfigText(source, credentials.baseUrl);
  }
  return replaceActiveProviderBaseUrl(source, credentials.providerName, credentials.baseUrl);
}

export function codexConfigFiles(root) {
  writeCodexTemplates(root);
  return {
    configPath: sharedConfigPath(root),
    authPath: sharedAuthPath(root),
    configToml: readText(sharedConfigPath(root), ''),
    authJson: readText(sharedAuthPath(root), ''),
  };
}

export function saveCodexConfig(root, {
  baseUrl = '',
  apiKey = '',
  model = 'gpt-5.6-sol',
  reviewModel = 'gpt-5.6-sol',
  reasoningEffort = 'medium',
  adminProviderOverride = true,
} = {}) {
  writeCodexTemplates(root);
  const cleanBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  const cleanModel = String(model || 'gpt-5.6-sol').trim() || 'gpt-5.6-sol';
  const cleanReviewModel = String(reviewModel || cleanModel).trim() || cleanModel;
  const cleanReasoning = String(reasoningEffort || 'medium').trim() || 'medium';
  const existingAuth = safeJsonParse(readText(sharedAuthPath(root), '{}'), {});
  const cleanApiKey = String(apiKey || '').trim();
  const effectiveStoredApiKey = cleanApiKey || String(existingAuth.OPENAI_API_KEY || '').trim();
  if (adminProviderOverride && managedProviderAvailable() && (!cleanBaseUrl || !effectiveStoredApiKey)) {
    throw new Error('启用管理员自定义 Provider 时必须配置完整的 API 地址和 API Key。');
  }
  writeTextAtomicSync(sharedConfigPath(root), configText({
    baseUrl: cleanBaseUrl,
    model: cleanModel,
    reviewModel: cleanReviewModel,
    reasoningEffort: cleanReasoning,
  }));
  if (cleanApiKey) {
    writeTextAtomicSync(sharedAuthPath(root), `${JSON.stringify({ ...existingAuth, OPENAI_API_KEY: cleanApiKey }, null, 2)}\n`);
  }
  saveStoredProviderValidation(root, false);
  return codexConfigStatus(root);
}

export function saveCodexConfigFiles(root, {
  configToml = '',
  authJson = '',
} = {}) {
  writeCodexTemplates(root);
  const cleanConfigToml = String(configToml || '').trim() ? codexMemoryConfig(configToml) : '';
  const cleanAuthJson = normalizeEditableFileText(authJson);
  if (cleanConfigToml) validateConfigToml(cleanConfigToml);
  if (cleanAuthJson) validateAuthJson(cleanAuthJson);
  writeTextAtomicSync(sharedConfigPath(root), cleanConfigToml);
  writeTextAtomicSync(sharedAuthPath(root), cleanAuthJson);
  saveStoredProviderValidation(root, false);
  return {
    status: codexConfigStatus(root),
    files: codexConfigFiles(root),
  };
}

function configText({ baseUrl, model, reviewModel, reasoningEffort }) {
  return `model_provider = "custom"
model = ${tomlLiteral(model)}
review_model = ${tomlLiteral(reviewModel)}
model_reasoning_effort = ${tomlLiteral(reasoningEffort)}
disable_response_storage = true

[features]
multi_agent = true
memories = true

[memories]
generate_memories = false
use_memories = true
disable_on_external_context = true

[tools]
web_search = true

[sandbox_workspace_write]
network_access = true

[model_providers.custom]
name = "custom"
base_url = ${tomlLiteral(baseUrl)}
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
request_max_retries = ${DEFAULT_REQUEST_MAX_RETRIES}
stream_max_retries = ${DEFAULT_STREAM_MAX_RETRIES}
`;
}

export function sharedConfigPath(root) {
  return path.join(codexTemplateDir(root), 'config.toml');
}

export function sharedAuthPath(root) {
  return path.join(codexTemplateDir(root), 'auth.json');
}

export function sharedProviderModePath(root) {
  return path.join(codexTemplateDir(root), 'provider-mode.json');
}

export function codexMemoryConfig(text, {
  useMemories = true,
  generateMemories = false,
} = {}) {
  let output = normalizeConfigFileText(text || configTemplate());
  output = setTomlBoolean(output, 'features', 'memories', true);
  output = setTomlBoolean(output, 'memories', 'generate_memories', Boolean(generateMemories));
  output = setTomlBoolean(output, 'memories', 'use_memories', Boolean(useMemories));
  output = setTomlBoolean(output, 'memories', 'disable_on_external_context', true);
  output = ensureActiveProviderRetryDefaults(output);
  return normalizeConfigFileText(output);
}

export function codexPrivateSessionConfig(text) {
  let output = codexMemoryConfig(text, { useMemories: false, generateMemories: false });
  output = setTomlBoolean(output, 'features', 'multi_agent', false);
  output = setTomlBoolean(output, 'tools', 'web_search', false);
  output = setTomlBoolean(output, 'sandbox_workspace_write', 'network_access', false);
  return normalizeConfigFileText(output);
}

export function codexMultiAgentConfig(text, enabled = true) {
  return normalizeConfigFileText(setTomlBoolean(text, 'features', 'multi_agent', Boolean(enabled)));
}

function setTomlBoolean(text, section, key, value) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const header = `[${section}]`;
  const sectionStart = lines.findIndex((line) => line.trim() === header);
  const assignment = `${key} = ${value ? 'true' : 'false'}`;
  if (sectionStart === -1) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push('', header, assignment, '');
    return lines.join('\n');
  }
  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  const keyIndex = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && keyPattern.test(line));
  if (keyIndex !== -1) lines[keyIndex] = assignment;
  else lines.splice(sectionEnd, 0, assignment);
  return lines.join('\n');
}

function ensureActiveProviderRetryDefaults(text) {
  const output = normalizeConfigFileText(text);
  const providerName = String(parseSimpleToml(output).model_provider || '').trim();
  if (!providerName) return output;
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const sectionStart = lines.findIndex((line) => {
    const sectionMatch = line.trim().match(/^\[([^\]]+)\]$/);
    if (!sectionMatch) return false;
    const segments = splitTomlKeyPath(sectionMatch[1]);
    return segments.length === 2 && segments[0] === 'model_providers' && segments[1] === providerName;
  });
  if (sectionStart === -1) return output;
  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  for (const [key, value] of [
    ['request_max_retries', DEFAULT_REQUEST_MAX_RETRIES],
    ['stream_max_retries', DEFAULT_STREAM_MAX_RETRIES],
  ]) {
    const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
    const exists = lines.some((line, index) => index > sectionStart && index < sectionEnd && keyPattern.test(line));
    if (exists) continue;
    lines.splice(sectionEnd, 0, `${key} = ${value}`);
    sectionEnd += 1;
  }
  return normalizeConfigFileText(lines.join('\n'));
}

function parseTomlScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function parseSimpleToml(text) {
  const output = {};
  let section = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = splitTomlKeyPath(sectionMatch[1]);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const keyPath = splitTomlKeyPath(line.slice(0, eq));
    if (!keyPath.length) continue;
    const value = parseTomlScalar(line.slice(eq + 1));
    let cursor = output;
    for (const part of [...section, ...keyPath.slice(0, -1)]) {
      cursor[part] ||= {};
      cursor = cursor[part];
    }
    cursor[keyPath.at(-1)] = value;
  }
  return output;
}

function splitTomlKeyPath(raw = '') {
  const parts = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const character of String(raw || '').trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '.') {
      const part = decodeTomlKeySegment(current);
      if (part) parts.push(part);
      current = '';
      continue;
    }
    current += character;
  }
  const part = decodeTomlKeySegment(current);
  if (part) parts.push(part);
  return parts;
}

function decodeTomlKeySegment(raw = '') {
  const value = String(raw || '').trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function tomlLiteral(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(', ')}]`;
  throw new Error(`Unsupported config value type for Codex CLI override: ${typeof value}`);
}

function normalizeConfigFileText(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trimEnd();
  return `${text}\n`;
}

function validateAuthJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`auth.json 不是合法 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('auth.json 必须是一个 JSON object。');
  }
}

function validateConfigToml(text) {
  try {
    parseSimpleToml(text);
  } catch (error) {
    throw new Error(`config.toml 无法被当前配置解析器读取：${error.message}`);
  }
}

function tomlDottedKey(segments = []) {
  return segments
    .map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)))
    .join('.');
}

function flattenConfig(data, prefix = []) {
  const items = [];
  for (const [key, value] of Object.entries(data || {})) {
    const segments = [...prefix, key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      items.push(...flattenConfig(value, segments));
    } else {
      items.push([tomlDottedKey(segments), value]);
    }
  }
  return items;
}

export function sharedConfigArgs(root) {
  writeCodexTemplates(root);
  const data = parseSimpleToml(codexConfigTextForRuntime(root));
  const args = [];
  const executionConfig = Object.fromEntries(
    Object.entries(data).filter(([key]) => !['projects', 'tui'].includes(key)),
  );
  for (const [key, value] of flattenConfig(executionConfig)) {
    args.push('--config', `${key}=${tomlLiteral(value)}`);
  }
  return args;
}

export function loadAuthEnv(root) {
  const credentials = codexCredentialState(root);
  if (['embedded', 'development'].includes(credentials.source)) {
    return { [credentials.authEnvKey]: credentials.apiKey };
  }
  const data = credentials.auth;
  const env = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (typeof key === 'string' && typeof value === 'string' && value.trim()) {
      env[key] = value;
    }
  }
  return env;
}

export function codexStoredProviderCandidate(root) {
  writeCodexTemplates(root);
  return storedProviderCandidate({
    configToml: readText(sharedConfigPath(root), ''),
    authJson: readText(sharedAuthPath(root), ''),
  });
}

export function setCodexStoredProviderValidation(root, validated) {
  writeCodexTemplates(root);
  saveStoredProviderValidation(root, Boolean(validated));
  return codexConfigStatus(root);
}

function codexCredentialState(root) {
  writeCodexTemplates(root);
  const stored = codexStoredProviderCandidate(root);
  const embedded = loadEmbeddedTrialProvider();
  const development = loadDevelopmentTrialProvider();
  const fallback = development.available ? development : embedded;
  const validation = loadStoredProviderValidation(root);
  const storedOverrideValidated = Boolean(
    stored.complete
    && validation.validated
    && validation.configHash
    && validation.configHash === stored.configHash
  );
  const storedUsable = stored.complete && (storedOverrideValidated || !fallback.available);
  const effective = storedUsable
    ? { available: true, apiKey: stored.apiKey, baseUrl: stored.baseUrl, source: 'stored' }
    : fallback.available
      ? fallback
      : { available: false, apiKey: '', baseUrl: '', source: 'missing' };
  const managed = ['embedded', 'development'].includes(effective.source);
  const managedFallbackConfigured = development.available
    || embedded.available
    || embedded.distributionMode === 'open-source';
  const configurationMode = managedFallbackConfigured
    ? 'embedded-with-user-override'
    : 'user-configurable';
  const config = effective.source === 'stored' ? stored.config : parseSimpleToml(configTemplate());
  const providerName = effective.source === 'stored' ? stored.providerName : 'custom';
  const providers = config.model_providers && typeof config.model_providers === 'object' ? config.model_providers : {};
  const provider = providers[providerName] && typeof providers[providerName] === 'object' ? providers[providerName] : {};
  return {
    config,
    providerName,
    provider: managed ? {} : provider,
    auth: stored.auth,
    authEnvKey: managed ? 'OPENAI_API_KEY' : stored.authEnvKey,
    embedded,
    development,
    adminProviderOverrideEnabled: storedOverrideValidated,
    storedOverrideValidated,
    storedComplete: stored.complete,
    storedBaseUrl: stored.baseUrl,
    storedApiKey: stored.apiKey,
    configurationMode,
    source: effective.source,
    baseUrl: effective.baseUrl,
    apiKey: effective.apiKey,
  };
}

function storedProviderCandidate({ configToml = '', authJson = '' } = {}) {
  const rawConfig = String(configToml || '');
  const rawAuth = String(authJson || '');
  const config = parseSimpleToml(rawConfig);
  const providerName = String(config.model_provider || '').trim();
  const providers = config.model_providers && typeof config.model_providers === 'object' ? config.model_providers : {};
  const provider = providerName && providers[providerName] && typeof providers[providerName] === 'object'
    ? providers[providerName]
    : {};
  const auth = safeJsonParse(rawAuth, {});
  const authEnvKey = String(provider.env_key || 'OPENAI_API_KEY').trim() || 'OPENAI_API_KEY';
  const baseUrl = String(provider.base_url || '').trim().replace(/\/+$/, '');
  const apiKey = String(auth[authEnvKey] || '').trim();
  return {
    config,
    providerName,
    provider,
    auth,
    authEnvKey,
    baseUrl,
    apiKey,
    model: String(config.model || '').trim(),
    complete: Boolean(providerName && baseUrl && apiKey),
    blank: !rawConfig.trim() && !rawAuth.trim(),
    configHash: editableConfigHash(rawConfig, rawAuth),
  };
}

function managedProviderConfigText(text, baseUrl) {
  const sourceLines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  let removedManagedSection = false;
  let skippingManagedSection = false;
  let replacedProvider = false;
  for (const line of sourceLines) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[model_providers\.([^\]]+)\]$/);
    if (section) {
      const sectionName = section[1].trim().replace(/^["']|["']$/g, '');
      skippingManagedSection = sectionName === 'custom';
      if (skippingManagedSection) {
        removedManagedSection = true;
        continue;
      }
    } else if (/^\[[^\]]+\]$/.test(trimmed)) {
      skippingManagedSection = false;
    }
    if (skippingManagedSection) continue;
    if (/^\s*model_provider\s*=/.test(line)) {
      lines.push('model_provider = "custom"');
      replacedProvider = true;
    } else {
      lines.push(line);
    }
  }
  if (!replacedProvider) lines.unshift('model_provider = "custom"');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (removedManagedSection || lines.length) lines.push('');
  lines.push(
    '[model_providers.custom]',
    'name = "Janus managed"',
    `base_url = ${tomlLiteral(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'env_key = "OPENAI_API_KEY"',
    `request_max_retries = ${DEFAULT_REQUEST_MAX_RETRIES}`,
    `stream_max_retries = ${DEFAULT_STREAM_MAX_RETRIES}`,
    '',
  );
  return normalizeConfigFileText(lines.join('\n'));
}

function loadStoredProviderValidation(root) {
  const value = safeJsonParse(readText(sharedProviderModePath(root), '{}'), {});
  if (Number(value.schemaVersion || 0) !== PROVIDER_MODE_VERSION) {
    return { validated: false, configHash: '' };
  }
  return {
    validated: value.userOverrideValidated === true,
    configHash: String(value.configHash || ''),
  };
}

function saveStoredProviderValidation(root, enabled) {
  const candidate = enabled ? codexStoredProviderCandidate(root) : null;
  writeTextAtomicSync(sharedProviderModePath(root), `${JSON.stringify({
    schemaVersion: PROVIDER_MODE_VERSION,
    userOverrideValidated: Boolean(enabled && candidate?.complete),
    configHash: enabled && candidate?.complete ? candidate.configHash : '',
    validatedAt: enabled && candidate?.complete ? new Date().toISOString() : '',
  }, null, 2)}\n`);
}

function managedProviderAvailable() {
  return loadDevelopmentTrialProvider().available || loadEmbeddedTrialProvider().available;
}

function editableConfigHash(configToml = '', authJson = '') {
  return crypto.createHash('sha256')
    .update(String(configToml || ''))
    .update('\0')
    .update(String(authJson || ''))
    .digest('hex');
}

function normalizeEditableFileText(value = '') {
  const text = String(value || '').replace(/\r\n/g, '\n');
  return text.trim() ? normalizeConfigFileText(text) : '';
}

function providerKeyApplicationUiEnabled(env = process.env) {
  return String(env.JANUS_PROVIDER_KEY_APPLICATION_UI || '').trim() === '1';
}

function replaceActiveProviderBaseUrl(text, providerName, baseUrl) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let inProvider = false;
  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].trim().match(/^\[model_providers\.([^\]]+)\]$/);
    if (section) {
      const sectionName = section[1].trim().replace(/^["']|["']$/g, '');
      inProvider = sectionName === providerName;
      continue;
    }
    if (/^\[[^\]]+\]$/.test(lines[index].trim())) {
      inProvider = false;
      continue;
    }
    if (inProvider && /^\s*base_url\s*=/.test(lines[index])) {
      lines[index] = `base_url = ${tomlLiteral(baseUrl)}`;
      return lines.join('\n');
    }
  }
  return String(text || '');
}
