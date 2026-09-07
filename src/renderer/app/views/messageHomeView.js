import { iconSvg } from '../ui/icons.js';

const MESSAGE_DEFAULT_VARIANT_COUNT = 3;
const MESSAGE_DEFAULT_VARIANTS = Object.freeze([
  Object.freeze({ id: 0, label: '小红花', render: renderFlowerVariant, thumbnail: 'flower' }),
  Object.freeze({ id: 1, label: 'uBuddy', render: renderQuietTaskVariant, thumbnail: 'orbit' }),
  Object.freeze({ id: 2, label: '协作', render: renderCollaborationVariant, thumbnail: 'collaboration' }),
]);

export function renderMessageDefaultPage(variantIndex = 0, {
  variantOrder = [],
  orderEditorOpen = false,
  animateVariant = true,
} = {}) {
  const order = normalizeMessageDefaultVariantOrder(variantOrder);
  const requestedIndex = Number(variantIndex || 0);
  const requestedVariant = Number.isFinite(requestedIndex) ? Math.abs(Math.trunc(requestedIndex)) % MESSAGE_DEFAULT_VARIANT_COUNT : order[0];
  const activeIndex = order.includes(requestedVariant) ? requestedVariant : order[0];
  const activeVariant = MESSAGE_DEFAULT_VARIANTS.find((item) => item.id === activeIndex) || MESSAGE_DEFAULT_VARIANTS[0];
  return `<div class="view message-default-page" data-message-default-page role="region" aria-label="消息默认页">
    <button class="message-default-order-toggle" type="button" data-message-default-order-toggle aria-label="调整默认页顺序" aria-expanded="${orderEditorOpen ? 'true' : 'false'}">${iconSvg('sliders')}</button>
    ${orderEditorOpen ? renderMessageDefaultOrderEditor(order) : ''}
    <div class="message-default-nav-zone is-left"><button type="button" data-message-default-step="previous" aria-label="上一页，首尾循环">${iconSvg('chevronLeft')}</button></div>
    <div class="message-default-nav-zone is-right"><button type="button" data-message-default-step="next" aria-label="下一页，首尾循环">${iconSvg('chevronRight')}</button></div>
    <div class="message-default-content message-default-variant-${activeIndex} ${animateVariant ? '' : 'is-refresh'}" data-message-default-variant-index="${activeIndex}">
      ${activeVariant.render()}
      <div class="message-default-pagination" role="tablist" aria-label="切换默认页风格">
        ${order.map((variantId, index) => `<button type="button" role="tab" data-message-default-variant="${variantId}" aria-label="默认页风格 ${index + 1}" aria-selected="${variantId === activeIndex ? 'true' : 'false'}"></button>`).join('')}
      </div>
    </div>
  </div>`;
}

export function normalizeMessageDefaultVariantOrder(value = []) {
  const normalized = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item < MESSAGE_DEFAULT_VARIANT_COUNT))];
  for (let index = 0; index < MESSAGE_DEFAULT_VARIANT_COUNT; index += 1) {
    if (!normalized.includes(index)) normalized.push(index);
  }
  return normalized.slice(0, MESSAGE_DEFAULT_VARIANT_COUNT);
}

export function reorderMessageDefaultVariants(value = [], sourceId = -1, targetId = -1) {
  const order = normalizeMessageDefaultVariantOrder(value);
  const source = Number(sourceId);
  const target = Number(targetId);
  if (!order.includes(source) || !order.includes(target) || source === target) return order;
  const next = order.filter((variantId) => variantId !== source);
  next.splice(next.indexOf(target), 0, source);
  return next;
}

export function cycleMessageDefaultVariant(value = [], activeId = 0, direction = 'next') {
  const order = normalizeMessageDefaultVariantOrder(value);
  const position = Math.max(0, order.indexOf(Number(activeId)));
  const offset = direction === 'previous' ? -1 : 1;
  return order[(position + offset + order.length) % order.length];
}

function renderMessageDefaultOrderEditor(order = []) {
  return `<section class="message-default-order-editor" data-message-default-order-editor aria-label="默认页顺序">
    <header><strong>默认页顺序</strong><small>拖动小图调整</small></header>
    <div class="message-default-order-items">
      ${order.map((variantId) => {
        const variant = MESSAGE_DEFAULT_VARIANTS.find((item) => item.id === variantId) || MESSAGE_DEFAULT_VARIANTS[0];
        return `<button class="message-default-order-item" type="button" draggable="true" data-message-default-order-item="${variant.id}" data-message-default-order-select="${variant.id}" aria-label="拖动${variant.label}">
          <span class="message-default-order-thumbnail is-${variant.thumbnail}" aria-hidden="true">${renderOrderThumbnail(variant.thumbnail)}</span>
          <span>${variant.label}</span>
        </button>`;
      }).join('')}
    </div>
    <button class="message-default-order-reset" type="button" data-message-default-order-reset>恢复默认</button>
  </section>`;
}

function renderOrderThumbnail(kind = '') {
  if (kind === 'flower') return '<i></i><i></i><i></i><b></b>';
  if (kind === 'orbit') return `<b>${iconSvg('spark')}</b><i></i><i></i>`;
  return '<i>A</i><b>U</b><i>B</i>';
}

function renderFlowerVariant() {
  return `<div class="message-default-visual message-default-flower" aria-hidden="true">
      <span class="petal petal-one"></span>
      <span class="petal petal-two"></span>
      <span class="petal petal-three"></span>
      <span class="petal petal-four"></span>
      <span class="petal petal-five"></span>
      <span class="flower-center"></span>
      <span class="flower-stem"></span>
      <span class="flower-leaf">${iconSvg('spark')}</span>
    </div>
    <div class="message-default-copy">
      <h2>优秀的你，值得一朵小红花</h2>
      <p>从左侧选择一个会话，安静地继续沟通。</p>
    </div>
    <span class="message-default-action-spacer" aria-hidden="true"></span>`;
}

function renderCollaborationVariant() {
  return `<div class="message-default-visual message-default-collaboration" aria-hidden="true">
      <span class="collaboration-avatar avatar-a">A</span>
      <span class="collaboration-avatar avatar-u">U</span>
      <span class="collaboration-avatar avatar-b">B</span>
    </div>
    <div class="message-default-copy">
      <h2>选择一个会话，开始协作</h2>
      <p>沟通、任务与 Agent 执行都会在同一条消息流里持续更新。</p>
    </div>
    <button class="message-default-action" type="button" data-message-default-action="talent-market">开始新会话</button>`;
}

function renderQuietTaskVariant() {
  return `<div class="message-default-visual message-default-orbit" aria-hidden="true">
      <span class="orbit-core">${iconSvg('spark')}</span>
      <span class="orbit-ring ring-one"></span>
      <span class="orbit-ring ring-two"></span>
      <span class="orbit-node node-one"></span>
      <span class="orbit-node node-two"></span>
      <span class="orbit-node node-three"></span>
    </div>
    <div class="message-default-copy">
      <h2>先把复杂的事，说清楚</h2>
      <p>uBuddy 会帮你整理目标，并找到合适的 Agent 一起完成。</p>
    </div>
    <button class="message-default-action is-secondary" type="button" data-message-default-action="ubuddy">找 uBuddy 整理</button>`;
}
