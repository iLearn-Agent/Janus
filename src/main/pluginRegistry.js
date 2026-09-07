import fs from 'node:fs';

import {
  downloadPptSkill,
  pptSkillInstallRoot,
  pptSkillStatus,
  uninstallPptSkill,
} from './skills.js';

const PLUGIN_DEFINITIONS = [
  {
    id: 'ppt_creation',
    name: 'PPT 制作技能',
    icon: 'presentation',
    category: 'content',
    categoryLabel: '内容创作',
    description: '生成通用、学术汇报和重大项目等可编辑 PPT。',
    longDescription: '为统一的 PPT Designer 安装三种正式风格、可编辑 PPTX 渲染能力、模板支持和预览导出流程。',
    tags: ['PPTX', '演示设计', '3 种风格'],
    capabilities: ['通用 PPT', '学术汇报', '重大项目汇报', '可编辑 PPTX', '模板与预览'],
    providesAgentIds: ['ppt'],
    permissions: ['读取用户明确提供的演示素材', '在当前工作区生成 PPTX 与预览文件'],
    chatTarget: 'pptx',
    recommendedOrder: 10,
    status: pptSkillStatus,
    install: downloadPptSkill,
    uninstall: uninstallPptSkill,
    installRoot: pptSkillInstallRoot,
  },
];

const PLUGIN_BY_ID = new Map(PLUGIN_DEFINITIONS.map((plugin) => [plugin.id, plugin]));

function requirePlugin(pluginId) {
  const id = String(pluginId || '').trim();
  const plugin = PLUGIN_BY_ID.get(id);
  if (!plugin) throw new Error(`Unknown plugin: ${id || '(empty)'}`);
  return plugin;
}

function publicPlugin(plugin, status) {
  return {
    id: plugin.id,
    name: plugin.name,
    icon: plugin.icon,
    category: plugin.category,
    categoryLabel: plugin.categoryLabel,
    description: plugin.description,
    longDescription: plugin.longDescription,
    tags: [...plugin.tags],
    capabilities: [...plugin.capabilities],
    providesAgentIds: [...plugin.providesAgentIds],
    permissions: [...plugin.permissions],
    chatTarget: plugin.chatTarget || '',
    recommendedOrder: plugin.recommendedOrder,
    status,
  };
}

export function pluginCatalog(root, options = {}) {
  return PLUGIN_DEFINITIONS.map((plugin) => publicPlugin(plugin, plugin.status(root, options)));
}

export function pluginStatus(root, pluginId, options = {}) {
  const plugin = requirePlugin(pluginId);
  return publicPlugin(plugin, plugin.status(root, options));
}

export async function installPlugin(root, pluginId, options = {}) {
  const plugin = requirePlugin(pluginId);
  const status = await plugin.install(root, options);
  return publicPlugin(plugin, status);
}

export async function uninstallPlugin(root, pluginId, options = {}) {
  const plugin = requirePlugin(pluginId);
  const status = await plugin.uninstall(root, options);
  return publicPlugin(plugin, status);
}

export function pluginInstallPath(root, pluginId) {
  const plugin = requirePlugin(pluginId);
  const installPath = plugin.installRoot(root);
  if (!fs.existsSync(installPath)) throw new Error(`${plugin.name}的本地安装目录不存在，请重新安装。`);
  return installPath;
}
