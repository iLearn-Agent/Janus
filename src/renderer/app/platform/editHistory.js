export function createDesktopEditHistory({ documentRef = document, EventCtor = Event } = {}) {
  let lastEditableElement = null;
  let applyingHistory = false;
  const histories = new WeakMap();
  const persistentHistories = new Map();

  const isEditableElement = (element) => Boolean(element) && (
    element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' || element.isContentEditable
  );

  const editableValue = (element) => {
    if (!element) return '';
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return element.value || '';
    return element.isContentEditable ? element.textContent || '' : '';
  };

  const setEditableValue = (element, value) => {
    if (!element) return;
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      element.value = value;
      const cursor = value.length;
      element.setSelectionRange?.(cursor, cursor);
    } else if (element.isContentEditable) {
      element.textContent = value;
    }
  };

  const persistentHistoryKey = (element) => {
    if (element?.id !== 'chat-input') return '';
    const chatKey = String(element.dataset?.chatInputKey || '').trim();
    const sessionId = String(element.dataset?.chatInputSession || '').trim();
    return `chat-input:${chatKey || (sessionId ? `session:${sessionId}` : 'new-chat')}`;
  };

  const ensureHistory = (element) => {
    if (!isEditableElement(element)) return null;
    const historyKey = persistentHistoryKey(element);
    let history = historyKey ? persistentHistories.get(historyKey) : histories.get(element);
    if (!history) {
      history = { entries: [editableValue(element)], index: 0 };
      if (historyKey) persistentHistories.set(historyKey, history);
      else histories.set(element, history);
    } else if (historyKey) {
      const value = editableValue(element);
      if (history.entries[history.index] !== value) {
        history.entries = history.entries.slice(0, history.index + 1);
        history.entries.push(value);
        if (history.entries.length > 80) history.entries.shift();
        history.index = history.entries.length - 1;
      }
    }
    return history;
  };

  const remember = (element) => {
    if (!isEditableElement(element)) return null;
    lastEditableElement = element;
    ensureHistory(element);
    return element;
  };

  const record = (element) => {
    if (applyingHistory || !isEditableElement(element)) return;
    const history = ensureHistory(element);
    if (!history) return;
    const value = editableValue(element);
    if (history.entries[history.index] === value) return;
    history.entries = history.entries.slice(0, history.index + 1);
    history.entries.push(value);
    if (history.entries.length > 80) history.entries.shift();
    history.index = history.entries.length - 1;
  };

  const commandTarget = ({ includeChatFallback = true } = {}) => {
    const active = documentRef.activeElement;
    if (isEditableElement(active)) return active;
    if (lastEditableElement?.isConnected) return lastEditableElement;
    return includeChatFallback ? documentRef.getElementById('chat-input') : null;
  };

  const applyCommand = (action) => {
    if (action !== 'undo' && action !== 'redo') return false;
    const target = commandTarget();
    const history = ensureHistory(target);
    if (!target || !history) return false;
    const nextIndex = action === 'undo'
      ? Math.max(0, history.index - 1)
      : Math.min(history.entries.length - 1, history.index + 1);
    if (nextIndex === history.index) return false;
    history.index = nextIndex;
    applyingHistory = true;
    target.focus();
    setEditableValue(target, history.entries[history.index] || '');
    target.dispatchEvent(new EventCtor('input', { bubbles: true }));
    applyingHistory = false;
    remember(target);
    return true;
  };

  documentRef.addEventListener('focusin', (event) => remember(event.target));
  documentRef.addEventListener('input', (event) => record(event.target));
  documentRef.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey) return;
    if (event.target?.id !== 'chat-input' || (!event.ctrlKey && !event.metaKey)) return;
    const key = String(event.key || '').toLowerCase();
    const action = key === 'z'
      ? event.shiftKey ? 'redo' : 'undo'
      : key === 'y' && !event.shiftKey ? 'redo' : '';
    if (!action) return;
    event.preventDefault();
    applyCommand(action);
  });

  return {
    applyCommand,
    commandTarget,
    ensureHistory,
    isEditableElement,
    lastEditableElement: () => lastEditableElement,
    remember,
  };
}
