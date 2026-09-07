export const MAX_UPLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const RUN_STATUS_REFRESH_MS = 1000;
export const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
export const DOCUMENT_ATTACHMENT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'js', 'mjs', 'ts', 'tsx', 'jsx',
  'py', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'html', 'css', 'xml', 'toml', 'yaml', 'yml',
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
  'zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz',
  'exe', 'msi', 'dmg', 'pkg', 'apk', 'appimage', 'deb', 'rpm', 'iso',
]);
export const ALL_ATTACHMENT_EXTENSIONS = new Set([...DOCUMENT_ATTACHMENT_EXTENSIONS, ...IMAGE_ATTACHMENT_EXTENSIONS]);
export const TOKEN_MASK = '************';

export const TEXT_MODEL_OPTIONS = [
  ['gpt-5.6-sol', 'GPT-5.6-Sol'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna'],
  ['gpt-5.5', 'GPT-5.5'],
  ['gpt-5.4', 'GPT-5.4'],
  ['gpt-5.4-mini', 'GPT-5.4-Mini'],
];

export const IMAGE_MODEL_OPTIONS = [
  ['gpt-image-2', 'GPT Image-2'],
];

export const REASONING_OPTIONS = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['xhigh', '超高'],
  ['max', '最大'],
  ['ultra', '极致'],
];

export function textModelOptions(catalog = null) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const options = models
    .map((item) => [String(item?.id || '').trim(), String(item?.label || item?.id || '').trim()])
    .filter(([id, label]) => id && label);
  return options.length ? options : TEXT_MODEL_OPTIONS;
}

export function modelCatalogEntry(catalog, modelId) {
  return (Array.isArray(catalog?.models) ? catalog.models : []).find((item) => item?.id === modelId) || null;
}

export function reasoningOptionsForModel(catalog, modelId) {
  const supported = modelCatalogEntry(catalog, modelId)?.supportedReasoningEfforts;
  if (!Array.isArray(supported) || !supported.length) return REASONING_OPTIONS;
  return supported.map((value) => REASONING_OPTIONS.find(([knownValue]) => knownValue === value) || [value, value]);
}

export const USER_FACING_AGENT_IDS = {
  general: ['general_agent'],
  secretary_department: ['secretary_agent'],
  ppt_department: ['ppt'],
};

export const AGENT_DISPLAY_LABELS = {
  general_agent: 'Generalist',
  secretary_agent: 'uBuddy',
  ppt_academic_report: '学术汇报风',
  ppt_major_project: '重大项目风',
  ppt: 'PPT Designer',
};

export const PPT_TEMPLATE_OPTIONS = [
  ['none', '无', 'templates/通用多功能PPT模板.pptx', ''],
  ['hitsz', '哈工深模板', 'templates/哈工深多功能PPT模板.pptx', '../../assets/departments/ppt_department/templates/hitsz_cover.png'],
  ['scut', '华工模板', 'templates/华工多功能PPT模板.pptx', '../../assets/departments/ppt_department/templates/scut_cover.png'],
];

export const HOME_DEPARTMENT_CHIPS = [
  ['ppt_department', 'presentation', '制作PPT', '请基于我的主题制作一套学术汇报 PPT 的结构和内容。'],
];
