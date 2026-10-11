import { fetchSnapshot } from './youtube.js';
const MAX_REQUESTS = 48; // Leave room below the Workers Free external-request limit.

export class ReminderEngine {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.tail = Promise.resolve();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('baseline','pending','sending','sent','uncertain')),
        message_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    // An interrupted request may already have reached Discord; never replay it blindly.
    this.sql.exec("UPDATE items SET status = 'uncertain' WHERE status = 'sending'");
  }

  run(config, slot, { snapshot = fetchSnapshot, request = fetch, now = Date.now } = {}) {
    const job = this.tail.then(() => this.check(config, slot, snapshot, request, now));
    this.tail = job.catch(() => {});
    return job;
  }

  get(key) {
    return [...this.sql.exec('SELECT value FROM settings WHERE key = ?', key)][0]?.value;
  }

  set(key, value) {
    this.sql.exec('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }

  async check(config, slot, snapshot, request, now) {
    if (this.get('completed_slot') === slot) return { status: 'already-checked' };
    if (this.get('destination') && this.get('destination') !== config.webhook.split('/').slice(0, -1).join('/')) {
      throw new Error('Discord webhook identity changed; restore it or use a new Worker');
    }
    let requests = 0;
    const limitedRequest = (...args) => {
      if (requests >= MAX_REQUESTS) throw new Error('Request budget exceeded; snapshot was not saved');
      requests++;
      return request(...args);
    };
    if (this.get('scanned_slot') !== slot) {
      const result = await snapshot(config, limitedRequest);
      const channel = this.get('channel');
      if (channel && channel !== result.channelId) throw new Error('Tracked channel changed; keep the original channel or use a new Worker');
      const first = !channel;
      this.storage.transactionSync(() => {
        for (const item of result.items) {
          this.sql.exec('INSERT OR IGNORE INTO items (id,kind,url,status) VALUES (?,?,?,?)',
            `${item.kind}:${item.id}`, item.kind, item.url, first ? 'baseline' : 'pending');
        }
        if (first) {
          this.set('channel', result.channelId);
          this.set('destination', config.webhook.split('/').slice(0, -1).join('/'));
          this.set('completed_slot', slot);
        }
        this.set('scanned_slot', slot);
      });
      await this.storage.sync();
      if (first) return { status: 'baseline', items: result.items.length };
    }
    let delivered = 0;
    const pending = [...this.sql.exec("SELECT id,url,retry_at FROM items WHERE status = 'pending' ORDER BY rowid")];
    for (const item of pending) {
      if (requests >= MAX_REQUESTS) return { status: 'pending', delivered };
      if (item.retry_at > now()) return { status: 'rate-limited', delivered };
      this.sql.exec("UPDATE items SET status = 'sending' WHERE id = ?", item.id);
      await this.storage.sync();
      let response;
      try {
        response = await limitedRequest(config.webhook, {
          method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ content: `New content: ${item.url}`, allowed_mentions: { parse: [] }, flags: 4 })
        });
      } catch {
        this.sql.exec("UPDATE items SET status = 'uncertain' WHERE id = ?", item.id);
        await this.storage.sync();
        console.error('Discord delivery uncertain', item.id);
        continue;
      }
      if (response.status === 429) {
        let seconds = 60;
        try { seconds = Number((await response.json()).retry_after) || 60; } catch {}
        seconds = Math.max(1, Math.min(seconds, 86400));
        this.sql.exec("UPDATE items SET status='pending', retry_at=? WHERE id=?", now() + Math.ceil(seconds * 1000), item.id);
        await this.storage.sync();
        return { status: 'rate-limited', delivered };
      }
      if ([400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) {
        await response.body?.cancel();
        this.sql.exec("UPDATE items SET status='pending' WHERE id=?", item.id);
        await this.storage.sync();
        throw new Error(`Discord rejected delivery: HTTP ${response.status}`);
      }
      let message;
      try { message = response.ok ? await response.json() : null; } catch {}
      if (!message || !/^\d+$/.test(message.id || '')) {
        await response.body?.cancel().catch(() => {});
        this.sql.exec("UPDATE items SET status='uncertain' WHERE id=?", item.id);
        await this.storage.sync();
        console.error('Discord delivery uncertain', item.id);
        continue;
      }
      this.sql.exec("UPDATE items SET status='sent', message_id=? WHERE id=?", message.id, item.id);
      await this.storage.sync();
      delivered++;
    }
    this.set('completed_slot', slot);
    await this.storage.sync();
    const uncertain = [...this.sql.exec("SELECT COUNT(*) AS count FROM items WHERE status='uncertain'")][0].count;
    return { status: uncertain ? 'needs-review' : 'complete', delivered, uncertain };
  }
}
