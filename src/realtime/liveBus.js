/**
 * Simple SSE / event bus for live PBX updates to browsers.
 * No Socket.IO dependency — uses Server-Sent Events.
 */
class LiveBus {
  constructor() {
    this.clients = new Set();
  }

  add(res, meta = {}) {
    const client = { res, meta, id: `${Date.now()}-${Math.random()}` };
    this.clients.add(client);
    res.on("close", () => this.clients.delete(client));
    return client;
  }

  broadcast(event, data, filterFn = null) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (filterFn && !filterFn(client.meta)) continue;
      try {
        client.res.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  count() {
    return this.clients.size;
  }
}

const liveBus = new LiveBus();
module.exports = { liveBus, LiveBus };
