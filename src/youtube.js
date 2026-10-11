const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9'
};
const MAX_PAGES = 100;
const MAX_BYTES = 4 * 1024 * 1024;

// Parse JSON or YouTube's escaped string form without executing page JavaScript.
export function scriptValue(html, pattern) {
  const match = pattern.exec(html);
  if (!match) throw new Error('YouTube page data is missing (blocked page or changed layout)');
  let i = match.index + match[0].length;
  while (/\s/.test(html[i] || '') && i < html.length) i++;
  const start = i;
  if (html[i] === '"' || html[i] === "'") {
    const quote = html[i++];
    let text = '';
    for (; i < html.length; i++) {
      const char = html[i];
      if (char === quote) return JSON.parse(text);
      if (char !== '\\') { text += char; continue; }
      const escape = html[++i];
      if (escape === 'x' || escape === 'u') {
        const length = escape === 'x' ? 2 : 4;
        const hex = html.slice(i + 1, i + 1 + length);
        if (!new RegExp(`^[a-fA-F0-9]{${length}}$`).test(hex)) throw new Error('Invalid page escape');
        text += String.fromCharCode(parseInt(hex, 16));
        i += length;
      } else {
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (!(escape in escapes) && !['\\', '/', '"', "'"].includes(escape)) throw new Error('Unsupported page escape');
        text += escapes[escape] ?? escape;
      }
    }
  } else if (html[i] === '{') {
    let depth = 0, quoted = false, escaped = false;
    for (; i < html.length; i++) {
      const char = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('Invalid or truncated YouTube page data');
}

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (visitor(node) === false) return;
  for (const child of Object.values(node)) walk(child, visitor);
}

function imageUrl(thumbnails = []) {
  if (!Array.isArray(thumbnails)) return null;
  return [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0)).map(thumbnail => {
    try {
      const url = new URL(thumbnail.url, 'https://www.youtube.com');
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && url.href.length <= 2048 &&
          ['ytimg.com', 'ggpht.com', 'googleusercontent.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return url.href;
    } catch {}
    return null;
  }).find(Boolean) || null;
}

export function parsePage(root, kind) {
  const items = new Map(), continuations = new Set();
  let empty = false;
  walk(root, node => {
    if (node.backstagePostThreadRenderer) {
      const post = node.backstagePostThreadRenderer.post;
      if (!post?.backstagePostRenderer) throw new Error('Unrecognized Community post renderer');
      const parsed = parsePage(post, kind);
      for (const item of parsed.items) items.set(item.id, item);
      return false;
    }
    if (node.backstagePostRenderer) {
      if (kind !== 'posts') return false;
      const post = node.backstagePostRenderer;
      if (typeof post.postId !== 'string' || !/^Ug[\w-]{10,}$/.test(post.postId)) throw new Error('Invalid Community post ID');
      let image = null;
      walk(post.backstageAttachment, attachment => {
        if (attachment.backstageImageRenderer && !image) image = imageUrl(attachment.backstageImageRenderer.image?.thumbnails);
      });
      items.set(post.postId, { id: post.postId, kind, url: `https://www.youtube.com/post/${post.postId}`, image });
      return false; // Attached videos, polls, and comments are not separate announcements.
    }
    const short = node.shortsLockupViewModel || node.reelItemRenderer || node.videoRenderer || node.gridVideoRenderer;
    if (short) {
      if (kind !== 'shorts') return false;
      let id = short.videoId;
      walk(short, part => { if (part.reelWatchEndpoint?.videoId) id = part.reelWatchEndpoint.videoId; });
      if (!id && short.onTap?.innertubeCommand?.watchEndpoint) id = short.onTap.innertubeCommand.watchEndpoint.videoId;
      if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) throw new Error('Invalid Short ID');
      items.set(id, { id, kind, url: `https://www.youtube.com/shorts/${id}`, image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
      return false;
    }
    if (node.continuationItemRenderer) {
      walk(node.continuationItemRenderer, part => {
        if (part.continuationCommand?.token) continuations.add(part.continuationCommand.token);
      });
      return false;
    }
    if (node.nextContinuationData?.continuation) continuations.add(node.nextContinuationData.continuation);
    if (node.messageRenderer) {
      const message = node.messageRenderer.text;
      const text = message?.simpleText || message?.runs?.map(r => r.text).join('') || '';
      if (/hasn't (posted|uploaded)|no (posts|shorts|videos)|doesn't have any (content|posts|shorts|videos)/i.test(text)) empty = true;
    }
  });
  if (!items.size && !empty) throw new Error('No recognized content; refusing an incomplete snapshot');
  if (continuations.size > 1) throw new Error('Ambiguous YouTube pagination');
  return { items: [...items.values()], continuation: [...continuations][0] || null };
}

async function body(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`YouTube HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('YouTube response exceeded the size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function fetchSource(url, kind, request = fetch) {
  const pageUrl = new URL(url);
  pageUrl.searchParams.set('hl', 'en');
  pageUrl.searchParams.set('gl', 'US');
  const html = await body(await request(pageUrl.href, {
    headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(20000)
  }));
  const data = scriptValue(html, /(?:var\s+ytInitialData|window\["ytInitialData"\]|ytInitialData)\s*=\s*/);
  const cfg = scriptValue(html, /ytcfg\.set\(\s*(?=\{)/);
  const channelId = data.metadata?.channelMetadataRenderer?.externalId;
  if (!/^UC[\w-]{22}$/.test(channelId || '')) throw new Error('YouTube channel identity is missing');
  const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || data.contents?.singleColumnBrowseResultsRenderer?.tabs;
  const tab = tabs?.find(t => t.tabRenderer?.selected)?.tabRenderer;
  const tabUrl = tab?.endpoint?.commandMetadata?.webCommandMetadata?.url;
  if (!tab?.content || typeof tabUrl !== 'string' || !tabUrl.replace(/\/$/, '').endsWith(`/${kind}`)) {
    throw new Error(`YouTube did not return the ${kind} tab`);
  }
  const context = cfg.INNERTUBE_CONTEXT;
  if (!context?.client?.clientVersion || !context.client.clientName) throw new Error('YouTube client context is missing');
  const items = new Map(), tokens = new Set();
  let root = tab.content;
  for (let page = 0; page < MAX_PAGES; page++) {
    const parsed = parsePage(root, kind);
    for (const item of parsed.items) items.set(item.id, item);
    if (!parsed.continuation) return { channelId, items: [...items.values()] };
    if (tokens.has(parsed.continuation)) throw new Error('YouTube repeated a continuation token');
    if (page === MAX_PAGES - 1) throw new Error('YouTube page limit reached; snapshot was not saved');
    tokens.add(parsed.continuation);
    const next = JSON.parse(await body(await request('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, redirect: 'manual',
      signal: AbortSignal.timeout(20000), body: JSON.stringify({ context, continuation: parsed.continuation })
    })));
    const actions = next.onResponseReceivedActions || next.onResponseReceivedEndpoints;
    const append = actions?.find(a => a.appendContinuationItemsAction)?.appendContinuationItemsAction;
    if (append && (!append.continuationItems || append.continuationItems.length === 0)) {
      return { channelId, items: [...items.values()] };
    }
    root = append?.continuationItems || next.continuationContents;
    if (!root) throw new Error('YouTube continuation data is missing');
    if (next.responseContext?.visitorData) context.client.visitorData = next.responseContext.visitorData;
  }
  throw new Error('Incomplete YouTube snapshot');
}

export async function fetchSnapshot(config, request = fetch) {
  const shorts = await fetchSource(config.shorts, 'shorts', request);
  const posts = await fetchSource(config.posts, 'posts', request);
  if (shorts.channelId !== posts.channelId) throw new Error('YouTube resolved the source URLs to different channels');
  return { channelId: shorts.channelId, items: [...shorts.items, ...posts.items] };
}
