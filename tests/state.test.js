import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderEngine, ITEM_STATUS, RUN_STATUS, BACKED_OFF, assertItemTransition, itemPhase, runResult } from '../src/reminder.js';
import { readConfig } from '../src/config.js';
import { CHANNEL, ENV, storage, item, snapshot, success } from './helpers.js';

const config = readConfig(ENV);
const rows = s => [...s.sql.exec('SELECT rowid AS rowid, * FROM items ORDER BY rowid')];
const status = (s, id) => [...s.sql.exec('SELECT status FROM items WHERE id = ?', id)][0]?.status;
const reviewed = value => readConfig({ ...ENV, DISCORD_REVIEWED_ITEMS: value });
async function baseline(e, items = [item('old')]) {
  return e.run(config, 'first', { snapshot: snapshot(items), request: () => { throw new Error('Unexpected delivery'); } });
}
async function makeUncertain(e, id = 'new') {
  return e.run(config, 'second', { snapshot: snapshot([item(id)]), request: async () => new Response('gateway', { status: 502 }) });
}

test('item lifecycle declares every edge and refuses the rest', () => {
  for (const [from, to] of [['pending', 'sending'], ['sending', 'sent'], ['sending', 'uncertain'], ['sending', 'pending'],
    ['uncertain', 'resolved'], ['uncertain', 'pending']]) assert.doesNotThrow(() => assertItemTransition(from, to));
  for (const [from, to] of [['baseline', 'pending'], ['baseline', 'sending'], ['sent', 'pending'], ['sent', 'uncertain'],
    ['pending', 'sent'], ['uncertain', 'sent'], ['uncertain', 'sending'], ['resolved', 'pending'], ['pending', 'pending']]) {
    assert.throws(() => assertItemTransition(from, to), /Invalid item transition/);
  }
  assert.throws(() => assertItemTransition('bogus', 'pending'), /Unknown item status/);
  assert.throws(() => assertItemTransition('pending', 'needs-review'), /Unknown item status/);
});

test('backed-off is derived from pending + future retry_at, and unknown statuses fail loudly', () => {
  assert.equal(itemPhase({ status: 'pending', retry_at: 2000 }, 1000), BACKED_OFF);
  assert.equal(itemPhase({ status: 'pending', retry_at: 1000 }, 1000), ITEM_STATUS.PENDING);
  assert.equal(itemPhase({ status: 'uncertain', retry_at: 0 }, 1000), ITEM_STATUS.UNCERTAIN);
  assert.throws(() => itemPhase({ status: 'bogus', retry_at: 0 }, 0), /Unknown item status/);
});

test('run-result vocabulary keeps the exact strings the Worker cron reads', () => {
  assert.deepEqual(Object.values(RUN_STATUS).sort(),
    ['already-checked', 'baseline', 'complete', 'needs-review', 'outside-window', 'pending', 'rate-limited']);
  assert.deepEqual(runResult(RUN_STATUS.NEEDS_REVIEW, { uncertain: 1 }), { status: 'needs-review', uncertain: 1 });
  assert.throws(() => runResult('rate_limited'), /Unknown run status/);
});

test('invalid status/message_id combinations cannot be stored', () => {
  const s = storage(); new ReminderEngine(s);
  const insert = (st, mid) => s.sql.exec('INSERT INTO items (id,kind,url,status,message_id) VALUES (?,?,?,?,?)',
    `shorts:${st}${mid ? 'm' : ''}`, 'shorts', 'https://www.youtube.com/shorts/x', st, mid);
  assert.throws(() => insert('bogus', null), /CHECK/);
  assert.throws(() => insert('sent', null), /CHECK/);
  assert.throws(() => insert('pending', '123'), /CHECK/);
  assert.throws(() => insert('uncertain', '123'), /CHECK/);
  assert.doesNotThrow(() => insert('sent', '123'));
  assert.doesNotThrow(() => insert('resolved', null)); s.db.close();
});

test('transition refuses to move a row that is not in the expected state', () => {
  const s = storage(), e = new ReminderEngine(s);
  s.sql.exec("INSERT INTO items (id,kind,url,status) VALUES ('shorts:a','shorts','u','baseline')");
  assert.throws(() => e.transition('shorts:a', 'pending', 'sending'), /was not pending/);
  assert.throws(() => e.transition('shorts:a', 'baseline', 'pending'), /Invalid item transition/);
  assert.equal(status(s, 'shorts:a'), 'baseline'); s.db.close();
});

test('regression: a backed-off item is skipped instead of blocking later deliverable items', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e); let time = 1000; const sent = [];
  const first = await e.run(config, 'second', { snapshot: snapshot([item('head'), item('tail1'), item('tail2')]), now: () => time,
    request: async () => Response.json({ retry_after: 60 }, { status: 429 }) });
  assert.equal(first.status, 'rate-limited'); assert.equal(rows(s).find(r => r.id === 'shorts:head').retry_at, 61000);
  const deliver = async (url, init) => { sent.push(JSON.parse(init.body).content); return success(String(100 + sent.length)); };
  time = 2000;
  const second = await e.run(config, 'second', { now: () => time, request: deliver, snapshot: () => { throw new Error('Unexpected rescan'); } });
  assert.deepEqual(second, { status: 'rate-limited', delivered: 2 });
  assert.deepEqual(sent, [item('tail1'), item('tail2')].map(i => `New content:\n<${i.url}>`));
  assert.equal(status(s, 'shorts:head'), 'pending'); assert.notEqual(e.get('completed_slot'), 'second');
  time = 61000;
  assert.deepEqual(await e.run(config, 'second', { now: () => time, request: deliver }), { status: 'complete', delivered: 1, uncertain: 0 });
  assert.equal(sent.length, 3); s.db.close();
});

test('regression: an operator "delivered" review resolves an uncertain item without resending it', async () => {
  const s = storage(); let e = new ReminderEngine(s); await baseline(e);
  assert.equal((await makeUncertain(e)).status, 'needs-review');
  let calls = 0; const request = async () => { calls++; return success(); };
  assert.equal((await e.run(config, 'third', { snapshot: snapshot([item('new')]), request })).status, 'needs-review');
  e = new ReminderEngine(s);
  const result = await e.run(reviewed('shorts:new=delivered'), 'fourth', { snapshot: snapshot([item('new')]), request });
  assert.deepEqual(result, { status: 'complete', delivered: 0, uncertain: 0 });
  assert.equal(status(s, 'shorts:new'), 'resolved'); assert.equal(calls, 0);
  assert.equal((await e.run(reviewed('shorts:new=retry'), 'fifth', { snapshot: snapshot([item('new')]), request })).status, 'complete');
  assert.equal(calls, 0); s.db.close();
});

test('regression: an operator "retry" review re-sends exactly once, even if the setting is left in place', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e); await makeUncertain(e);
  let calls = 0; const retry = reviewed('shorts:new=retry');
  assert.equal((await e.run(retry, 'third', { snapshot: snapshot([item('new')]), request: async () => { calls++; throw new Error('timeout'); } })).status, 'needs-review');
  assert.equal(calls, 1); assert.equal(status(s, 'shorts:new'), 'uncertain');
  assert.equal((await e.run(retry, 'fourth', { snapshot: snapshot([item('new')]), request: async () => { calls++; return success(); } })).status, 'needs-review');
  assert.equal(calls, 1, 'a stale retry entry must not resend a second time');
  assert.equal((await e.run(reviewed('shorts:new=delivered'), 'fifth', { snapshot: snapshot([item('new')]), request: async () => { calls++; return success(); } })).status, 'complete');
  assert.equal(calls, 1); s.db.close();
});

test('retry review of a confirmed-missing item delivers it and leaves other items alone', async () => {
  const s = storage(), e = new ReminderEngine(s); await baseline(e); await makeUncertain(e);
  const bodies = [];
  const result = await e.run(reviewed('shorts:new=retry,shorts:old=delivered,posts:Ugunknown=retry'), 'third', {
    snapshot: snapshot([item('new')]), request: async (url, init) => { bodies.push(JSON.parse(init.body)); return success('555'); } });
  assert.deepEqual(result, { status: 'complete', delivered: 1, uncertain: 0 });
  assert.equal(bodies.length, 1); assert.equal(rows(s).find(r => r.id === 'shorts:new').message_id, '555');
  assert.equal(status(s, 'shorts:old'), 'baseline'); s.db.close();
});

test('old-format v1 table (original CHECK) migrates every row to the right state in delivery order', async () => {
  const s = storage();
  s.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('baseline','pending','sending','sent','uncertain')),
      message_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0, image_url TEXT
    );
    INSERT INTO settings VALUES ('channel','${CHANNEL}'),('destination','https://discord.com/api/webhooks/123456789012345678'),
      ('completed_slot','old'),('scanned_slot','old');
    INSERT INTO items VALUES ('shorts:base','shorts','https://www.youtube.com/shorts/base','baseline',NULL,0,NULL);
    INSERT INTO items VALUES ('shorts:sent','shorts','https://www.youtube.com/shorts/sent','sent','123456789012345678',0,NULL);
    INSERT INTO items VALUES ('posts:unsure','posts','https://www.youtube.com/post/unsure','uncertain',NULL,0,NULL);
    INSERT INTO items VALUES ('shorts:mid','shorts','https://www.youtube.com/shorts/mid','sending',NULL,0,NULL);
    INSERT INTO items VALUES ('posts:wait','posts','https://www.youtube.com/post/wait','pending',NULL,999999999,'https://yt3.ggpht.com/w');
    INSERT INTO items VALUES ('shorts:due','shorts','https://www.youtube.com/shorts/due','pending',NULL,0,NULL);`);
  const before = rows(s).map(r => [r.rowid, r.id]);
  const e = new ReminderEngine(s);
  assert.deepEqual(rows(s).map(r => [r.rowid, r.id]), before);
  assert.deepEqual(rows(s).map(r => [r.id, r.status]), [['shorts:base', 'baseline'], ['shorts:sent', 'sent'],
    ['posts:unsure', 'uncertain'], ['shorts:mid', 'uncertain'], ['posts:wait', 'pending'], ['shorts:due', 'pending']]);
  const wait = rows(s).find(r => r.id === 'posts:wait');
  assert.equal(wait.retry_at, 999999999); assert.equal(wait.image_url, 'https://yt3.ggpht.com/w');
  assert.equal(rows(s)[1].message_id, '123456789012345678');
  assert.throws(() => s.sql.exec("UPDATE items SET status='bogus' WHERE id='shorts:due'"), /CHECK/);
  const calls = [];
  const result = await e.run(config, 'new', { snapshot: snapshot([]), now: () => 1000,
    request: async (url, init) => { calls.push(JSON.parse(init.body).embeds[0].url); return success(); } });
  assert.deepEqual(calls, ['https://www.youtube.com/shorts/due']);
  assert.deepEqual(result, { status: 'rate-limited', delivered: 1 });
  assert.equal(e.get('items_schema'), '2');
  const exec = s.sql.exec; let rebuilt = false;
  s.sql.exec = (query, ...params) => { if (query.includes('DROP TABLE')) rebuilt = true; return exec(query, ...params); };
  new ReminderEngine(s); assert.equal(rebuilt, false, 'the rebuild runs only once'); assert.equal(rows(s).length, 6); s.db.close();
});

test('legacy rows without a CHECK constraint: unknown/contradictory -> needs-review, sent without an ID stays delivered', async () => {
  const s = storage();
  s.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE items (id TEXT PRIMARY KEY,kind TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,retry_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO settings VALUES ('channel','${CHANNEL}'),('destination','https://discord.com/api/webhooks/123456789012345678');
    INSERT INTO items VALUES ('shorts:weird','shorts','https://www.youtube.com/shorts/weird','delivering',NULL,0);
    INSERT INTO items VALUES ('shorts:confirmed','shorts','https://www.youtube.com/shorts/confirmed','pending','123456789012345678',0);
    INSERT INTO items VALUES ('shorts:noid','shorts','https://www.youtube.com/shorts/noid','sent',NULL,0);`);
  const e = new ReminderEngine(s);
  assert.deepEqual(rows(s).map(r => [r.id, r.status, r.message_id]), [['shorts:weird', 'uncertain', null],
    ['shorts:confirmed', 'uncertain', null], ['shorts:noid', 'resolved', null]]);
  let calls = 0;
  const result = await e.run(config, 'next', { snapshot: snapshot([]), request: async () => { calls++; return success(); } });
  assert.equal(calls, 0, 'unknown legacy rows are never auto-sent');
  assert.deepEqual(result, { status: 'needs-review', delivered: 0, uncertain: 2 }); s.db.close();
});
