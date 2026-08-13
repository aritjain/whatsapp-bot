'use strict';

/**
 * Delhivery — carrier-native integration.
 *
 * Portal: https://www.delhivery.com/track-v2/lr/<LR number>
 *
 * Delhivery carries two identifiers: their own AWB (e.g. 14442810628644) and
 * the client LR number (e.g. 309020803). The Sale Register's DOCKET NO column
 * holds the LR, which is what the /track-v2/lr/ route takes, so the URL is
 * constructible straight from the register.
 *
 * track-v2 is a JavaScript app, so the visible timeline may be rendered
 * client-side. Two routes are tried, in order:
 *   1. state embedded in the HTML (`__NEXT_DATA__` and friends), which
 *      server-rendered React apps ship in the document;
 *   2. JSON API candidates, keyed by LR and by waybill.
 *
 * UNVERIFIED: egress to delhivery.com is blocked from the build environment,
 * so neither route has been confirmed. Both return null rather than guessing,
 * which lets the caller fall through to the aggregator chain.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const { readPayload, findPodUrl } = require('./jsonshape');

const BASE = process.env.DELHIVERY_BASE || 'https://www.delhivery.com';
const pageUrl = (lr) => `${BASE}/track-v2/lr/${encodeURIComponent(lr)}`;

const API_CANDIDATES = [
  `${BASE}/api/track-v2/lr/{D}`,
  `${BASE}/api/tracking/lr/{D}`,
  'https://dlv-api.delhivery.com/v3/unified-tracking?lrnum={D}',
  'https://dlv-api.delhivery.com/v3/unified-tracking?ref={D}',
  'https://dlv-api.delhivery.com/v3/unified-tracking?wbn={D}'
];

/** Script payloads that server-rendered React/Next apps embed in the document. */
const STATE_PATTERNS = [
  /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
  /window\.__NUXT__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
  /self\.__next_f\.push\(\[1,\s*"([\s\S]*?)"\]\)/i
];

function extractState(html) {
  for (const re of STATE_PATTERNS) {
    const m = re.exec(html);
    if (!m) continue;
    let raw = m[1].trim();
    try {
      return JSON.parse(raw);
    } catch (_) {
      // Streaming payloads arrive as escaped strings; try one unescape pass.
      try {
        return JSON.parse(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      } catch (_2) { /* try the next pattern */ }
    }
  }
  return null;
}

/**
 * Last resort: read the rendered timeline out of the markup, e.g.
 * "Out for Delivery | Thu, 13 Aug, 9:49 AM".
 */
function fromMarkup(html) {
  const flat = html.replace(/<[^>]*>/g, '\n');
  const re =
    /(Order Placed|Picked Up|On the Way|In Transit|Out for Delivery|Delivered|Undelivered|Order Delivered|Failed Delivery)\s*\|?\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?,?\s*\d{1,2}\s+\w{3},?\s*[\d:]+\s*(?:AM|PM)?)/gi;
  const events = [];
  let m;
  while ((m = re.exec(flat))) events.push({ date: m[2].trim(), location: '', status: m[1].trim() });
  if (!events.length) return null;

  const latest = events[events.length - 1];
  return {
    success: true,
    currentStatus: latest.status,
    latestDate: latest.date,
    latestLocation: '',
    city: '',
    podUrl: '',
    podAvailable: false,
    isDelivered: /delivered/i.test(latest.status),
    events
  };
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE}/` }
  });
  if (!res.ok) return null;
  const text = await res.text();
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Adapter used by the carrier registry. `lr` is the register's DOCKET NO. */
async function track(lr) {
  const url = pageUrl(lr);

  // 1. Embedded state in the tracking document.
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', Referer: `${BASE}/` } });
    if (res.ok) {
      const html = await res.text();
      const state = extractState(html);
      if (state) {
        const r = readPayload(state);
        if (r) return { ...r, podPageUrl: url };
      }
      const fallback = fromMarkup(html);
      if (fallback) return { ...fallback, podPageUrl: url };
    }
  } catch (_) { /* try the APIs */ }

  // 2. JSON API candidates.
  for (const tpl of API_CANDIDATES) {
    const json = await getJson(tpl.replace(/\{D\}/g, encodeURIComponent(lr)));
    if (!json) continue;
    const r = readPayload(json);
    if (r) return { ...r, podPageUrl: url };
  }

  throw new Error('Delhivery: no usable tracking source');
}

module.exports = { track, pageUrl, extractState, fromMarkup, BASE };
