import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReminderEngine } from '../src/reminder.js';
import { readConfig } from '../src/config.js';
import { CHANNEL, OTHER_CHANNEL, ENV, storage, item, snapshot, success } from './helpers.js';

const config = readConfig(ENV);
const rows = s => [...s.sql.exec('SELECT * FROM items ORDER BY rowid')];
async function baseline(e, items = [item('old')]) {
  return e.run(config, 'first', { snapshot: snapshot(items), request: () => { throw new Error('Unexpected delivery'); } });
}
test('initial check records history without sending', async () => {
  const s = storage(), e = new ReminderEngine(s);
  assert.deepEqual(await baseline(e), { status: 'baseline', items: 1 });
  assert.equal(rows(s)[0].status, 'baseline'); assert.equal(e.get('channel'), CHANNEL); s.db.close();
});
test('failed initial scan leaves no partial baseline', async () => {
  const s = storage(), e = new ReminderEngine(s);
  await assert.rejects(e.run(config, 'first', { snapshot: async () => { throw new Error('Posts unavailable'); } }));
  assert.equal(e.get('channel'), undefined); assert.equal(rows(s).length, 0);
  assert.equal((await baseline(e)).status, 'baseline'); s.db.close();
});
test('all new content delivers once with direct links, embeds and no default mentions', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e);
  const calls = [], items = [item('old'), item('new1'), item('new2'), item('Ugnewpost', 'posts')];
  const options = { snapshot: snapshot(items), request: async (url, init) => { calls.push({ url, init }); return success(String(100 + calls.length)); } };
  assert.equal((await e.run(config, 'second', options)).delivered, 3);
  assert.equal((await e.run(config, 'second', options)).status, 'already-checked');
  await e.run(config, 'third', options); assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => JSON.parse(c.init.body).content), items.slice(1).map(i => `New content:\n<${i.url}>`));
  assert.ok(calls.every(c => JSON.parse(c.init.body).flags === undefined && !JSON.parse(c.init.body).allowed_mentions.parse.length));
  assert.deepEqual(calls.map(c => JSON.parse(c.init.body).embeds[0].url), items.slice(1).map(i => i.url));
  assert.ok(calls.every(c => new URL(c.url).searchParams.get('wait') === 'true')); s.db.close();
});
test('pinning, edits, reordering, removal and reappearance do not create announcements', async () => {
  const s = storage(), e = new ReminderEngine(s), a = item('Ugpinned', 'posts'), b = item('Ugordinary', 'posts');
  await baseline(e, [b, a]); let calls = 0;
  const options = items => ({ snapshot: snapshot(items), request: async () => { calls++; return success(); } });
  await e.run(config, 'second', options([a, b])); await e.run(config, 'third', options([b]));
  await e.run(config, 'fourth', options([a, b, item('Ugnew', 'posts')])); assert.equal(calls, 1); s.db.close();
});
test('concurrent runs serialize and scan a slot only once', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e); let scans = 0, deliveries = 0;
  const options = { snapshot: async () => { scans++; await new Promise(r => setTimeout(r, 10)); return { channelId: CHANNEL, items: [item('new')] }; },
    request: async () => { deliveries++; return success(); } };
  await Promise.all([e.run(config, 'second', options), e.run(config, 'second', options)]);
  assert.equal(scans, 1); assert.equal(deliveries, 1); s.db.close();
});
test('temporary source failure retains checkpoint and later recovers all items', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e);
  await assert.rejects(e.run(config, 'second', { snapshot: async () => { throw new Error('503'); } }));
  assert.equal(e.get('completed_slot'), 'first'); let calls = 0;
  await e.run(config, 'second', { snapshot: snapshot([item('new1'), item('new2')]), request: async () => { calls++; return success(); } });
  assert.equal(calls, 2); s.db.close();
});
test('429 retry_after survives restart and retries without rescanning', async () => {
  const s = storage(); let e = new ReminderEngine(s); await baseline(e);
  let calls = 0, scans = 0, time = 1000;
  const options = { snapshot: async () => { scans++; return { channelId: CHANNEL, items: [item('new')] }; },
    request: async () => ++calls === 1 ? Response.json({ retry_after: 12.5 }, { status: 429 }) : success(), now: () => time };
  assert.equal((await e.run(config, 'second', options)).status, 'rate-limited'); assert.equal(rows(s).at(-1).retry_at, 13500);
  e = new ReminderEngine(s); assert.equal((await e.run(config, 'second', options)).status, 'rate-limited'); assert.equal(calls, 1);
  time = 13500; assert.equal((await e.run(config, 'second', options)).delivered, 1); assert.equal(scans, 1); s.db.close();
});
test('definitive webhook rejection retains pending item for safe retry', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e);
  await assert.rejects(e.run(config, 'second', { snapshot: snapshot([item('new')]), request: async () => new Response('forbidden', { status: 403 }) }), /403/);
  assert.equal(rows(s).at(-1).status, 'pending');
  assert.equal((await e.run(config, 'second', { request: async () => success(), snapshot: () => { throw new Error('Unexpected scan'); } })).delivered, 1); s.db.close();
});

test('rate-limit delays are bounded even when Discord returns unusable values', async () => {
  for (const [reply, delay] of [[{ retry_after: -20 }, 1000], [{ retry_after: 999999 }, 86400000], [{ retry_after: 'invalid' }, 60000], [null, 60000]]) {
    const s = storage(), e = new ReminderEngine(s); await baseline(e);
    const result = await e.run(config, 'second', {
      snapshot: snapshot([item('new')]), now: () => 1000,
      request: async () => Response.json(reply, { status: 429 })
    });
    assert.equal(result.status, 'rate-limited');
    assert.equal(rows(s).at(-1).status, 'pending');
    assert.equal(rows(s).at(-1).retry_at, 1000 + delay); s.db.close();
  }
});

test('a later window resumes a rate-limited queue and includes newly discovered content', async () => {
  const s = storage(); let e = new ReminderEngine(s); await baseline(e);
  await e.run(config, 'second', {
    snapshot: snapshot([item('queued')]), now: () => 1000,
    request: async () => Response.json({ retry_after: 60 }, { status: 429 })
  });
  e = new ReminderEngine(s); const delivered = [];
  const result = await e.run(config, 'next-window', {
    snapshot: snapshot([item('fresh', 'posts')]), now: () => 61000,
    request: async (url, init) => { delivered.push(JSON.parse(init.body).content); return success(String(100 + delivered.length)); }
  });
  assert.equal(result.delivered, 2);
  assert.deepEqual(delivered, [item('queued'), item('fresh', 'posts')].map(i => `New content:\n<${i.url}>`));
  assert.equal(rows(s).filter(r => r.status === 'pending').length, 0); s.db.close();
});

test('personalized messages mention only the configured user and retain images across retries', async () => {
  const s = storage(); let e = new ReminderEngine(s); await baseline(e);
  const userId = '111111111111111111', personalized = { ...config, mentionUserId: userId };
  const items = [{ ...item('short'), image: 'https://i.ytimg.com/vi/abcDEF_1234/hqdefault.jpg' },
    { ...item('Ugimagepost', 'posts'), image: 'https://yt3.ggpht.com/example=s680' }, item('Ugtextpost', 'posts')];
  await e.run(personalized, 'second', { snapshot: snapshot(items), now: () => 1000,
    request: async () => Response.json({ retry_after: 1 }, { status: 429 }) });
  e = new ReminderEngine(s); const bodies = [];
  await e.run(personalized, 'second', { now: () => 2000, snapshot: () => { throw new Error('Unexpected rescan'); },
    request: async (url, init) => { bodies.push(JSON.parse(init.body)); return success(String(100 + bodies.length)); } });
  assert.deepEqual(bodies.map(b => b.content), items.map(i => `<@${userId}> new ${i.kind === 'posts' ? 'post' : 'video'}\n<${i.url}>`));
  assert.ok(bodies.every(b => !b.flags && b.allowed_mentions.parse.length === 0 && b.allowed_mentions.users.length === 1 && b.allowed_mentions.users[0] === userId));
  assert.deepEqual(bodies.map(b => b.embeds[0].image?.url), items.map(i => i.image)); s.db.close();
});

test('image migration preserves existing baseline, sent and pending records', async () => {
  const s = storage();
  s.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE items (id TEXT PRIMARY KEY,kind TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,retry_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO settings VALUES ('channel','${CHANNEL}');
    INSERT INTO items VALUES ('posts:old','posts','https://www.youtube.com/post/old','baseline',NULL,0);
    INSERT INTO items VALUES ('shorts:sent','shorts','https://www.youtube.com/shorts/sent','sent','123456789012345678',0);
    INSERT INTO items VALUES ('posts:queued','posts','https://www.youtube.com/post/queued','pending',NULL,0);`);
  const e = new ReminderEngine(s), calls = [];
  await e.run(config, 'next', { snapshot: snapshot([item('old', 'posts'), item('sent'), { ...item('queued', 'posts'), image: 'https://yt3.ggpht.com/image' }]),
    request: async (url, init) => { calls.push(JSON.parse(init.body)); return success(); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].embeds[0].image.url, 'https://yt3.ggpht.com/image');
  assert.equal(rows(s)[0].status, 'baseline'); assert.equal(rows(s)[1].message_id, '123456789012345678');
  new ReminderEngine(s); assert.equal([...s.sql.exec('PRAGMA table_info(items)')].filter(c => c.name === 'image_url').length, 1); s.db.close();
});
test('timeout, 5xx, 408 and malformed confirmation never replay an uncertain delivery', async () => {
  for (const request of [async () => { throw new Error('timeout with secret'); }, async () => new Response('gateway', { status: 502 }),
    async () => new Response('not JSON'), async () => new Response(null, { status: 204 }), async () => new Response('timeout', { status: 408 })]) {
    const s = storage(); let e = new ReminderEngine(s); await baseline(e);
    assert.equal((await e.run(config, 'second', { snapshot: snapshot([item('new')]), request })).status, 'needs-review');
    assert.equal(rows(s).at(-1).status, 'uncertain'); e = new ReminderEngine(s); let calls = 0;
    await e.run(config, 'third', { snapshot: snapshot([item('new')]), request: async () => { calls++; return success(); } });
    assert.equal(calls, 0); s.db.close();
  }
});
test('crash after Discord accepts but before saving confirmation cannot duplicate', async () => {
  const s = storage(); let e = new ReminderEngine(s); await baseline(e);
  const exec = s.sql.exec; s.sql.exec = (query, ...params) => {
    if (query.includes("SET status='sent'")) throw new Error('Simulated interruption'); return exec(query, ...params);
  };
  let calls = 0;
  await assert.rejects(e.run(config, 'second', { snapshot: snapshot([item('new')]), request: async () => { calls++; return success(); } }));
  assert.equal(rows(s).at(-1).status, 'sending'); s.sql.exec = exec; e = new ReminderEngine(s);
  await e.run(config, 'second', { request: async () => { calls++; return success(); } });
  assert.equal(calls, 1); assert.equal(rows(s).at(-1).status, 'uncertain'); s.db.close();
});
test('storage sync failure prevents outbound delivery', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e); let calls = 0;
  s.sync = async () => { throw new Error('Disk unavailable'); };
  await assert.rejects(e.run(config, 'second', { snapshot: snapshot([item('new')]), request: async () => { calls++; return success(); } }));
  assert.equal(calls, 0); s.db.close();
});
test('large batches respect budget and resume without fetching YouTube again', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e); let scans = 0, calls = 0;
  const options = { snapshot: async () => { scans++; return { channelId: CHANNEL, items: Array.from({ length: 55 }, (_, i) => item(`new${i}`)) }; },
    request: async () => { calls++; return success(String(calls)); } };
  assert.equal((await e.run(config, 'second', options)).status, 'pending'); assert.equal(calls, 48);
  const result = await e.run(config, 'second', options); assert.equal(result.status, 'complete'); assert.equal(result.delivered, 7);
  assert.equal(scans, 1); assert.equal(calls, 55); s.db.close();
});
test('oversized source scans stop before mutating state', async () => {
  const s = storage(), e = new ReminderEngine(s);
  const scan = async (c, request) => { for (let i = 0; i < 49; i++) await request(c.shorts); return { channelId: CHANNEL, items: [item('old')] }; };
  await assert.rejects(e.run(config, 'first', { snapshot: scan, request: async () => new Response('page') }), /Request budget/);
  assert.equal(e.get('channel'), undefined); assert.equal(rows(s).length, 0); s.db.close();
});
test('changing channel/destination is blocked; rotating a webhook token works', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e);
  await assert.rejects(e.run(config, 'second', { snapshot: snapshot([], OTHER_CHANNEL) }), /channel changed/);
  await assert.rejects(e.run({ ...config, webhook: 'https://discord.com/api/webhooks/999/token?wait=true' }, 'second'), /identity changed/);
  await e.run({ ...config, webhook: 'https://discord.com/api/webhooks/123456789012345678/rotated?wait=true' }, 'second', { snapshot: snapshot([]) }); s.db.close();
});
test('baseline and sent IDs survive closing and reopening a file-backed database', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-test-')), filename = path.join(folder, 'state.sqlite');
  let s = storage(filename), e = new ReminderEngine(s);
  try {
    await baseline(e); await e.run(config, 'second', { snapshot: snapshot([item('old'), item('new')]), request: async () => success() });
    s.db.close(); s = storage(filename); e = new ReminderEngine(s); let calls = 0;
    await e.run(config, 'third', { snapshot: snapshot([item('old'), item('new')]), request: async () => { calls++; return success(); } });
    assert.equal(calls, 0); assert.deepEqual(rows(s).map(r => r.status), ['baseline', 'sent']);
  } finally { s.db.close(); fs.rmSync(folder, { recursive: true }); }
});
