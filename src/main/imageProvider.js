import { codexConfigStatus, loadAuthEnv } from './codexConfig.js';
import { sha256Text } from './utils.js';
import { normalizeOpenAiApiBase } from '../../network/clients/openaiImagesClient.js';

export const MANAGED_IMAGE_PROVIDER_SCOPE_ID = 'janus_image_generation_quota_v1';

export function customImageProviderScopeId(providerName = '', baseUrl = '') {
  return `custom_image_provider:${sha256Text(`${providerName}\n${baseUrl}`).slice(0, 24)}`;
}

export function imageGenerationProviderState(root = '') {
  const authEnv = loadAuthEnv(root);
  const config = codexConfigStatus(root);
  const explicitImageApiKey = String(authEnv.OPENAI_IMAGE_API_KEY || process.env.OPENAI_IMAGE_API_KEY || '').trim();
  const explicitImageBaseUrl = String(authEnv.OPENAI_IMAGE_BASE_URL || process.env.OPENAI_IMAGE_BASE_URL || '').trim();
  const apiKey = explicitImageApiKey
    || String(authEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const configuredBaseUrl = explicitImageBaseUrl
    || String(authEnv.OPENAI_BASE_URL || authEnv.OPENAI_API_BASE
      || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || config.baseUrl || '').trim();
  const baseUrl = normalizeOpenAiApiBase(configuredBaseUrl || 'https://api.openai.com/v1');
  const managedProvider = ['embedded', 'development'].includes(String(config.credentialSource || ''))
    && !explicitImageApiKey
    && !explicitImageBaseUrl;
  return {
    managedProvider,
    limited: managedProvider,
    providerScopeId: managedProvider
      ? MANAGED_IMAGE_PROVIDER_SCOPE_ID
      : customImageProviderScopeId(config.providerName || '', baseUrl),
    credentialSource: explicitImageApiKey || explicitImageBaseUrl ? 'image_override' : config.credentialSource,
    apiKey,
    baseUrl,
  };
}
