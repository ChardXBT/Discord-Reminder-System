import { fetchSnapshot } from './youtube.js';
const MAX_REQUESTS = 48; // Leave room below the Workers Free external-request limit.

// Discord item delivery lifecycle: the one declared vocabulary for items.status.
export const ITEM_STATUS = Object.freeze({
  BASELINE: 'baseline', PENDING: 'pending', SENDING: 'sending', SENT: 'sent', UNCERTAIN: 'uncertain', RESOLVED: 'resolved'
});
// Every allowed from -> to edge. `uncertain` leaves only through an operator review (DISCORD_REVIEWED_ITEMS).
const ITEM_TRANSITIONS = Object.freeze({
  baseline: Object.freeze([]),
  pending: Object.freeze(['sending']),
  sending: Object.freeze(['sent', 'uncertain', 'pending']),
  sent: Object.freeze([]),
  uncertain: Object.freeze(['resolved', 'pending']),
  resolved: Object.freeze([])
});
// Derived (never stored) phase: a pending row whose retry_at is still in the future.
export const BACKED_OFF = 'backed-off';
const ITEMS_SCHEMA_VERSION = '2';
const STATUS_LIST = Object.values(ITEM_STATUS).map(s => `'${s}'`).join(',');
const itemsTable = name => `CREATE TABLE IF NOT EXISTS ${name} (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (${STATUS_LIST})),
        message_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0, image_url TEXT,
        CHECK ((status = 'sent') = (message_id IS NOT NULL))
      )`;

export function assertItemTransition(from, to) {
  if (!Object.hasOwn(ITEM_TRANSITIONS, from)) throw new Error(`Unknown item status: ${from}`);
  if (!Object.hasOwn(ITEM_TRANSITIONS, to)) throw new Error(`Unknown item status: ${to}`);
  if (!ITEM_TRANSITIONS[from].includes(to)) throw new Error(`Invalid item transition: ${from} -> ${to}`);
}

export function itemPhase(row, now) {
  switch (row.status) {
    case ITEM_STATUS.PENDING: return row.retry_at > now ? BACKED_OFF : ITEM_STATUS.PENDING;
    case ITEM_STATUS.BASELINE: case ITEM_STATUS.SENDING: case ITEM_STATUS.SENT:
    case ITEM_STATUS.UNCERTAIN: case ITEM_STATUS.RESOLVED: return row.status;
    default: throw new Error(`Unknown item status: ${row.status}`);
  }
}

// Run-result vocabulary. These exact strings are the Worker's contract ('needs-review' fails the cron run).
export const RUN_STATUS = Object.freeze({
  ALREADY_CHECKED: 'already-checked', OUTSIDE_WINDOW: 'outside-window', BASELINE: 'baseline', PENDING: 'pending',
  RATE_LIMITED: 'rate-limited', NEEDS_REVIEW: 'needs-review', COMPLETE: 'complete'
});
const RUN_STATUSES = new Set(Object.values(RUN_STATUS));
export function runResult(status, fields = {}) {
  if (!RUN_STATUSES.has(status)) throw new Error(`Unknown run status: ${status}`);
  return { status, ...fields };
}

export class ReminderEngine {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.tail = Promise.resolve();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      ${itemsTable('items')};
    `);
    if (![...this.sql.exec('PRAGMA table_info(items)')].some(column => column.name === 'image_url')) {
      this.sql.exec('ALTER TABLE items ADD COLUMN image_url TEXT');
    }
    if (this.get('items_schema') !== ITEMS_SCHEMA_VERSION) this.migrateItems();
    // An interrupted request may already have reached Discord; never replay it blindly.
    assertItemTransition(ITEM_STATUS.SENDING, ITEM_STATUS.UNCERTAIN);
    this.sql.exec(`UPDATE items SET status = '${ITEM_STATUS.UNCERTAIN}' WHERE status = '${ITEM_STATUS.SENDING}'`);
  }

  // Rebuilds items under the current CHECK constraints, keeping rowid (delivery order) and every column.
  // Legacy rows map to the state they meant; anything unknown or contradictory becomes `uncertain`
  // (needs review): never re-sent automatically, never silently dropped. A `sent` row without a message ID
  // stays delivered (`resolved`), as its record claims; resending it could duplicate the announcement.
  migrateItems() {
    for (const row of this.sql.exec(`SELECT id, status, message_id FROM items
        WHERE status NOT IN (${STATUS_LIST}) OR status = 'sending' OR (status = 'sent') <> (message_id IS NOT NULL)`)) {
      console.error('Legacy delivery record remapped for review', JSON.stringify(row));
    }
    this.storage.transactionSync(() => {
      this.sql.exec(`${itemsTable('items_next')};`);
      this.sql.exec(`INSERT INTO items_next (rowid,id,kind,url,status,message_id,retry_at,image_url)
        SELECT rowid,id,kind,url,
          CASE
            WHEN status = 'sent' AND message_id IS NOT NULL THEN 'sent'
            WHEN status = 'sent' THEN 'resolved'
            WHEN message_id IS NOT NULL THEN 'uncertain'
            WHEN status IN ('baseline','pending','uncertain','resolved') THEN status
            ELSE 'uncertain'
          END,
          CASE WHEN status = 'sent' THEN message_id ELSE NULL END,
          COALESCE(retry_at, 0), image_url
        FROM items ORDER BY rowid`);
      this.sql.exec('DROP TABLE items');
      this.sql.exec('ALTER TABLE items_next RENAME TO items');
      this.set('items_schema', ITEMS_SCHEMA_VERSION);
    });
  }

  // The single writer of items.status after insertion; refuses edges the lifecycle does not declare.
  transition(id, from, to, fields = {}) {
    assertItemTransition(from, to);
    const columns = Object.keys(fields);
    if (columns.some(c => !['message_id', 'retry_at'].includes(c))) throw new Error('Unexpected item field');
    const changed = [...this.sql.exec(
      `UPDATE items SET status='${to}'${columns.map(c => `, ${c}=?`).join('')} WHERE id=? AND status='${from}' RETURNING id`,
      ...columns.map(c => fields[c]), id)];
    if (changed.length !== 1) throw new Error(`Item ${id} was not ${from}`);
  }

  // Operator decisions for uncertain deliveries: `delivered` (seen in Discord or posted by hand) resolves the
  // item; `retry` (confirmed missing) re-queues it once. A stale entry can never cause a second automatic resend.
  applyReviews(reviews = []) {
    if (!reviews.length) return;
    this.storage.transactionSync(() => {
      for (const { id, decision } of reviews) {
        const row = [...this.sql.exec('SELECT status FROM items WHERE id = ?', id)][0];
        if (row?.status !== ITEM_STATUS.UNCERTAIN) continue;
        switch (decision) {
          case 'delivered': this.transition(id, ITEM_STATUS.UNCERTAIN, ITEM_STATUS.RESOLVED); break;
          case 'retry':
            if (this.get(`review:${id}`) === 'retry') { console.error('Uncertain delivery was already retried once; mark it delivered', id); break; }
            this.transition(id, ITEM_STATUS.UNCERTAIN, ITEM_STATUS.PENDING, { retry_at: 0 });
            this.set(`review:${id}`, 'retry');
            break;
          default: throw new Error(`Unknown review decision: ${decision}`);
        }
      }
    });
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
    if (config.reviews?.length) {
      this.applyReviews(config.reviews);
      await this.storage.sync();
    }
    if (this.get('completed_slot') === slot) return runResult(RUN_STATUS.ALREADY_CHECKED);
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
          this.sql.exec(`INSERT INTO items (id,kind,url,status,image_url) VALUES (?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET image_url=COALESCE(excluded.image_url,items.image_url)`,
            `${item.kind}:${item.id}`, item.kind, item.url, first ? ITEM_STATUS.BASELINE : ITEM_STATUS.PENDING, item.image || null);
        }
        if (first) {
          this.set('channel', result.channelId);
          this.set('destination', config.webhook.split('/').slice(0, -1).join('/'));
          this.set('completed_slot', slot);
        }
        this.set('scanned_slot', slot);
      });
      await this.storage.sync();
      if (first) return runResult(RUN_STATUS.BASELINE, { items: result.items.length });
    }
    let delivered = 0, backedOff = 0;
    const pending = [...this.sql.exec('SELECT id,kind,url,image_url,status,retry_at FROM items WHERE status = ? ORDER BY rowid', ITEM_STATUS.PENDING)];
    for (const item of pending) {
      if (requests >= MAX_REQUESTS) return runResult(RUN_STATUS.PENDING, { delivered });
      // A backed-off item waits for its own retry_at; it must not starve the deliverable items behind it.
      if (itemPhase(item, now()) === BACKED_OFF) { backedOff++; continue; }
      this.transition(item.id, ITEM_STATUS.PENDING, ITEM_STATUS.SENDING);
      await this.storage.sync();
      let response;
      try {
        const label = item.kind === 'posts' ? 'new post' : 'new video';
        const content = config.mentionUserId ? `<@${config.mentionUserId}> ${label}` : 'New content:';
        response = await limitedRequest(config.webhook, {
          method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            content: `${content}\n<${item.url}>`,
            allowed_mentions: { parse: [], ...(config.mentionUserId ? { users: [config.mentionUserId] } : {}) },
            embeds: [{ title: item.kind === 'posts' ? 'New post' : 'New video', url: item.url,
              ...(item.image_url ? { image: { url: item.image_url } } : {}) }]
          })
        });
      } catch {
        this.transition(item.id, ITEM_STATUS.SENDING, ITEM_STATUS.UNCERTAIN);
        await this.storage.sync();
        console.error('Discord delivery uncertain', item.id);
        continue;
      }
      if (response.status === 429) {
        let seconds = 60;
        try { seconds = Number((await response.json()).retry_after) || 60; } catch {}
        seconds = Math.max(1, Math.min(seconds, 86400));
        this.transition(item.id, ITEM_STATUS.SENDING, ITEM_STATUS.PENDING, { retry_at: now() + Math.ceil(seconds * 1000) });
        await this.storage.sync();
        // Discord's limit covers the whole webhook: stop this run rather than hammer it with the next item.
        return runResult(RUN_STATUS.RATE_LIMITED, { delivered });
      }
      if ([400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) {
        await response.body?.cancel();
        this.transition(item.id, ITEM_STATUS.SENDING, ITEM_STATUS.PENDING);
        await this.storage.sync();
        throw new Error(`Discord rejected delivery: HTTP ${response.status}`);
      }
      let message;
      try { message = response.ok ? await response.json() : null; } catch {}
      if (!message || !/^\d+$/.test(message.id || '')) {
        await response.body?.cancel().catch(() => {});
        this.transition(item.id, ITEM_STATUS.SENDING, ITEM_STATUS.UNCERTAIN);
        await this.storage.sync();
        console.error('Discord delivery uncertain', item.id);
        continue;
      }
      this.transition(item.id, ITEM_STATUS.SENDING, ITEM_STATUS.SENT, { message_id: message.id });
      await this.storage.sync();
      delivered++;
    }
    // Backed-off items keep the slot open so a later tick in this window can retry them.
    if (backedOff) return runResult(RUN_STATUS.RATE_LIMITED, { delivered });
    this.set('completed_slot', slot);
    await this.storage.sync();
    const uncertain = [...this.sql.exec('SELECT COUNT(*) AS count FROM items WHERE status = ?', ITEM_STATUS.UNCERTAIN)][0].count;
    return runResult(uncertain ? RUN_STATUS.NEEDS_REVIEW : RUN_STATUS.COMPLETE, { delivered, uncertain });
  }
}
