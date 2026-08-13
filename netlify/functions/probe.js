'use strict';

/**
 * Endpoint discovery, runnable from a phone browser.
 *
 * Carrier-native adapters need the carrier's real status and POD endpoints.
 * Finding those normally means opening DevTools on a desktop. This endpoint
 * does the equivalent from the deployed site: open it in Safari and it will
 *
 *   1. fetch the carrier's tracking page and its JavaScript bundles, and pull
 *      out every URL that looks like a tracking or POD API;
 *   2. try each known candidate endpoint with a real docket number and report
 *      what came back — status, content type, size, and whether the response
 *      actually mentions the docket or looks like an image.
 *
 *   /api/probe?carrier=relogistics&docket=71199373
 *   /api/probe?carrier=delhivery&docket=307744222&format=json
 *
 * Login is required, same as the rest of the API.
 */

const { verifyRequest, cors, json } = require('./lib/auth-jwt');
const { DISCOVERY_PAGES, CANDIDATES, INTERESTING, URL_RE } = require('./lib/candidates');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_MS = Number(process.env.PROBE_TIMEOUT_MS || 6000);
const MAX_BUNDLES = 4;
const STATUS_WORDS = /(delivered|in\s*transit|out for delivery|booked|dispatch|manifest|consignee|undelivered|not found)/i;

async function timedFetch(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

/** Pull candidate API URLs out of a blob of markup or JavaScript. */
function extractUrls(text, base) {
  const found = new Set();
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    let u = (m[1] || m[0]).replace(/^["'`]|["'`]$/g, '');
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.startsWith('/')) {
      try { u = new URL(u, base).toString(); } catch { continue; }
    }
    if (!/^https?:/i.test(u)) continue;
    if (/\.(png|jpe?g|gif|svg|woff2?|ttf|ico|css)(\?|$)/i.test(u)) continue;
    if (!INTERESTING.test(u)) continue;
    found.add(u.slice(0, 300));
  }
  return [...found];
}

async function discover(carrierId) {
  const pages = DISCOVERY_PAGES[carrierId] || [];
  const out = { pages: [], urls: [], bundles: [] };

  for (const page of pages) {
    try {
      const res = await timedFetch(page, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      const html = await res.text();
      out.pages.push({ url: page, status: res.status, bytes: html.length });
      out.urls.push(...extractUrls(html, page));

      // Same-origin scripts often hold the real API paths.
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
        .map((m) => {
          try { return new URL(m[1], page).toString(); } catch { return null; }
        })
        .filter((u) => u && /\.js(\?|$)/i.test(u) && new URL(u).hostname === new URL(page).hostname)
        .slice(0, MAX_BUNDLES);

      for (const js of scripts) {
        try {
          const r = await timedFetch(js, { headers: { 'User-Agent': UA } });
          const body = (await r.text()).slice(0, 600_000);
          const urls = extractUrls(body, page);
          out.bundles.push({ url: js, status: r.status, bytes: body.length, found: urls.length });
          out.urls.push(...urls);
        } catch (e) {
          out.bundles.push({ url: js, error: e.message });
        }
      }
    } catch (e) {
      out.pages.push({ url: page, error: e.message });
    }
  }
  out.urls = [...new Set(out.urls)].sort();
  return out;
}

async function tryCandidates(carrierId, docket) {
  const list = CANDIDATES[carrierId] || [];
  const results = [];
  for (const c of list) {
    const url = c.url.replace(/\{D\}/g, encodeURIComponent(docket));
    try {
      const res = await timedFetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json,text/html,image/*' }
      });
      const ct = res.headers.get('content-type') || '';
      const isImage = /^image\/|pdf/i.test(ct);
      let snippet = '';
      let bytes = 0;
      if (isImage) {
        bytes = (await res.arrayBuffer()).byteLength;
      } else {
        const text = await res.text();
        bytes = text.length;
        snippet = text.replace(/\s+/g, ' ').slice(0, 400);
      }
      results.push({
        kind: c.kind,
        url,
        status: res.status,
        contentType: ct.split(';')[0],
        bytes,
        mentionsDocket: snippet.includes(docket),
        hasStatusWord: STATUS_WORDS.test(snippet),
        looksLikePod: isImage,
        snippet
      });
    } catch (e) {
      results.push({ kind: c.kind, url, error: e.message });
    }
  }
  return results;
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml(carrier, docket, disc, cands) {
  const promising = cands.filter((c) => !c.error && c.status === 200 && (c.mentionsDocket || c.hasStatusWord || c.looksLikePod));
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Probe — ${esc(carrier)}</title>
<style>
body{font:14px/1.45 -apple-system,Segoe UI,Arial;margin:0;padding:16px;background:#f0f4ff;color:#1a1a2e}
h1{font-size:1.1rem;color:#1B3A8F;margin:0 0 4px} h2{font-size:.95rem;color:#1B3A8F;margin:22px 0 8px}
.sub{color:#555e7a;font-size:.85rem;margin-bottom:16px}
.card{background:#fff;border:1px solid #D0D9F0;border-radius:10px;padding:12px;margin-bottom:10px;overflow-wrap:anywhere}
.ok{border-left:4px solid #1a7a3c}.bad{border-left:4px solid #c0392b}.meh{border-left:4px solid #d0d9f0}
.tag{display:inline-block;font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:10px;background:#dce8ff;color:#1B3A8F;margin-right:6px}
.g{background:#e6f4ec;color:#1a7a3c}.r{background:#fdecea;color:#c0392b}
code{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;color:#333}
pre{background:#f6f8fd;padding:8px;border-radius:6px;overflow-x:auto;font-size:.72rem;margin:8px 0 0}
ul{padding-left:18px;margin:6px 0}li{font-size:.78rem;margin-bottom:3px}
textarea{width:100%;height:180px;font-family:ui-monospace,monospace;font-size:.7rem}
</style>
<h1>Endpoint probe — ${esc(carrier)}</h1>
<div class="sub">docket <code>${esc(docket)}</code></div>

<h2>Promising (${promising.length})</h2>
${promising.length ? promising.map((c) => `<div class="card ok">
  <span class="tag ${c.looksLikePod ? 'g' : ''}">${esc(c.kind)}</span>
  <span class="tag g">${c.status}</span><span class="tag">${esc(c.contentType)}</span>
  <span class="tag">${c.bytes} B</span>
  ${c.mentionsDocket ? '<span class="tag g">mentions docket</span>' : ''}
  ${c.hasStatusWord ? '<span class="tag g">status words</span>' : ''}
  ${c.looksLikePod ? '<span class="tag g">image/pdf</span>' : ''}
  <div><code>${esc(c.url)}</code></div>
  ${c.snippet ? `<pre>${esc(c.snippet)}</pre>` : ''}
</div>`).join('') : '<div class="card meh">Nothing matched. The URLs discovered below are the place to look.</div>'}

<h2>All candidates tried (${cands.length})</h2>
${cands.map((c) => `<div class="card ${c.error || c.status >= 400 ? 'bad' : 'meh'}">
  <span class="tag">${esc(c.kind)}</span>
  <span class="tag ${c.error || c.status >= 400 ? 'r' : ''}">${esc(c.error ? 'ERR' : c.status)}</span>
  <div><code>${esc(c.url)}</code></div>
  ${c.error ? `<div><code>${esc(c.error)}</code></div>` : ''}
  ${c.snippet ? `<pre>${esc(c.snippet.slice(0, 200))}</pre>` : ''}
</div>`).join('')}

<h2>URLs found in the carrier's own pages (${disc.urls.length})</h2>
<div class="card"><ul>${disc.urls.map((u) => `<li><code>${esc(u)}</code></li>`).join('') || '<li>none</li>'}</ul></div>

<h2>Pages and bundles scanned</h2>
<div class="card"><ul>
${disc.pages.map((p) => `<li><code>${esc(p.url)}</code> — ${p.error ? esc(p.error) : `${p.status}, ${p.bytes} B`}</li>`).join('')}
${disc.bundles.map((b) => `<li><code>${esc(b.url)}</code> — ${b.error ? esc(b.error) : `${b.status}, ${b.bytes} B, ${b.found} URLs`}</li>`).join('')}
</ul></div>

<h2>Copy this back</h2>
<textarea readonly onclick="this.select()">${esc(JSON.stringify({ carrier, docket, discovered: disc.urls, candidates: cands }, null, 1))}</textarea>
`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (!verifyRequest(event)) {
    // Opened directly in a browser tab there is no Authorization header, so
    // accept the token as a query parameter for this endpoint only.
    const t = (event.queryStringParameters || {}).token;
    if (!t || !verifyRequest({ headers: { authorization: `Bearer ${t}` } })) {
      return json(401, { error: 'Unauthorized — append &token=<your session token>' });
    }
  }

  const { carrier, docket, format } = event.queryStringParameters || {};
  if (!carrier || !docket) {
    return json(400, {
      error: 'carrier and docket required',
      carriers: Object.keys(CANDIDATES),
      example: '/api/probe?carrier=relogistics&docket=71199373'
    });
  }
  if (!CANDIDATES[carrier]) return json(400, { error: `Unknown carrier`, carriers: Object.keys(CANDIDATES) });

  const [disc, cands] = await Promise.all([discover(carrier), tryCandidates(carrier, docket)]);

  if (format === 'json') return json(200, { carrier, docket, discovered: disc, candidates: cands });
  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
    body: renderHtml(carrier, docket, disc, cands)
  };
};
