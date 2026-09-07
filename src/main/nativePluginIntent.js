const INSTALL_ACTIONS = new Set(['安装', '装上', '添加', 'install', 'add']);
const REMOVE_ACTIONS = new Set(['卸载', '移除', 'uninstall', 'remove']);
const OFFICIAL_MARKETPLACE_NAMES = new Set(['openai-curated', 'openai-api-curated']);

export function parseNativePluginControlIntent(value = '') {
  const text = String(value || '').trim();
  if (!text || text.includes('\n')) return null;
  const patterns = [
    /^(?:请|麻烦|帮我|给我|为我|请帮我|能否|可以)?\s*(安装|装上|添加|卸载|移除)\s*(.+?)\s*插件\s*[。.!！?？]*$/i,
    /^(?:请|麻烦|帮我|给我|为我|请帮我|能否|可以)?\s*插件\s*[:：]?\s*(.+?)\s*(安装|装上|添加|卸载|移除)\s*[。.!！?？]*$/i,
    /^(?:please\s+)?(install|add|uninstall|remove)\s+(?:the\s+)?(.+?)\s+plugin\s*[.!?]*$/i,
    /^(?:please\s+)?(?:plugin\s+)(.+?)\s+(install|add|uninstall|remove)\s*[.!?]*$/i,
    /^(?:请|麻烦|帮我|给我|为我|请帮我|能否|可以)?\s*(安装|卸载|移除|install|uninstall|remove)\s+([A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*)\s*[。.!！?？]*$/i,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = text.match(pattern);
    if (!match) continue;
    const actionValue = String(index === 1 || index === 3 ? match[2] : match[1]).toLowerCase();
    const queryValue = index === 1 || index === 3 ? match[1] : match[2];
    const action = INSTALL_ACTIONS.has(actionValue) ? 'install' : REMOVE_ACTIONS.has(actionValue) ? 'remove' : '';
    const query = cleanPluginQuery(queryValue);
    if (action && query) return { action, query, source: 'explicit_plugin_command' };
  }
  return null;
}

export function resolveNativePluginControlTarget(intent = null, catalog = {}) {
  if (!intent?.action || !intent?.query) return { status: 'not_plugin_request', matches: [] };
  if (catalog.capability?.supported === false) {
    return { status: 'unsupported', matches: [], capability: catalog.capability };
  }
  const installed = Array.isArray(catalog.installed) ? catalog.installed : [];
  const available = Array.isArray(catalog.available) ? catalog.available : [];
  const plugins = dedupePlugins([...installed, ...available]);
  const query = canonicalPluginName(intent.query);
  let matches = plugins.filter((plugin) => pluginSearchKeys(plugin).some((key) => key === query));
  if (!matches.length && intent.query.includes('@')) {
    matches = plugins.filter((plugin) => String(plugin.pluginId || '').toLowerCase() === intent.query.toLowerCase());
  }
  if (intent.action === 'remove') {
    const installedIds = new Set(installed.map((plugin) => String(plugin.pluginId || '')));
    matches = matches.filter((plugin) => installedIds.has(String(plugin.pluginId || '')));
  }
  if (!matches.length) return { status: 'not_found', matches: [] };
  const selected = selectUniquePlugin(matches);
  if (!selected) return { status: 'ambiguous', matches: matches.map(publicPluginMatch) };
  const installedPlugin = installed.find((plugin) => plugin.pluginId === selected.pluginId) || null;
  if (intent.action === 'install' && installedPlugin
    && installedPlugin.installed !== false && installedPlugin.enabled !== false) {
    return { status: 'already_installed', plugin: publicPluginMatch(installedPlugin), matches: [publicPluginMatch(installedPlugin)] };
  }
  return { status: 'matched', plugin: publicPluginMatch(selected), matches: [publicPluginMatch(selected)] };
}

function cleanPluginQuery(value = '') {
  return String(value || '')
    .trim()
    .replace(/^(?:一下|一个|the)\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function canonicalPluginName(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function pluginSearchKeys(plugin = {}) {
  return [...new Set([
    plugin.pluginId,
    plugin.name,
    plugin.displayName,
    String(plugin.pluginId || '').split('@')[0],
  ].map(canonicalPluginName).filter(Boolean))];
}

function dedupePlugins(plugins = []) {
  const byId = new Map();
  for (const plugin of plugins) {
    const id = String(plugin?.pluginId || '').trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, plugin);
  }
  return [...byId.values()];
}

function selectUniquePlugin(matches = []) {
  if (matches.length === 1) return matches[0];
  const official = matches.filter((plugin) => OFFICIAL_MARKETPLACE_NAMES.has(String(plugin.marketplaceName || '')));
  return official.length === 1 ? official[0] : null;
}

function publicPluginMatch(plugin = {}) {
  return {
    pluginId: String(plugin.pluginId || ''),
    name: String(plugin.name || ''),
    displayName: String(plugin.displayName || plugin.name || plugin.pluginId || ''),
    marketplaceName: String(plugin.marketplaceName || ''),
    version: String(plugin.version || ''),
    installed: plugin.installed === true,
    enabled: plugin.enabled === true,
  };
}
