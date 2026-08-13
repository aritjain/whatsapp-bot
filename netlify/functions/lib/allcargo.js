'use strict';

/**
 * Allcargo Logistics — carrier-native integration.
 *
 * Portal: https://www.allcargologistics.com/track-shipment
 *
 * The tracking page takes the docket through a form rather than the URL, so
 * unlike RE Logistics there is no GET page to parse — the result comes from an
 * API the page calls. The docket result carries an explicit **Download POD**
 * action, so a POD is available for delivered consignments.
 *
 * UNVERIFIED: the API route could not be observed from the build environment.
 * Candidates below are tried as both GET and POST, and each returns null
 * rather than guessing, so a miss falls through to the aggregator chain.
 * Run `/api/probe?carrier=allcargo&docket=…` from the deployed site to have
 * the page's JavaScript bundles scanned for the real route.
 */

const { readPayload, findPodUrl } = require('./jsonshape');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const BASE = process.env.ALLCARGO_BASE || 'https://www.allcargologistics.com';
const trackPage = () => `${BASE}/track-shipment`;

// {D} is the docket number. GET candidates are tried first, then POST with a
// small set of body shapes, since the form's field name is unknown.
const GET_CANDIDATES = [
  `${BASE}/api/track-shipment?docketNumber={D}`,
  `${BASE}/api/tracking?docketNumber={D}`,
  `${BASE}/api/v1/track?docket={D}`,
  `${BASE}/api/shipment/track/{D}`
];

const POST_CANDIDATES = [`${BASE}/api/track-shipment`, `${BASE}/api/tracking`, `${BASE}/api/v1/track`];

const POST_BODIES = [
  (d) => ({ docketNumber: d }),
  (d) => ({ docketNo: d }),
  (d) => ({ docket: d }),
  (d) => ({ trackingNumber: d })
];

const POD_CANDIDATES = [
  `${BASE}/api/pod?docketNumber={D}`,
  `${BASE}/api/download-pod?docketNumber={D}`,
  `${BASE}/api/shipment/pod/{D}`
];

const headers = () => ({
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: trackPage(),
  Origin: BASE
});

async function asJson(res) {
  if (!res || !res.ok) return null;
  const text = await res.text();
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Try every candidate route until one yields a payload with scans. */
async function fetchTracking(docket) {
  const enc = encodeURIComponent(docket);

  for (const tpl of GET_CANDIDATES) {
    try {
      const json = await asJson(await fetch(tpl.replace(/\{D\}/g, enc), { headers: headers() }));
      if (json && readPayload(json)) return json;
    } catch (_) { /* next candidate */ }
  }

  for (const url of POST_CANDIDATES) {
    for (const makeBody of POST_BODIES) {
      try {
        const json = await asJson(
          await fetch(url, {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify(makeBody(docket))
          })
        );
        if (json && readPayload(json)) return json;
      } catch (_) { /* next body shape */ }
    }
  }
  return null;
}

/** Adapter used by the carrier registry. */
async function track(docket) {
  const json = await fetchTracking(docket);
  if (!json) throw new Error('Allcargo: no usable tracking source');
  const result = readPayload(json);
  if (!result) throw new Error('Allcargo: unrecognised payload');

  // The page exposes a Download POD action, so mark POD as available for
  // delivered consignments even when the payload carries no direct URL —
  // fetchPod resolves it server-side.
  const podAvailable = !!result.podUrl || result.isDelivered;
  return { ...result, podAvailable, podPageUrl: trackPage() };
}

/** Resolve POD bytes: a URL in the payload if present, else the POD routes. */
async function fetchPod(docket) {
  const enc = encodeURIComponent(docket);

  const json = await fetchTracking(docket);
  const direct = json ? findPodUrl(json) : '';
  if (direct) {
    const r = await fetch(direct, { headers: headers() });
    if (r.ok) {
      return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'image/jpeg' };
    }
  }

  for (const tpl of POD_CANDIDATES) {
    try {
      const r = await fetch(tpl.replace(/\{D\}/g, enc), { headers: headers() });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (/json|text\/html/i.test(ct)) {
        // Some routes answer with a JSON envelope holding the file URL.
        const j = await asJson(r);
        const nested = j ? findPodUrl(j) : '';
        if (!nested) continue;
        const r2 = await fetch(nested, { headers: headers() });
        if (!r2.ok) continue;
        return {
          buffer: Buffer.from(await r2.arrayBuffer()),
          contentType: r2.headers.get('content-type') || 'image/jpeg'
        };
      }
      return { buffer: Buffer.from(await r.arrayBuffer()), contentType: ct || 'image/jpeg' };
    } catch (_) { /* next candidate */ }
  }

  throw new Error('Allcargo: POD route not found');
}

module.exports = { track, fetchPod, fetchTracking, trackPage, BASE };
