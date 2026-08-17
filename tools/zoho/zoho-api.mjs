// Minimal Zoho Mail REST client.
//
// Zoho runs separate data centres and every host is DC-specific: a token minted
// on accounts.zoho.in is rejected by mail.zoho.com. `dc` threads through both.

const DCS = {
  com: { accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com' },
  in: { accounts: 'https://accounts.zoho.in', mail: 'https://mail.zoho.in' },
  eu: { accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu' },
  au: { accounts: 'https://accounts.zoho.com.au', mail: 'https://mail.zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', mail: 'https://mail.zoho.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', mail: 'https://mail.zohocloud.ca' },
};

export function hosts(dc = 'com') {
  const h = DCS[dc];
  if (!h) throw new Error(`unknown Zoho data centre "${dc}" (expected one of: ${Object.keys(DCS).join(', ')})`);
  return h;
}

export const SCOPES = 'ZohoMail.accounts.READ,ZohoMail.messages.READ';

async function token(dc, params) {
  const res = await fetch(`${hosts(dc).accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  // Zoho answers OAuth failures with HTTP 200 and an {error} body.
  if (!res.ok || body.error) {
    throw new Error(`Zoho OAuth failed (${res.status}): ${body.error || JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

/** Exchange a Self Client grant code (valid ~10 min, single use) for a refresh token. */
export function exchangeCode({ dc, clientId, clientSecret, code }) {
  return token(dc, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });
}

/** Refresh tokens do not expire unless revoked; access tokens last ~1h. */
export function accessToken({ dc, clientId, clientSecret, refreshToken }) {
  return token(dc, {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

export function client({ dc = 'com', accessToken: at }) {
  const base = `${hosts(dc).mail}/api`;

  async function get(path, params = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${at}`, Accept: 'application/json' },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Zoho ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = body?.data?.errorCode || body?.data?.moreInfo || body?.status?.description || res.statusText;
      throw new Error(`Zoho ${path} failed (${res.status}): ${msg}`);
    }
    return body;
  }

  return {
    get,
    accounts: () => get('/accounts'),
    folders: (accountId) => get(`/accounts/${accountId}/folders`),
    /** One page of message metadata. Zoho caps `limit` at 200 and `start` is 1-based. */
    messages: (accountId, { folderId, start = 1, limit = 200 } = {}) =>
      get(`/accounts/${accountId}/messages/view`, { folderId, start, limit }),
    /** Full body of one message. Separate call per message — Zoho has no bulk body endpoint. */
    content: (accountId, folderId, messageId) =>
      get(`/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`),
  };
}

/** Bounded-concurrency map — Zoho throttles aggressively on parallel body fetches. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { __error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Zoho returns HTML bodies; the analysis layer wants readable plain text. */
export function htmlToText(html, { maxChars = 4000 } = {}) {
  if (!html) return '';
  let s = String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, arr) => line || (arr[i - 1] || '').length > 0)
    .join('\n')
    .trim();
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n…[truncated]` : s;
}

/**
 * Drop quoted reply chains and signature blocks so the analysis reads what this
 * message actually says, not the thread history repeated in every reply.
 */
export function stripQuotedTail(text) {
  if (!text) return '';
  const markers = [
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^On .{4,80}\bwrote:\s*$/im,
    /^From:\s.+$/im,
    /^_{5,}$/im,
    /^-{2,}\s*Forwarded message\s*-{2,}/im,
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cut && m.index > 40) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

/** Walk `messages` pages until the folder runs dry, a cap is hit, or messages predate `since`. */
export async function drainFolder(api, accountId, folderId, { max = 600, since = 0 } = {}) {
  const out = [];
  for (let start = 1; out.length < max; start += 200) {
    const page = await api.messages(accountId, { folderId, start, limit: 200 });
    const rows = Array.isArray(page?.data) ? page.data : [];
    if (rows.length === 0) break;
    out.push(...rows);
    // Zoho returns newest-first, so one page fully older than the window ends the walk.
    const oldest = Math.min(...rows.map(receivedAt).filter(Number.isFinite));
    if (Number.isFinite(oldest) && oldest < since) break;
    if (rows.length < 200) break;
  }
  return out.slice(0, max);
}

/**
 * Field names drift across Zoho Mail API versions, so read every message
 * attribute through a fallback chain rather than a single key.
 */
export function receivedAt(m) {
  const raw = m?.receivedTime ?? m?.sentDateInGMT ?? m?.time ?? m?.date;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : NaN;
}

export function isUnread(m) {
  if (typeof m?.isRead === 'boolean') return !m.isRead;
  if (m?.isUnread === true || m?.isUnread === 'true') return true;
  // Legacy encoding: status "0" = unread, "1" = read.
  if (m?.status !== undefined) return String(m.status) === '0';
  return false;
}

export function addressOf(raw) {
  if (!raw) return '';
  const s = String(raw);
  const angled = s.match(/<([^>]+)>/);
  const addr = (angled ? angled[1] : s).trim().toLowerCase();
  return addr.includes('@') ? addr : '';
}

export function displayNameOf(raw, fallbackAddress = '') {
  const s = String(raw || '').trim();
  const named = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  const name = named ? named[1].trim() : '';
  if (name && !name.includes('@')) return name;
  const addr = addressOf(s) || fallbackAddress;
  if (!addr) return s || 'unknown';
  // "r.mehta" / "r_mehta" -> "R Mehta"
  return addr
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** All recipients on a message, across the header fields Zoho may populate. */
export function recipientsOf(m) {
  return [m?.toAddress, m?.ccAddress, m?.bccAddress]
    .filter(Boolean)
    .flatMap((f) => String(f).split(/[,;]/))
    .map(addressOf)
    .filter(Boolean);
}

/** Thread key: subject stripped of reply/forward prefixes, in any of Zoho's supported locales. */
export function normalizeSubject(subject) {
  let s = String(subject || '').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*(re|fw|fwd|aw|antw|rif|res|sv|vs|ref)\s*(\[\d+\])?\s*:\s*/i, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
