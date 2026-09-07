const IMAGE_TARGET = '(?:图片|图像|插画|照片|海报|头像|壁纸|封面|图标|四格漫画|漫画|连环画|logo|icon|image|picture|photo|illustration|poster|avatar|wallpaper|cover|comics?|manga|graphic\\s+novel)';
const CREATE_ACTION = '(?:生成|画|绘制|创作|创建|制作|做一?[张幅个]?|设计|渲染|generate|create|draw|paint|render|make)';
const EDIT_ACTION = '(?:修改|编辑|重绘|调整|替换|换成|变成|加上|添加|去掉|移除|改变|edit|modify|redraw|replace|remove|add|change)';

const CREATE_PATTERNS = [
  new RegExp(`${CREATE_ACTION}.{0,18}${IMAGE_TARGET}`, 'i'),
  new RegExp(`${IMAGE_TARGET}.{0,18}${CREATE_ACTION}`, 'i'),
];
const EDIT_PATTERNS = [
  new RegExp(`${EDIT_ACTION}.{0,18}(?:这张|上一张|上张|刚才的|现有的|上传的)?${IMAGE_TARGET}`, 'i'),
  new RegExp(`(?:这张|上一张|上张|刚才的|现有的|上传的)${IMAGE_TARGET}.{0,18}${EDIT_ACTION}`, 'i'),
];
const META_PATTERNS = [
  new RegExp(`(?:如何|怎么|怎样|能否教我|请教).{0,20}${CREATE_ACTION}.{0,18}${IMAGE_TARGET}`, 'i'),
  /(?:如何|怎么|怎样|为什么|原理|教程|文档|说明|解释|介绍|比较|区别).{0,24}(?:生成图片|图片生成|生图|image generation)/i,
  /(?:生成图片|图片生成|生图|image generation).{0,24}(?:如何|怎么|怎样|原理|教程|文档|说明|解释|介绍|API|SDK|代码|脚本|程序)/i,
  /(?:写|生成|制作|优化|给我).{0,12}(?:生图|图片生成).{0,8}(?:提示词|prompt)|(?:生图|图片生成|生成图片)(?:的|所需的).{0,8}(?:提示词|prompt)/i,
  /(?:API|SDK|代码|脚本|程序|函数|接口|调用|实现|示例).{0,24}(?:生成图片|图片生成|生图|image generation)/i,
  new RegExp(`(?:API|SDK|代码|脚本|程序|函数|接口|调用|实现|示例).{0,30}${CREATE_ACTION}.{0,18}${IMAGE_TARGET}|${CREATE_ACTION}.{0,18}${IMAGE_TARGET}.{0,30}(?:API|SDK|代码|脚本|程序|函数|接口|调用|实现|示例)|${IMAGE_TARGET}.{0,18}${CREATE_ACTION}.{0,18}(?:API|SDK|代码|脚本|程序|函数|接口|调用|实现|示例)`, 'i'),
  new RegExp(`${EDIT_ACTION}.{0,18}${IMAGE_TARGET}.{0,18}(?:API|SDK|代码|脚本|程序|教程|方法|原理)`, 'i'),
  /(?:分析|识别|描述|总结|提取|查看|阅读).{0,18}(?:图片|图像|照片|image|picture|photo)/i,
  /(?:搜索|检索|寻找|找一?下|下载).{0,18}(?:图片|图像|照片|image|picture|photo)/i,
  new RegExp(`(?:翻译|改写|润色|复述).{0,30}${CREATE_ACTION}.{0,18}${IMAGE_TARGET}|${CREATE_ACTION}.{0,18}${IMAGE_TARGET}.{0,30}(?:翻译|改写|润色|复述)`, 'i'),
  new RegExp(`(?:不要|无需|不用|别).{0,8}(?:生成|画|绘制|创建|制作).{0,12}${IMAGE_TARGET}`, 'i'),
];

export function classifyImageIntent(message = '', { attachments = [] } = {}) {
  const text = normalizeImageIntentText(message);
  if (!text) return imageIntentResult();
  if (META_PATTERNS.some((pattern) => pattern.test(text))) {
    return imageIntentResult('none', false, 'image_request_is_informational');
  }
  if (EDIT_PATTERNS.some((pattern) => pattern.test(text)) || (hasImageAttachment(attachments) && editActionWithoutTarget(text))) {
    return imageIntentResult('edit', true, 'explicit_image_edit_request');
  }
  if (CREATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return imageIntentResult('creation', true, 'explicit_image_creation_request');
  }
  return imageIntentResult();
}

function normalizeImageIntentText(value = '') {
  return String(value || '')
    .replace(/__JANUS_ATTACHMENT_RESOURCES__[\s\S]*$/i, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasImageAttachment(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).some((item) => {
    const kind = String(item?.kind || '').toLowerCase();
    const type = String(item?.type || item?.contentType || item?.content_type || '').toLowerCase();
    const name = String(item?.name || item?.filename || item?.path || '').toLowerCase();
    return kind === 'image' || type.startsWith('image/') || /\.(?:png|jpe?g|webp)$/i.test(name);
  });
}

function editActionWithoutTarget(text = '') {
  return new RegExp(EDIT_ACTION, 'i').test(text);
}

function imageIntentResult(intent = 'none', explicit = false, reason = '') {
  return { intent, explicit: Boolean(explicit), reason: String(reason || '') };
}
