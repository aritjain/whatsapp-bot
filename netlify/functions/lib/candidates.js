'use strict';

/**
 * Endpoint candidates and discovery hints for carrier-native integrations.
 *
 * Carrier-native adapters are the only way to get POD images — the tracking
 * aggregators return scan events only. Writing one needs the carrier's real
 * status and POD endpoints, which is normally DevTools work. `probe.js` uses
 * this file to do that from the deployed site instead: it fetches each
 * carrier's tracking page, pulls candidate API URLs out of the page and its
 * JavaScript bundles, and tries the known candidates below.
 *
 * Nothing here is used at runtime by the tracker itself.
 */

// Pages whose markup and scripts are scanned for API URLs.
const DISCOVERY_PAGES = {
  delhivery: ['https://www.delhivery.com/track-v2/lr/{D}', 'https://www.delhivery.com/'],
  safexpress: ['https://www.safexpress.com/', 'https://www.safexpress.com/track-shipment'],
  relogistics: ['https://lms.relogi.in/WebTracking/WebTracking.aspx?AwbNo={D}', 'https://lms.relogi.in/']
};

/**
 * Known/plausible endpoints, tried with the docket substituted for {D}.
 * `kind` marks what the response is expected to carry, so the probe can say
 * which ones look like a status feed and which look like a POD.
 */
const CANDIDATES = {
  delhivery: [
    { kind: 'status', url: 'https://www.delhivery.com/track-v2/lr/{D}' },
    { kind: 'status', url: 'https://www.delhivery.com/api/track-v2/lr/{D}' },
    { kind: 'status', url: 'https://dlv-api.delhivery.com/v3/unified-tracking?lrnum={D}' },
    { kind: 'status', url: 'https://dlv-api.delhivery.com/v3/unified-tracking?wbn={D}' },
    { kind: 'status', url: 'https://track.delhivery.com/api/v1/packages/json/?waybill={D}' },
    { kind: 'status', url: 'https://www.delhivery.com/api/tracking/?waybill={D}' },
    { kind: 'pod', url: 'https://dlv-api.delhivery.com/v3/pod?wbn={D}' },
    { kind: 'pod', url: 'https://track.delhivery.com/api/p/pod?wbn={D}' }
  ],
  safexpress: [
    { kind: 'status', url: 'https://www.safexpress.com/api/track?waybill={D}' },
    { kind: 'status', url: 'https://www.safexpress.com/RestService/TrackingService/GetTracking?waybillNo={D}' },
    { kind: 'status', url: 'https://newsite.safexpress.com/api/tracking/{D}' },
    { kind: 'pod', url: 'https://www.safexpress.com/api/pod?waybill={D}' }
  ],
  relogistics: [
    { kind: 'status', url: 'https://lms.relogi.in/WebTracking/WebTracking.aspx?AwbNo={D}' }
  ]
};

// URL-ish strings worth reporting when scanning page markup and bundles.
const INTERESTING = /(track|tracking|consignment|docket|waybill|awb|pod|proof|status)/i;
const URL_RE = /(?:https?:)?\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+|["'`](\/(?:api|rest|service|wp-admin|v\d)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)["'`]/g;

module.exports = { DISCOVERY_PAGES, CANDIDATES, INTERESTING, URL_RE };
