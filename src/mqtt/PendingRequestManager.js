/**
 * In-memory pending MQTT request correlation (request_id → waiters).
 * Also mirrored in DB (pbx_call_requests / pbx_mqtt_requests).
 */
class PendingRequestManager {
  constructor() {
    this.map = new Map();
  }

  add(requestId, meta = {}, timeoutMs = 15000) {
    if (this.map.has(requestId)) {
      throw new Error(`Duplicate request_id ${requestId}`);
    }
    let timer;
    const entry = {
      ...meta,
      requestId,
      createdAt: Date.now(),
      promise: null,
      resolve: null,
      reject: null,
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      timer = setTimeout(() => {
        this.map.delete(requestId);
        reject(new Error(`MQTT command timed out (${requestId})`));
      }, timeoutMs);
    });
    entry.clearTimer = () => clearTimeout(timer);
    this.map.set(requestId, entry);
    return entry.promise;
  }

  settle(requestId, payload, error = null) {
    const entry = this.map.get(requestId);
    if (!entry) return false;
    entry.clearTimer();
    this.map.delete(requestId);
    if (error) entry.reject(error);
    else entry.resolve(payload);
    return true;
  }

  has(requestId) {
    return this.map.has(requestId);
  }

  size() {
    return this.map.size;
  }

  clear() {
    for (const [, entry] of this.map) {
      entry.clearTimer();
      entry.reject(new Error("Pending requests cleared"));
    }
    this.map.clear();
  }
}

module.exports = { PendingRequestManager };
