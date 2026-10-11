import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ENV, html, page, short, post, success } from './helpers.js';

const bundle = fs.readFileSync(new URL('../dist/worker.js', import.meta.url), 'utf8');
const bridge = `
  import worker, { Reminder } from './worker.js';
  export { Reminder };
  export default { async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/tick') return worker.fetch(request, env);
    await worker.scheduled({ scheduledTime: Number(url.searchParams.get('time')) }, env);
    return new Response('ok');
  } };
`;
function runtime(bindings, folder, outboundService) {
  return new Miniflare(convertV4MiniflareOptions({ name: 'reminder-runtime-test', compatibilityDate: '2026-10-01', cf: false,
    modules: [{ type: 'ESModule', path: 'bridge.js', contents: bridge }, { type: 'ESModule', path: 'worker.js', contents: bundle }],
    bindings, durableObjects: { REMINDER: { className: 'Reminder', useSQLite: true } },
    resourcePersistencePath: folder, outboundService }));
}

test('actual Worker/SQLite Durable Object detects new content and retains state after restart', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-runtime-'));
  let phase = 0, deliveries = 0, mf;
  const outbound = async request => {
    const url = new URL(request.url);
    if (url.hostname === 'discord.com') {
      deliveries++;
      const body = await request.json();
      assert.match(body.content, /^New content:\n<https:\/\/www\.youtube\.com\/(shorts|post)\//);
      assert.equal(body.embeds.length, 1);
      assert.equal(body.flags, undefined);
      return success(String(1000 + deliveries));
    }
    const kind = url.pathname.endsWith('/shorts') ? 'shorts' : 'posts';
    const items = kind === 'shorts' ? [short(), ...(phase ? [short('xyzDEF_5678')] : [])]
      : [post(), ...(phase ? [post('Ugnewpost_________')] : [])];
    return new Response(html(page(kind, items)));
  };
  try {
    mf = runtime({ ...ENV, LOCAL_TIMES: '' }, folder, outbound);
    assert.equal((await mf.dispatchFetch('http://local.test/')).status, 404);
    const first = await mf.dispatchFetch('http://local.test/tick?time=60000');
    assert.equal(first.status, 200, await first.text());
    assert.equal(deliveries, 0);
    phase = 1;
    assert.equal((await mf.dispatchFetch('http://local.test/tick?time=120000')).status, 200);
    assert.equal(deliveries, 2);
    await mf.dispatchFetch('http://local.test/tick?time=120000'); assert.equal(deliveries, 2);
    await mf.dispose(); mf = runtime({ ...ENV, LOCAL_TIMES: '' }, folder, outbound);
    assert.equal((await mf.dispatchFetch('http://local.test/tick?time=180000')).status, 200);
    assert.equal(deliveries, 2);
  } finally { if (mf) await mf.dispose(); fs.rmSync(folder, { recursive: true }); }
});

test('scheduled Worker makes zero outbound calls outside a local window', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-runtime-'));
  const target = new Date(Date.now() + 3600000).toISOString().slice(11, 16);
  let calls = 0;
  const mf = runtime({ ...ENV, TIMEZONE: 'UTC', LOCAL_TIMES: target }, folder, async () => { calls++; throw new Error('Unexpected fetch'); });
  try {
    assert.equal((await mf.dispatchFetch(`http://local.test/tick?time=${Date.now()}`)).status, 200);
    assert.equal(calls, 0);
  } finally { await mf.dispose(); fs.rmSync(folder, { recursive: true }); }
});
