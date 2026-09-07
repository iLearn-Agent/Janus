export function messageReceiptPopoverLayout({
  anchor = {},
  popoverWidth = 0,
  popoverHeight = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  margin = 8,
  gap = 8,
} = {}) {
  const width = Math.max(0, Number(popoverWidth || 0));
  const height = Math.max(0, Number(popoverHeight || 0));
  const safeWidth = Math.max(0, Number(viewportWidth || 0));
  const safeHeight = Math.max(0, Number(viewportHeight || 0));
  const topEdge = Number(anchor.top || 0);
  const bottomEdge = Number(anchor.bottom || topEdge);
  const rightEdge = Number(anchor.right || 0);
  const spaceAbove = Math.max(0, topEdge - margin - gap);
  const spaceBelow = Math.max(0, safeHeight - bottomEdge - margin - gap);
  const placement = spaceBelow >= height || spaceBelow >= spaceAbove ? 'below' : 'above';
  const availableHeight = placement === 'below' ? spaceBelow : spaceAbove;
  const left = Math.min(Math.max(margin, rightEdge - width), Math.max(margin, safeWidth - width - margin));
  const top = placement === 'below'
    ? bottomEdge + gap
    : Math.max(margin, topEdge - Math.min(height, availableHeight) - gap);
  return { placement, left, top, availableHeight: Math.max(120, Math.floor(availableHeight)) };
}
