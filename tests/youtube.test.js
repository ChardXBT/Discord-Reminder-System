import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptValue, parsePage, fetchSource, fetchSnapshot } from '../src/youtube.js';
import { CHANNEL, OTHER_CHANNEL, ENV, short, post, continuation, page, html } from './helpers.js';
import { readConfig } from '../src/config.js';

test('parses literal and escaped JSON without executing page scripts', () => {
  const data = { text: 'braces } and quotes "' };
  for (const escaped of [false, true]) assert.deepEqual(scriptValue(html(data, { escaped }), /var ytInitialData = /), data);
  assert.deepEqual(scriptValue('value = "{\\\"hello\\\":\\\"world\\\"}";', /value = /), { hello: 'world' });
  for (const input of ['value = eval("{}")', 'value = {', "value = '\\xQQ'", 'no data']) assert.throws(() => scriptValue(input, /value = /));
});
test('Shorts renderers become unique direct links', () => {
  const p = parsePage([short(), short(), { reelItemRenderer: { videoId: 'xyzDEF_5678' } }, { videoRenderer: { videoId: '01234567890' } }], 'shorts');
  assert.deepEqual(p.items.map(i => i.url), ['https://www.youtube.com/shorts/abcDEF_1234', 'https://www.youtube.com/shorts/xyzDEF_5678', 'https://www.youtube.com/shorts/01234567890']);
});
test('text, image, poll and video attachments yield only Community links', () => {
  const p = parsePage([post('Ugtext____________'), post('Ugimage___________', { backstageImageRenderer: {} }),
    post('Ugpoll____________', { pollRenderer: { choices: [{ text: 'A' }] } }),
    post('Ugvideo___________', { videoRenderer: { videoId: 'abcDEF_1234' } })], 'posts');
  assert.equal(p.items.length, 4);
  assert.ok(p.items.every(i => i.url.startsWith('https://www.youtube.com/post/Ug')));
});

test('post embeds use the largest safe image from the first image attachment', () => {
  const image = thumbnails => ({ backstageImageRenderer: { image: { thumbnails } } });
  const p = parsePage([post('Ugimage___________', image([
    { url: 'https://yt3.ggpht.com/small', width: 100 }, { url: 'https://yt3.ggpht.com/large', width: 680 },
    { url: 'https://ggpht.com.evil.test/image', width: 9999 }, { url: 'http://yt3.ggpht.com/insecure', width: 8888 }
  ])), post('Ugmultiple________', { postMultiImageRenderer: { images: [image([{ url: '//yt3.ggpht.com/first' }]), image([{ url: 'https://yt3.ggpht.com/second' }])] } }),
  post('Ugtext____________'), post('Uginvalid_________', image([{ url: 'javascript:alert(1)' }, { url: 'https://user:pass@yt3.ggpht.com/image' }])),
  post('Ugmalformed_______', image({ changed: true }))], 'posts');
  assert.deepEqual(p.items.map(i => i.image), ['https://yt3.ggpht.com/large', 'https://yt3.ggpht.com/first', null, null, null]);
  assert.equal(parsePage([short()], 'shorts').items[0].image, 'https://i.ytimg.com/vi/abcDEF_1234/hqdefault.jpg');
});
test('comments, refresh tokens and sort commands are not page continuations', () => {
  const p = post(); p.backstagePostThreadRenderer.comments = continuation('comments');
  const parsed = parsePage({ items: [p, continuation('next')], continuations: [{ reloadContinuationData: { continuation: 'refresh' } }],
    chipViewModel: { tapCommand: { continuationCommand: { token: 'sort' } } } }, 'posts');
  assert.equal(parsed.continuation, 'next'); assert.equal(parsed.items.length, 1);
});
test('recognizes explicit empty feeds, rejects blocked/changed/malformed feeds', () => {
  assert.deepEqual(parsePage({ messageRenderer: { text: { runs: [{ text: "This channel hasn't posted yet" }] } } }, 'posts').items, []);
  for (const [root, kind] of [[{ messageRenderer: { text: { simpleText: 'Sign in' } } }, 'posts'],
    [{ newRenderer: { postId: 'Ugabcdefghijklmnop' } }, 'posts'], [[short('bad')], 'shorts'], [[post('bad')], 'posts'],
    [[post(), continuation('a'), continuation('b')], 'posts']]) assert.throws(() => parsePage(root, kind));
});
test('selected mobile tab, escaped data and pagination work together', async () => {
  const calls = [];
  const result = await fetchSource(ENV.SHORTS_URL, 'shorts', async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response(html(page('shorts', [short()], { token: 'page2', singleColumn: true }), { escaped: true }))
      : Response.json({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [short('xyzDEF_5678')] } }] });
  });
  assert.equal(result.channelId, CHANNEL); assert.equal(result.items.length, 2); assert.equal(calls.length, 2);
  assert.equal(calls[0].init.redirect, 'manual'); assert.equal(JSON.parse(calls[1].init.body).continuation, 'page2');
});
test('final append action can omit items', async () => {
  let calls = 0;
  const result = await fetchSource(ENV.POSTS_URL, 'posts', async () => ++calls === 1
    ? new Response(html(page('posts', [post()], { token: 'last' })))
    : Response.json({ onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { targetId: 'backstage-item-section' } }] }));
  assert.equal(result.items.length, 1);
});
test('repeated tokens and missing continuation envelopes fail', async () => {
  for (const broken of [{ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [post(), continuation('same')] } }] }, { responseContext: {} }]) {
    let calls = 0;
    await assert.rejects(fetchSource(ENV.POSTS_URL, 'posts', async () => ++calls === 1 ? new Response(html(page('posts', [post()], { token: 'same' }))) : Response.json(broken)));
  }
});
test('HTTP errors, consent, wrong tabs and oversized pages fail closed', async () => {
  const wrong = page('shorts', [short()]); wrong.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.selected = false;
  for (const r of [new Response('failed', { status: 503 }), new Response('<html>Consent</html>'), new Response(html(wrong)), new Response('x'.repeat(4 * 1024 * 1024 + 1))])
    await assert.rejects(fetchSource(ENV.SHORTS_URL, 'shorts', async () => r));
});
test('both tabs must resolve to the same real channel ID', async () => {
  await assert.rejects(fetchSnapshot(readConfig(ENV), async url => url.includes('/shorts') ? new Response(html(page('shorts', [short()])))
    : new Response(html(page('posts', [post()], { channelId: OTHER_CHANNEL })))), /different channels/);
});
test('runaway pagination stops without returning a partial snapshot', async () => {
  let calls = 0;
  await assert.rejects(fetchSource(ENV.POSTS_URL, 'posts', async () => ++calls === 1
    ? new Response(html(page('posts', [post()], { token: 't1' })))
    : Response.json({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [post(), continuation(`t${calls}`)] } }] })), /page limit/);
  assert.equal(calls, 100);
});
