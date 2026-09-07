export class ConversationSerialQueue {
  constructor() {
    this.tails = new Map();
  }

  enqueue(key, operation) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new Error('Conversation queue key is required.');
    if (typeof operation !== 'function') throw new Error('Conversation queue operation is required.');
    const previous = this.tails.get(normalizedKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.tails.set(normalizedKey, current);
    current.finally(() => {
      if (this.tails.get(normalizedKey) === current) this.tails.delete(normalizedKey);
    }).catch(() => {});
    return current;
  }

  size() {
    return this.tails.size;
  }
}
