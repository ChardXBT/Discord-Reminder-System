import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, scheduleSlot } from '../src/config.js';
import { ENV } from './helpers.js';

test('normalizes one channel and sets webhook wait=true', () => {
  const c = readConfig({ ...ENV, SHORTS_URL: 'https://youtube.com/@example/shorts/' });
  assert.equal(c.shorts, ENV.SHORTS_URL);
  assert.equal(new URL(c.webhook).search, '?wait=true');
});
test('rejects untrusted URLs and invalid configuration without exposing the secret', () => {
  for (const change of [
    { SHORTS_URL: 'http://youtube.com/@example/shorts' }, { SHORTS_URL: 'https://youtube.com.evil.test/@example/shorts' },
    { SHORTS_URL: 'https://youtube.com/@example/shorts?x=1' }, { SHORTS_URL: 'https://youtube.com/@example/videos' },
    { SHORTS_URL: 'https://youtube.com:8443/@example/shorts' },
    { POSTS_URL: 'https://youtube.com/@different/posts' }, { DISCORD_WEBHOOK_URL: 'https://evil.test/api/webhooks/123/token' },
    { DISCORD_WEBHOOK_URL: 'https://discord.com:8443/api/webhooks/123/token' },
    { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token?thread_id=1' }, { DISCORD_WEBHOOK_URL: undefined },
    { TIMEZONE: 'not/a-zone' }, { LOCAL_TIMES: '24:00' }, { LOCAL_TIMES: '9:00' }, { LOCAL_TIMES: '09:00,09:00' },
    { WINDOW_MINUTES: '0' }, { WINDOW_MINUTES: '121' }, { WINDOW_MINUTES: '3.5' }
  ]) assert.throws(() => readConfig({ ...ENV, ...change }));
});
test('supports /channel/UC... source URLs', () => {
  const path = `/channel/UC${'a'.repeat(22)}`;
  assert.doesNotThrow(() => readConfig({ ...ENV, SHORTS_URL: `https://youtube.com${path}/shorts`, POSTS_URL: `https://youtube.com${path}/posts` }));
});
test('same wall-clock time works in winter and summer', () => {
  const c = readConfig(ENV);
  assert.match(scheduleSlot(c, Date.parse('2026-01-15T09:00Z')), /2026-01-15:09:00$/);
  assert.match(scheduleSlot(c, Date.parse('2026-07-15T08:00Z')), /2026-07-15:09:00$/);
  assert.equal(scheduleSlot(c, Date.parse('2026-07-15T09:00Z')), null);
});
test('retry window has exact opening and closing boundaries', () => {
  const c = readConfig(ENV), slot = scheduleSlot(c, Date.parse('2026-01-15T09:00Z'));
  assert.equal(scheduleSlot(c, Date.parse('2026-01-15T08:59:59Z')), null);
  assert.equal(scheduleSlot(c, Date.parse('2026-01-15T09:29:59Z')), slot);
  assert.equal(scheduleSlot(c, Date.parse('2026-01-15T09:30Z')), null);
  assert.match(scheduleSlot(c, Date.parse('2026-01-15T17:00Z')), /17:00$/);
});
test('daytime schedules survive both DST transition days', () => {
  const c = readConfig({ ...ENV, TIMEZONE: 'America/New_York' });
  for (const [date, hour] of [['2026-03-07', '14'], ['2026-03-08', '13'], ['2026-10-31', '13'], ['2026-11-01', '14']])
    assert.match(scheduleSlot(c, Date.parse(`${date}T${hour}:00Z`)), /09:00$/);
});
test('fall-back repeated times share a slot', () => {
  const c = readConfig({ ...ENV, TIMEZONE: 'America/New_York', LOCAL_TIMES: '01:15' });
  assert.equal(scheduleSlot(c, Date.parse('2026-11-01T05:15Z')), scheduleSlot(c, Date.parse('2026-11-01T06:15Z')));
});
test('midnight windows use the previous calendar date, including year rollover', () => {
  const c = readConfig({ ...ENV, TIMEZONE: 'UTC', LOCAL_TIMES: '23:50' });
  assert.equal(scheduleSlot(c, Date.parse('2027-01-01T00:10Z')), 'UTC:2026-12-31:23:50');
  assert.equal(scheduleSlot(c, Date.parse('2027-01-01T00:20Z')), null);
});
test('overlapping windows choose the most recent target', () => {
  const c = readConfig({ ...ENV, TIMEZONE: 'UTC', LOCAL_TIMES: '09:00,09:15' });
  assert.match(scheduleSlot(c, Date.parse('2026-01-15T09:20Z')), /09:15$/);
});
test('blank LOCAL_TIMES makes each cron minute eligible', () => {
  assert.equal(scheduleSlot(readConfig({ ...ENV, LOCAL_TIMES: '' }), 120001), 'cron:2');
  assert.throws(() => scheduleSlot(readConfig(ENV), NaN));
});
