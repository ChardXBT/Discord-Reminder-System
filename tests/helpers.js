import { DatabaseSync } from 'node:sqlite';

export const CHANNEL = `UC${'a'.repeat(22)}`;
export const OTHER_CHANNEL = `UC${'b'.repeat(22)}`;
export const ENV = {
  SHORTS_URL: 'https://www.youtube.com/@example/shorts', POSTS_URL: 'https://www.youtube.com/@example/posts',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/test-token',
  TIMEZONE: 'Europe/London', LOCAL_TIMES: '09:00,17:00', WINDOW_MINUTES: '30'
};
export function storage(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  return { db, sql: { exec(query, ...params) {
    if (query.includes('CREATE TABLE')) { db.exec(query); return []; }
    return db.prepare(query).all(...params);
  } }, transactionSync(callback) {
    db.exec('BEGIN');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }, async sync() {} };
}
export function short(id = 'abcDEF_1234') {
  return { richItemRenderer: { content: { shortsLockupViewModel: {
    onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } }
  } } } };
}
export function post(id = 'Ugabcdefghijklmnop', attachment) {
  return { backstagePostThreadRenderer: { post: { backstagePostRenderer: {
    postId: id, contentText: { runs: [{ text: 'Example post' }] },
    ...(attachment ? { backstageAttachment: attachment } : {})
  } } } };
}
export function continuation(token) {
  return { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } };
}
export function page(kind, items, { channelId = CHANNEL, singleColumn = false, token } = {}) {
  return { metadata: { channelMetadataRenderer: { externalId: channelId } },
    contents: { [singleColumn ? 'singleColumnBrowseResultsRenderer' : 'twoColumnBrowseResultsRenderer']: {
      tabs: [{ tabRenderer: { selected: false, content: short('unrelated01') } },
        { tabRenderer: { selected: true, endpoint: { commandMetadata: { webCommandMetadata: { url: `/@example/${kind}` } } },
          content: { sectionListRenderer: { contents: [...items, ...(token ? [continuation(token)] : [])] } }
        } }]
    } } };
}
export function html(data, { escaped = false } = {}) {
  const cfg = { INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0', hl: 'en' } } };
  const raw = JSON.stringify(data);
  const value = escaped ? `'${[...raw].map(c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}'` : raw;
  return `<script>ytcfg.set("EMERGENCY_BASE_URL", "/");ytcfg.set(${JSON.stringify(cfg)});</script><script>var ytInitialData = ${value};</script>`;
}
export function item(id, kind = 'shorts') {
  return { id, kind, url: `https://www.youtube.com/${kind === 'shorts' ? 'shorts' : 'post'}/${id}` };
}
export function snapshot(items, channelId = CHANNEL) { return async () => ({ channelId, items }); }
export function success(id = '987654321012345678') { return Response.json({ id }); }
