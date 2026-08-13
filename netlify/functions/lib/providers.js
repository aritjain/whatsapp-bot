'use strict';

/**
 * Tracking-provider chain.
 *
 * Several aggregators cover the same Indian carriers. Rather than betting on
 * one, each docket walks a chain: the first provider that returns a usable
 * status wins, and any provider that errors, is unconfigured, or has no record
 * simply hands off to the next. The carrier's own API (or the HTML aggregator)
 * sits at the end of the chain as the last resort.
 *
 * A provider is enabled only when its API key is present, so an unconfigured
 * provider costs nothing. Order is configurable:
 *
 *   PROVIDER_ORDER=ship24,17track,trackingmore,aftership
 *
 * All four are commercial APIs that bill per tracking number, so every provider
 * that can take a batch does — the whole request is fetched in one round trip
 * and each docket reads from the shared result.
 *
 * UNVERIFIED: this build environment blocks egress to all four hosts, so the
 * response shapes below could not be confirmed against live calls. Each parser
 * reads defensively and returns null rather than guessing, which passes the
 * docket to the next provider instead of surfacing a wrong status.
 */

const DEFAULT_ORDER = ['ship24', '17track', 'trackingmore', 'aftership'];

const PROVIDERS = {
  ship24: { key: () => process.env.SHIP24_KEY, track: ship24 },
  '17track': { key: () => process.env.SEVENTEENTRACK_KEY, track: track17 },
  trackingmore: { key: () => process.env.TRACKINGMORE_KEY, track: trackingMore },
  aftership: { key: () => process.env.AFTERSHIP_KEY, track: afterShip }
};

function enabledProviders() {
  const order = (process.env.PROVIDER_ORDER || DEFAULT_ORDER.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return order.filter((id) => PROVIDERS[id] && PROVIDERS[id].key());
}

/** Docket numbers in the batch currently being processed. */
function batchNumbers(docket, ctx) {
  const list = ctx && Array.isArray(ctx.batch) && ctx.batch.length ? ctx.batch : [{ docket }];
  return [...new Set(list.map((s) => String(s.docket || '').trim()).filter(Boolean))];
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function postJSON(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

async function getJSON(url, headers) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

/** Normalise an event list to oldest-last, which is what the app expects. */
function orderEvents(events) {
  const withTime = events.filter((e) => e.date);
  if (withTime.length > 1) {
    const first = Date.parse(withTime[0].date);
    const last = Date.parse(withTime[withTime.length - 1].date);
    if (!Number.isNaN(first) && !Number.isNaN(last) && first > last) return [...events].reverse();
  }
  return events;
}

function shape(status, events, extra) {
  const ordered = orderEvents(events.filter((e) => e.status || e.location || e.date));
  const latest = ordered[ordered.length - 1] || {};
  const finalStatus = status || latest.status || '';
  if (!finalStatus && !ordered.length) return null;
  return {
    success: true,
    currentStatus: finalStatus,
    latestDate: (extra && extra.date) || latest.date || '',
    latestLocation: (extra && extra.location) || latest.location || '',
    city: String((extra && extra.location) || latest.location || '').split(',')[0].trim(),
    podUrl: (extra && extra.podUrl) || '',
    isDelivered: /delivered/i.test(finalStatus),
    events: ordered
  };
}

// ── Ship24 ──────────────────────────────────────────────────────────────────
// POST /public/v1/trackers/track, Bearer apik_… . One number per call, so the
// whole batch is fetched once and memoised.
async function ship24(docket, ctx) {
  const key = process.env.SHIP24_KEY;
  const numbers = batchNumbers(docket, ctx);

  const map = await ctx.once('ship24:batch', async () => {
    const results = new Map();
    const CONC = Number(process.env.SHIP24_CONCURRENCY || 4);
    for (const group of chunk(numbers, CONC)) {
      await Promise.all(
        group.map(async (number) => {
          try {
            const json = await postJSON(
              'https://api.ship24.com/public/v1/trackers/track',
              { Authorization: `Bearer ${key}` },
              { trackingNumber: number }
            );
            const t = json?.data?.trackings?.[0];
            if (t) results.set(number, t);
          } catch (_) { /* leave unset; chain falls through */ }
        })
      );
    }
    return results;
  });

  const t = map.get(String(docket));
  if (!t) return null;

  const events = (t.events || []).map((e) => ({
    date: e.occurrenceDatetime || e.datetime || '',
    location: e.location || [e.city, e.state].filter(Boolean).join(', ') || '',
    status: e.status || e.statusMilestone || ''
  }));
  const milestone = t.shipment?.statusMilestone || t.shipment?.statusCategory || '';
  return shape(milestone, events);
}

// ── 17track ─────────────────────────────────────────────────────────────────
// POST /track/v2.2/{register,gettrackinfo}, header 17token, 40 numbers a call.
// m.17track.net is the mobile web app and renders client-side, so it cannot be
// fetched server-side — this is the API behind it.
async function track17(docket, ctx) {
  const key = process.env.SEVENTEENTRACK_KEY;
  const numbers = batchNumbers(docket, ctx);
  const head = { '17token': key };

  const map = await ctx.once('17track:batch', async () => {
    const results = new Map();
    for (const group of chunk(numbers, 40)) {
      const payload = group.map((number) => ({ number }));
      // Registration is idempotent; numbers already known come back rejected
      // with a benign code, so failures here are not fatal.
      try {
        await postJSON(`https://api.17track.net/track/v2.2/register`, head, payload);
      } catch (_) { /* proceed to the read */ }

      const info = await postJSON(`https://api.17track.net/track/v2.2/gettrackinfo`, head, payload);
      for (const row of info?.data?.accepted || []) {
        if (row.number) results.set(String(row.number), row.track_info || row);
      }
    }
    return results;
  });

  const ti = map.get(String(docket));
  if (!ti) return null;

  const events = [];
  for (const p of ti.tracking?.providers || []) {
    for (const e of p.events || []) {
      events.push({
        date: e.time_iso || e.time_utc || '',
        location: e.location || [e.address?.city, e.address?.state].filter(Boolean).join(', ') || '',
        status: e.description || e.stage || ''
      });
    }
  }
  const le = ti.latest_event || {};
  return shape(ti.latest_status?.status || le.description || '', events, {
    date: le.time_iso || le.time_utc || '',
    location: le.location || ''
  });
}

// ── TrackingMore ────────────────────────────────────────────────────────────
// GET /v4/trackings/get?tracking_numbers=…, header Tracking-Api-Key, 40 a call.
async function trackingMore(docket, ctx) {
  const key = process.env.TRACKINGMORE_KEY;
  const numbers = batchNumbers(docket, ctx);

  const map = await ctx.once('trackingmore:batch', async () => {
    const results = new Map();
    for (const group of chunk(numbers, 40)) {
      try {
        const json = await getJSON(
          `https://api.trackingmore.com/v4/trackings/get?tracking_numbers=${encodeURIComponent(group.join(','))}`,
          { 'Tracking-Api-Key': key }
        );
        for (const row of json?.data || []) {
          if (row.tracking_number) results.set(String(row.tracking_number), row);
        }
      } catch (_) { /* chain falls through */ }
    }
    return results;
  });

  const row = map.get(String(docket));
  if (!row) return null;

  const scans = row.origin_info?.trackinfo || row.destination_info?.trackinfo || [];
  const events = scans.map((e) => ({
    date: e.checkpoint_date || e.date || '',
    location: e.location || e.checkpoint_delivery_substatus || '',
    status: e.tracking_detail || e.checkpoint_delivery_status || ''
  }));
  return shape(row.delivery_status || '', events);
}

// ── AfterShip ───────────────────────────────────────────────────────────────
// GET /tracking/2024-04/trackings?tracking_numbers=…, header as-api-key.
async function afterShip(docket, ctx) {
  const key = process.env.AFTERSHIP_KEY;
  const numbers = batchNumbers(docket, ctx);

  const map = await ctx.once('aftership:batch', async () => {
    const results = new Map();
    for (const group of chunk(numbers, 50)) {
      try {
        const json = await getJSON(
          `https://api.aftership.com/tracking/2024-04/trackings?tracking_numbers=${encodeURIComponent(group.join(','))}`,
          { 'as-api-key': key }
        );
        for (const row of json?.data?.trackings || []) {
          if (row.tracking_number) results.set(String(row.tracking_number), row);
        }
      } catch (_) { /* chain falls through */ }
    }
    return results;
  });

  const row = map.get(String(docket));
  if (!row) return null;

  const events = (row.checkpoints || []).map((c) => ({
    date: c.checkpoint_time || c.created_at || '',
    location: c.location || [c.city, c.state].filter(Boolean).join(', ') || '',
    status: c.message || c.tag || ''
  }));
  return shape(row.tag || row.subtag || '', events);
}

/**
 * Walk the chain. Returns the first usable result with `source` set, or null
 * when nothing is configured or nothing has a record.
 */
async function trackViaProviders(docket, ctx) {
  const tried = [];
  for (const id of enabledProviders()) {
    try {
      const r = await PROVIDERS[id].track(docket, ctx);
      if (r) return { ...r, source: id, providersTried: [...tried, id] };
      tried.push(`${id}:no-record`);
    } catch (e) {
      tried.push(`${id}:${e.message}`);
    }
  }
  return null;
}

module.exports = { trackViaProviders, enabledProviders, DEFAULT_ORDER };
