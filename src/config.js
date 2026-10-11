export function readConfig(env) {
  const source = (value, tab) => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`Invalid ${tab} URL`); }
    if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
        url.port || url.username || url.password || url.search || url.hash ||
        !new RegExp(`^/(@[^/]+|channel/UC[\\w-]{22})/${tab}/?$`).test(url.pathname)) {
      throw new Error(`Expected an HTTPS YouTube channel /${tab} URL`);
    }
    url.hostname = 'www.youtube.com';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url;
  };
  const shorts = source(env.SHORTS_URL, 'shorts');
  const posts = source(env.POSTS_URL, 'posts');
  if (shorts.pathname.replace(/\/shorts$/, '').toLowerCase() !==
      posts.pathname.replace(/\/posts$/, '').toLowerCase()) {
    throw new Error('Both source URLs must use the same channel path');
  }
  let webhook;
  try { webhook = new URL(env.DISCORD_WEBHOOK_URL); } catch { throw new Error('Invalid Discord webhook secret'); }
  if (webhook.protocol !== 'https:' || webhook.hostname !== 'discord.com' || webhook.port ||
      webhook.username || webhook.password || webhook.search || webhook.hash ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(webhook.pathname)) {
    throw new Error('Expected a standard discord.com HTTPS webhook URL');
  }
  webhook.searchParams.set('wait', 'true');
  const timezone = env.TIMEZONE || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new Error('Invalid TIMEZONE'); }
  const times = (env.LOCAL_TIMES || '').split(',').map(t => t.trim()).filter(Boolean);
  if (times.some(t => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) || new Set(times).size !== times.length) {
    throw new Error('LOCAL_TIMES must contain unique HH:MM times');
  }
  const windowMinutes = Number(env.WINDOW_MINUTES || '30');
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 120) {
    throw new Error('WINDOW_MINUTES must be an integer from 1 to 120');
  }
  return { shorts: shorts.href, posts: posts.href, webhook: webhook.href, timezone, times, windowMinutes };
}

export function scheduleSlot(config, timestamp) {
  if (!Number.isFinite(timestamp)) throw new Error('Invalid scheduled timestamp');
  if (!config.times.length) return `cron:${Math.floor(timestamp / 60000)}`;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(timestamp).map(p => [p.type, p.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const candidates = config.times.map(t => {
    const [h, m] = t.split(':').map(Number);
    const target = h * 60 + m;
    return { time: t, target, elapsed: (minute - target + 1440) % 1440 };
  }).filter(t => t.elapsed < config.windowMinutes).sort((a, b) => a.elapsed - b.elapsed);
  const target = candidates[0];
  if (!target) return null;
  let date = `${parts.year}-${parts.month}-${parts.day}`;
  if (minute < target.target) {
    date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 86400000).toISOString().slice(0, 10);
  }
  return `${config.timezone}:${date}:${target.time}`;
}
