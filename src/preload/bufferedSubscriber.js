export function createBufferedSubscriber({ limit = 20 } = {}) {
  const subscribers = new Set();
  const pending = [];
  const bufferLimit = Math.max(1, Number(limit) || 20);

  const deliver = (callback, payload) => {
    try {
      callback(payload);
    } catch {
      // Keep IPC delivery isolated from renderer callback failures.
    }
  };

  return {
    emit(payload) {
      if (!subscribers.size) {
        pending.push(payload);
        if (pending.length > bufferLimit) pending.splice(0, pending.length - bufferLimit);
        return;
      }
      for (const callback of subscribers) deliver(callback, payload);
    },
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {};
      subscribers.add(callback);
      const buffered = pending.splice(0, pending.length);
      for (const payload of buffered) deliver(callback, payload);
      return () => subscribers.delete(callback);
    },
  };
}
