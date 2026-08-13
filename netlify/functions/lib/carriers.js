'use strict';

const { trackViaProviders } = require('./providers');

/**
 * Carrier registry.
 *
 * Routing is driven by the "CARRIER NAME" column of the Sale Register, not by
 * docket-number prefixes. Each entry declares how that carrier is handled:
 *
 *   mode: 'api'     — we have a working tracking integration (adapter runs)
 *   mode: 'link'    — no integration yet; the UI shows a deep link to the
 *                     carrier's own tracking page
 *   mode: 'offline' — not tracked at all (own delivery fleet / manual dispatch)
 *
 * To promote a carrier from 'link' to 'api': write its adapter below, set
 * mode:'api', and point `adapter` at it. Nothing else needs to change.
 */

// ── Adapter contract ────────────────────────────────────────────────────────
// An adapter is `async (docket, ctx) => TrackResult` where TrackResult is:
//   { success, currentStatus, latestDate, latestLocation, city, podUrl,
//     isDelivered, events: [{ date, location, status }] }
// Throwing is fine — the handler catches and degrades the row to a deep link.

// thedeliverytracker.com is a generic aggregator: the same URL shape works for
// any carrier by swapping `thedelivcouname`. Confirmed working for RE Logistics
// Solutions; the other carrier-name strings follow the same convention but have
// not been verified against the site.
const DT_ID = process.env.DELIVERYTRACKER_ID || 'mystauzceko9517';
const aggregatorLink = (couName) => (d) =>
  'https://thedeliverytracker.com/my-delivery-tracker-page/' +
  `?thedelivno=${encodeURIComponent(d)}` +
  `&thedelivcouname=${encodeURIComponent(couName).replace(/%20/g, '+')}` +
  `&thedelivid=${encodeURIComponent(DT_ID)}&Track=Track`;

const CARRIERS = [
  {
    id: 'delhivery',
    label: 'Delhivery',
    match: /delhivery/i,
    mode: 'api',
    adapter: withProviders(trackDelhivery),
    link: aggregatorLink('Delhivery'),
    altLinks: [
      { label: 'trackcourier.io', url: () => 'https://trackcourier.io/delhivery-courier-tracking' },
      { label: 'delhivery.com', url: (d) => `https://www.delhivery.com/tracking?trackingId=${encodeURIComponent(d)}` }
    ]
  },
  {
    id: 'safexpress',
    label: 'Safexpress',
    match: /safexpress/i,
    mode: 'api',
    adapter: withProviders(aggregatorAdapter('Safexpress')),
    link: aggregatorLink('Safexpress'),
    altLinks: [{ label: 'safexpress.com', url: () => 'https://www.safexpress.com/' }]
  },
  {
    id: 'smartshift',
    label: 'SmartShift',
    match: /smart\s*shift/i,
    mode: 'api',
    adapter: withProviders(aggregatorAdapter('Smartshift Logistics Solutions')),
    link: aggregatorLink('Smartshift Logistics Solutions')
  },
  {
    id: 'allcargo',
    label: 'Allcargo',
    match: /all\s*cargo/i,
    mode: 'api',
    adapter: withProviders(aggregatorAdapter('All Cargo Logistics')),
    link: aggregatorLink('All Cargo Logistics')
  },
  {
    id: 'relogistics',
    label: 'RE Logistics',
    match: /\bre\s*logistics\b/i,
    mode: 'api',
    // Aggregator URL confirmed working by the customer with a live docket.
    adapter: withProviders(aggregatorAdapter('RE Logistics Solutions')),
    link: aggregatorLink('RE Logistics Solutions'),
    altLinks: [{ label: 'relogi.in', url: () => 'https://www.relogi.in/tracking' }]
  },
  {
    id: 'rvexpress',
    label: 'R.V. Express',
    match: /r\.?\s*v\.?\s*express/i,
    mode: 'api',
    adapter: withProviders(aggregatorAdapter('RV Express')),
    link: aggregatorLink('RV Express')
  },

  // ── Not tracked ───────────────────────────────────────────────────────────
  // Own-fleet / offline delivery. For both of these the "docket number" is the
  // invoice number itself, so there is nothing to look up.
  {
    id: 'jms',
    label: 'JMS Trading (offline)',
    match: /jms\s*trading/i,
    mode: 'offline',
    offlineNote: 'Offline delivery — not tracked'
  },
  {
    id: 'kent',
    label: 'Kent (offline)',
    match: /^kent\b/i,
    mode: 'offline',
    offlineNote: 'Offline delivery — not tracked'
  },

  // ── Carried over from the Skyking build; proven adapters, kept so that a
  //    register containing these carriers works with no code change. ─────────
  {
    id: 'skyking',
    label: 'Skyking',
    match: /sky\s*king|fly\s*king/i,
    mode: 'api',
    adapter: trackSkyking,
    link: (d) => `https://skyking.co/track?cno=${encodeURIComponent(d)}`
  },
  {
    id: 'quick',
    label: 'Quick India',
    match: /quick\s*(india)?\s*logistic/i,
    mode: 'api',
    adapter: trackQuick,
    link: (d) => `https://www.quickindialogistics.com/tracking?awb=${encodeURIComponent(d)}`
  }
];

const UNKNOWN = {
  id: 'unknown',
  label: 'Unknown carrier',
  mode: 'offline',
  offlineNote: 'No carrier on invoice — not tracked'
};

/** Resolve a raw "CARRIER NAME" cell to a registry entry. */
function resolveCarrier(rawName) {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (!name) return UNKNOWN;
  const hit = CARRIERS.find((c) => c.match.test(name));
  if (hit) return hit;
  // Carrier not in the registry — the aggregator is generic, so send its own
  // name through and let the user confirm on the site.
  return {
    id: 'unmapped',
    label: name,
    mode: 'api',
    adapter: withProviders(aggregatorAdapter(name)),
    link: aggregatorLink(name),
    unmapped: true
  };
}

/**
 * Collapse a carrier's free-text scan wording into one canonical status, so the
 * report reads the same regardless of which carrier produced it.
 * Order matters: the most specific wording is tested first.
 */
// Covers both carrier free-text wording and 17track's canonical vocabulary
// (Delivered, InTransit, OutForDelivery, InfoReceived, DeliveryFailure,
// AvailableForPickup, Exception, Expired, NotFound), which arrives unspaced.
const STATUS_RULES = [
  // Undelivered must precede Delivered: "undelivered" contains "delivered".
  ['Undelivered', /undelivered|delivery\s*fail(ure|ed)|fail(ed)?\s*attempt|attempt\s*fail|not\s*delivered|refused|\brto\b|return\s*to\s*origin|exception/i],
  ['Delivered', /delivered|delivery\s*done|pod\s*upload|consignee\s*received|shipment\s*received\s*by/i],
  ['Out for Delivery', /out\s*for\s*delivery|ofd|with\s*delivery\s*(agent|boy)/i],
  ['Awaiting Pickup', /available\s*for\s*pickup|awaiting\s*(collection|pickup)|ready\s*for\s*(pickup|collection)/i],
  ['In Transit', /\btransit\b|intransit|forwarded|departed|arrived|reached|connected|in\s*route|shipment\s*moved/i],
  ['Picked Up', /picked\s*up|\bpickup\b|collected/i],
  ['Booked', /booked|manifest|info\s*received|data\s*received|order\s*placed|soft\s*data|consignment\s*created|\bpending\b/i],
  ['Not Found', /not\s*found|no\s*record|invalid|no\s*data|expired/i]
];

function normaliseStatus(raw) {
  const s = String(raw || '').replace(/[_-]+/g, ' ').trim();
  if (!s) return '';
  for (const [canon, re] of STATUS_RULES) if (re.test(s)) return canon;
  return s;
}

/** Public shape used by the frontend to render filter chips / legends. */
function carrierCatalog() {
  return CARRIERS.map((c) => ({ id: c.id, label: c.label, mode: c.mode }));
}

/** POD/tracking hosts the image proxy is allowed to fetch from. */
const POD_HOST_ALLOWLIST = (process.env.POD_HOST_ALLOWLIST ||
  [
    's3-ap-southeast-1.amazonaws.com',
    'www.quickindialogistics.com',
    'quickindialogistics.com',
    'dlv-api.delhivery.com',
    'www.delhivery.com'
  ].join(','))
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// ── Adapters ────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Wrap a carrier's own source so the configured provider chain is tried first,
 * falling back to the carrier-specific path when no provider has a record.
 */
function withProviders(fallback) {
  return async (docket, ctx) => {
    const viaProvider = await trackViaProviders(docket, ctx);
    if (viaProvider) return viaProvider;
    return fallback(docket, ctx);
  };
}

// ── Generic aggregator scrape ───────────────────────────────────────────────
// thedeliverytracker.com renders a status table for any carrier passed as
// `thedelivcouname`. Scraping it gives automatic status for every carrier we
// have no first-party API for, using the one URL shape confirmed working.
//
// UNVERIFIED against a live response: this environment blocks egress to the
// site, so the table markup could not be inspected. The extractor is written
// to tolerate several shapes and returns null when it cannot find a status —
// track.js then degrades the row to a deep link, exactly as before.

const STATUS_WORDS = /(delivered|out for delivery|in\s*transit|intransit|booked|picked\s*up|pickup|dispatch(?:ed)?|manifest(?:ed)?|received|arrived|departed|forwarded|shipped|rto|undelivered|pending|not\s*found|no\s*record)/i;

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ');
const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
const clean = (s) => decodeEntities(stripTags(String(s || ''))).replace(/\s+/g, ' ').trim();

/** Pull every <tr> as an array of cell strings. */
function htmlRows(html) {
  const out = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1]))) cells.push(clean(c[1]));
    if (cells.some(Boolean)) out.push(cells);
  }
  return out;
}

const looksLikeDate = (s) =>
  /\d{1,2}[-/ ](?:\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ]\d{2,4}/i.test(s) ||
  /\d{4}-\d{2}-\d{2}/.test(s);

async function scrapeDeliveryTracker(docket, couName) {
  const res = await fetch(aggregatorLink(couName)(docket), {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`Aggregator ${res.status}`);
  const html = await res.text();

  // Ignore the page's own form/nav rows: keep rows that carry a status word.
  const rows = htmlRows(html).filter((cells) => cells.join(' ').length > 3);
  const events = [];
  for (const cells of rows) {
    const joined = cells.join(' ');
    if (!STATUS_WORDS.test(joined)) continue;
    if (/thedelivcouname|select\s+courier|enter\s+(your\s+)?(consignment|docket|awb)/i.test(joined)) continue;

    const date = cells.find(looksLikeDate) || '';
    const status = cells.find((c) => STATUS_WORDS.test(c)) || '';
    // A two-column summary row is "<label>|<value>" — its other cell is a field
    // label, not a location.
    const isLabel = (c) =>
      /^(current\s+)?status$|^date(\s*&?\s*time)?$|^location$|^remarks?$|^(consignment|docket|awb|waybill)\s*(no\.?|number)?$/i.test(c);
    const location =
      cells.find((c) => c && c !== date && c !== status && !isLabel(c) && !/^\d+$/.test(c) && c.length < 60) || '';
    if (status) events.push({ date, location, status });
  }

  if (!events.length) {
    // Fall back to a bare status phrase anywhere in the page body.
    const body = clean(html.replace(/<script[\s\S]*?<\/script>/gi, ''));
    const hit = body.match(STATUS_WORDS);
    if (!hit) return null;
    if (/not\s*found|no\s*record/i.test(hit[0])) return { success: false, error: 'No record on carrier site' };
    return {
      success: true,
      currentStatus: hit[0].replace(/\s+/g, ' '),
      latestDate: '',
      latestLocation: '',
      city: '',
      podUrl: '',
      isDelivered: /delivered/i.test(hit[0]),
      events: []
    };
  }

  const latest = events[events.length - 1];
  return {
    success: true,
    currentStatus: latest.status,
    latestDate: latest.date,
    latestLocation: latest.location,
    city: latest.location,
    podUrl: '',
    isDelivered: /delivered/i.test(latest.status),
    events
  };
}

/**
 * Build an `api` adapter that scrapes the aggregator for a given carrier name.
 * Declared as a function so it hoists above the CARRIERS array below.
 */
function aggregatorAdapter(couName) {
  return async (docket) => {
    const r = await scrapeDeliveryTracker(docket, couName);
    if (!r) throw new Error('No status found on aggregator');
    return r;
  };
}

/**
 * Delhivery — public unified-tracking endpoint used by delhivery.com/tracking.
 *
 * UNVERIFIED: this session had no outbound access to dlv-api.delhivery.com, so
 * the response shape below could not be confirmed against a live docket. It is
 * written defensively (every field optional-chained) and the handler degrades
 * the row to a deep link if the call fails or the shape does not match. Confirm
 * with DevTools → Network on delhivery.com/tracking before relying on it.
 */
async function trackDelhivery(docket) {
  const res = await fetch(
    `https://dlv-api.delhivery.com/v3/unified-tracking?wbn=${encodeURIComponent(docket)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.delhivery.com', Referer: 'https://www.delhivery.com/' } }
  );
  if (!res.ok) throw new Error(`Delhivery ${res.status}`);
  const json = await res.json();

  const shipment = json?.data?.[0] || json?.ShipmentData?.[0]?.Shipment || null;
  if (!shipment) throw new Error('Unrecognised Delhivery payload');

  const scans = shipment.scans || shipment.Scans || [];
  const events = scans.map((s) => {
    const d = s.ScanDetail || s;
    return {
      date: d.ScanDateTime || d.scanDateTime || d.scan_date || '',
      location: d.ScannedLocation || d.scannedLocation || d.location || '',
      status: d.Instructions || d.instructions || d.scan || d.status || ''
    };
  });

  const latest = events[events.length - 1] || {};
  const status = shipment.status?.status || shipment.Status?.Status || latest.status || '';
  const isDelivered = /delivered/i.test(status);

  return {
    success: true,
    currentStatus: status,
    latestDate: latest.date || '',
    latestLocation: latest.location || '',
    city: (shipment.status?.statusLocation || latest.location || '').split(/[_,(]/)[0].trim(),
    podUrl: shipment.pod || shipment.POD || '',
    isDelivered,
    events
  };
}

/** Skyking — carried over unchanged from the previous build (working). */
async function trackSkyking(docket, ctx) {
  const API = 'https://live.skyking.co';
  const headers = { Origin: 'https://skyking.co', Referer: 'https://skyking.co/track', 'User-Agent': UA };

  const apiKey = await ctx.once('skyking:key', async () => {
    const r = await fetch(`${API}/api/Track/GetAPIKeyValue`, { headers });
    return (await r.text()).replace(/^"|"$/g, '').trim();
  });

  const res = await fetch(
    `${API}/api/Track/ConsignmentMTrack_WebSite_AuthNew?cnote=${encodeURIComponent(docket)}&key=skm&Email=skm@flyking.co.in`,
    { headers: { ...headers, KeyValue: apiKey, 'Content-Type': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Skyking ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return { success: false, error: 'No data' };

  const events = data.map((e) => ({
    date: e.DateTime || '', location: e.Location || '', status: e.Status || '',
    refNo: e.RefNo || '', showPod: e.ShowPOD || ''
  }));
  const latest = events[events.length - 1];
  const isDelivered = /delivered|delivery done|pod\s*upload/i.test(latest.status);

  let podUrl = '';
  const de = [...events].reverse().find(
    (e) => e.showPod && e.showPod.includes('View') && e.refNo && e.refNo.toLowerCase().includes('-dm-')
  );
  if (de) {
    try {
      const pr = await fetch(
        `${API}/api/values/PODSignaturefetch?refNo=${encodeURIComponent(de.refNo)}&cNo=${encodeURIComponent(docket)}`,
        { headers }
      );
      const pd = await pr.json();
      if (Array.isArray(pd) && pd[0]?.Signature_POD) {
        podUrl = `https://s3-ap-southeast-1.amazonaws.com/scancopyofdrs/${pd[0].Signature_POD}`;
      }
    } catch (_) { /* POD is best-effort */ }
  }

  return {
    success: true,
    currentStatus: latest.status,
    latestDate: latest.date,
    latestLocation: latest.location,
    city: latest.location.replace(/\s+(HUB FACILITY|HUB|FACILITY|BRANCH|CENTRE|CENTER)\s*$/i, '').trim(),
    podUrl, isDelivered,
    events: events.map(({ date, location, status }) => ({ date, location, status }))
  };
}

/** Quick India Logistics — carried over unchanged from the previous build. */
async function trackQuick(docket) {
  const API = 'https://www.quickindialogistics.com';
  const sr = await fetch(`${API}/tracking-api/booking/get_order_status/?awb_no=${encodeURIComponent(docket)}`);
  const statusData = await sr.json();
  if (!Array.isArray(statusData) || !statusData[0]?.length) return { success: false, error: 'No tracking data found' };

  const all = statusData[0];
  const currentStatus = all[all.length - 1];
  const trackingEvents = all.slice(0, -1);
  const latest = trackingEvents[trackingEvents.length - 1] || {};
  const status = currentStatus.status || latest.status || '';

  let podUrl = '';
  if (currentStatus.docket) {
    try {
      const pr = await fetch(`${API}/tracking-api/booking/get_track_delivery/?docket=${encodeURIComponent(currentStatus.docket)}`);
      const podData = await pr.json();
      if (Array.isArray(podData) && podData[0]?.delivery_image?.length) {
        podUrl = podData[0].delivery_image[0].image || '';
      }
    } catch (_) { /* POD is best-effort */ }
  }

  return {
    success: true,
    currentStatus: status,
    latestDate: latest.created_at ? latest.created_at.split('T')[0] : '',
    latestLocation: [currentStatus.current_city, currentStatus.current_state].filter(Boolean).join(', '),
    city: currentStatus.current_city || '',
    podUrl,
    isDelivered: /delivered|delivery done/i.test(status),
    events: trackingEvents.map((e) => ({
      date: e.created_at || '',
      location: [e.status_current_city, e.status_current_state].filter(Boolean).join(', '),
      status: e.status || ''
    }))
  };
}

module.exports = {
  CARRIERS, UNKNOWN, resolveCarrier, carrierCatalog, normaliseStatus,
  POD_HOST_ALLOWLIST
};
