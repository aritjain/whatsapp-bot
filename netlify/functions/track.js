'use strict';

const { verifyRequest, cors, json } = require('./lib/auth-jwt');
const { resolveCarrier, carrierCatalog, normaliseStatus } = require('./lib/carriers');

const MAX_BATCH = Number(process.env.MAX_BATCH || 25);
const CONCURRENCY = Number(process.env.TRACK_CONCURRENCY || 6);

/** Run `worker` over items with a bounded number of in-flight requests. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Per-request memo, so adapters sharing a session key or a batched upstream
 * call do the work once. `batch` lets an adapter see every shipment in the
 * current request — 17track bills per number, so it fetches the whole batch in
 * one round trip instead of one per docket.
 */
function makeCtx(batch) {
  const cache = new Map();
  return {
    batch,
    once(key, fn) {
      if (!cache.has(key)) cache.set(key, fn());
      return cache.get(key);
    }
  };
}

async function trackOne({ docket, carrier: rawCarrier }, ctx) {
  const docketNo = String(docket || '').trim();
  const carrier = resolveCarrier(rawCarrier);
  const base = {
    docket: docketNo,
    carrierId: carrier.id,
    carrier: carrier.label,
    mode: carrier.mode
  };

  if (!docketNo) {
    return { ...base, success: true, tracked: false, currentStatus: 'No docket number', trackingLink: '', events: [] };
  }

  // Offline carriers (JMS Trading, blank carrier) never hit the network.
  if (carrier.mode === 'offline') {
    return {
      ...base,
      success: true,
      tracked: false,
      currentStatus: carrier.offlineNote || 'Not tracked',
      trackingLink: '',
      events: []
    };
  }

  const link = typeof carrier.link === 'function' ? carrier.link(docketNo) : '';
  const altLinks = (carrier.altLinks || []).map((a) => ({ label: a.label, url: a.url(docketNo) }));
  Object.assign(base, { altLinks });

  // No adapter yet — hand the UI a deep link to the carrier's own page.
  if (carrier.mode !== 'api' || typeof carrier.adapter !== 'function') {
    return {
      ...base,
      success: true,
      tracked: false,
      linkOnly: true,
      currentStatus: 'Track on carrier site',
      trackingLink: link,
      events: []
    };
  }

  try {
    const r = await carrier.adapter(docketNo, ctx);
    if (!r || r.success === false) {
      return { ...base, success: false, tracked: true, error: (r && r.error) || 'No data', trackingLink: link, events: [] };
    }
    // Canonical status for the report; the carrier's own wording is kept too.
    const status = normaliseStatus(r.currentStatus);
    // podFetch is the exact path the browser should call: a direct URL goes
    // through the proxy, while a carrier-resolved POD is fetched server-side.
    let podFetch = '';
    if (r.podUrl) {
      podFetch = `/api/pod-image?url=${encodeURIComponent(r.podUrl)}&docket=${encodeURIComponent(docketNo)}`;
    } else if (r.podAvailable) {
      podFetch = `/api/pod-image?carrier=${encodeURIComponent(carrier.id)}&docket=${encodeURIComponent(docketNo)}`;
    }

    return {
      ...base,
      success: true,
      tracked: true,
      trackingLink: link,
      ...r,
      podFetch,
      status,
      rawStatus: r.currentStatus || '',
      currentStatus: status || r.currentStatus || '',
      isDelivered: status === 'Delivered' || !!r.isDelivered
    };
  } catch (e) {
    // Degrade to a deep link rather than showing a bare error — the shipment
    // is still lookupable by hand.
    return {
      ...base,
      success: true,
      tracked: false,
      linkOnly: true,
      degraded: true,
      currentStatus: 'Track on carrier site',
      error: e.message,
      trackingLink: link,
      events: []
    };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod === 'GET') return json(200, { carriers: carrierCatalog() });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!verifyRequest(event)) return json(401, { error: 'Unauthorized' });

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { shipments } = body || {};
  if (!Array.isArray(shipments) || shipments.length === 0) {
    return json(400, { error: 'shipments array required: [{ docket, carrier }]' });
  }
  if (shipments.length > MAX_BATCH) {
    return json(400, { error: `Batch too large (max ${MAX_BATCH})` });
  }

  const ctx = makeCtx(shipments);
  const results = await mapLimit(shipments, CONCURRENCY, (s) => trackOne(s, ctx));
  return json(200, { results });
};
