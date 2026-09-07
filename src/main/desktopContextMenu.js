import { uiText } from '../shared/uiLanguage.js';

export function buildDesktopEditMenuTemplate(params = {}, language = 'zh-CN') {
  const t = (zh, en) => uiText(zh, en, language);
  const editFlags = params.editFlags || {};
  const editable = Boolean(params.isEditable);
  const hasSelection = String(params.selectionText || '').length > 0;
  const canCopy = Boolean(editFlags.canCopy || hasSelection);

  if (!editable) {
    if (!hasSelection) return [];
    return [{ label: t('复制', 'Copy'), role: 'copy', enabled: canCopy }];
  }

  return [
    { label: t('撤销', 'Undo'), role: 'undo', enabled: editFlags.canUndo !== false },
    { label: t('重做', 'Redo'), role: 'redo', enabled: editFlags.canRedo !== false },
    { type: 'separator' },
    { label: t('剪切', 'Cut'), role: 'cut', enabled: editFlags.canCut !== false },
    { label: t('复制', 'Copy'), role: 'copy', enabled: canCopy },
    { label: t('粘贴', 'Paste'), role: 'paste', enabled: editFlags.canPaste !== false },
    { label: t('删除', 'Delete'), role: 'delete', enabled: editFlags.canDelete !== false },
    { type: 'separator' },
    { label: t('全选', 'Select All'), role: 'selectAll', enabled: editFlags.canSelectAll !== false },
  ];
}

export function installDesktopContextMenu(window, { Menu, getLanguage = () => 'zh-CN' }) {
  const webContents = window?.webContents;
  if (!webContents?.on || !Menu?.buildFromTemplate) return;
  webContents.on('context-menu', (_event, params) => {
    const template = buildDesktopEditMenuTemplate(params, getLanguage());
    if (!template.length) return;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window });
  });
}
