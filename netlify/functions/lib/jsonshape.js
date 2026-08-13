'use strict';

/**
 * Shape-agnostic readers for carrier tracking payloads.
 *
 * Every carrier names its fields differently and nests them differently, but
 * they all boil down to: a headline status, a list of scans, and sometimes a
 * POD link. These helpers find those without hard-coding a schema, so a new
 * carrier usually needs only its URL rather than a bespoke parser.
 *
 * Each returns null/'' rather than guessing, which lets callers fall through
 * to another source instead of surfacing a wrong status.
 */

const STATUS_KEY = /status|instruction|scan|remark|activity|stage|message|title|event/i;
const TIME_KEY = /date|time|timestamp/i;
const LOCATION_KEY = /location|city|branch|cent(er|re)|place|destination|hub/i;
const POD_KEY = /pod|proof.?of.?delivery|proof|signature|delivery_?image|docket_?image/i;
const FILE_URL = /^https?:\/\/\S+\.(jpe?g|png|pdf|tiff?)(\?|$)/i;

const isPrimitive = (v) => typeof v === 'string' || typeof v === 'number';

/** Read the first usable value among `keys`, unwrapping one level of nesting. */
function pick(o, keys) {
  for (const k of keys) {
    const v = o ? o[k] : null;
    if (v == null) continue;
    const flat = typeof v === 'object' && !Array.isArray(v) ? v.status || v.value || v.name || v.text || '' : v;
    if (isPrimitive(flat)) {
      const t = String(flat).trim();
      if (t) return t;
    }
  }
  return '';
}

/** A scan entry carries a textual status *and* a timestamp. */
function isScanEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const entries = Object.entries(e);
  const hasStatusText = entries.some(([k, v]) => STATUS_KEY.test(k) && typeof v === 'string' && v.trim());
  const hasTime = entries.some(([k, v]) => TIME_KEY.test(k) && isPrimitive(v) && String(v).trim());
  return hasStatusText && hasTime;
}

/**
 * Find the array of scans. Requiring both a textual status and a timestamp
 * stops a wrapper array — [{ status: {...}, scans: [...] }] — being mistaken
 * for the scan list itself.
 */
function findScanArray(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    if (node.length && node.every((e) => isScanEntry(e) || (e && isScanEntry(e.ScanDetail)))) return node;
    for (const v of node) {
      const hit = findScanArray(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/scans?|checkpoints?|timeline|history|events|trackingDetails|statusList/i.test(k)) {
        const hit = findScanArray(v, depth + 1);
        if (hit) return hit;
      }
    }
    for (const v of Object.values(node)) {
      const hit = findScanArray(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Find a POD file URL, preferring values under POD-ish keys. */
function findPodUrl(node, depth = 0) {
  if (!node || depth > 8) return '';
  if (typeof node === 'string') return FILE_URL.test(node) ? node : '';
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findPodUrl(v, depth + 1);
      if (hit) return hit;
    }
    return '';
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (POD_KEY.test(k)) {
        const hit = findPodUrl(v, depth + 1);
        if (hit) return hit;
      }
    }
    for (const v of Object.values(node)) {
      const hit = findPodUrl(v, depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}

/** Headline status, searched a couple of levels below the root. */
function findHeadline(root, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 3) return '';
  const direct = pick(root, ['status', 'currentStatus', 'orderStatus', 'shipmentStatus', 'docketStatus']);
  if (direct) return direct;
  if (Array.isArray(root)) {
    for (const v of root) {
      const hit = findHeadline(v, depth + 1);
      if (hit) return hit;
    }
    return '';
  }
  for (const [k, v] of Object.entries(root)) {
    if (/scans?|events|timeline|history/i.test(k)) continue;
    const hit = findHeadline(v, depth + 1);
    if (hit) return hit;
  }
  return '';
}

/** Turn a scan array plus its root payload into the app's result shape. */
function fromScanArray(scans, root) {
  const events = scans
    .map((raw) => {
      const e = raw.ScanDetail || raw;
      return {
        date: pick(e, ['ScanDateTime', 'scanDateTime', 'scan_date', 'timestamp', 'time', 'date', 'eventDate', 'statusDate']),
        location: pick(e, ['ScannedLocation', 'scannedLocation', 'location', 'city', 'branch', 'center', 'centre', 'hub']),
        status: pick(e, ['Instructions', 'instructions', 'scan', 'status', 'remarks', 'remark', 'activity', 'stage', 'message', 'title', 'event'])
      };
    })
    .filter((e) => e.status || e.location || e.date);
  if (!events.length) return null;

  // Newest-first payloads are common; the app wants oldest-last.
  const a = Date.parse(events[0].date);
  const b = Date.parse(events[events.length - 1].date);
  if (!Number.isNaN(a) && !Number.isNaN(b) && a > b) events.reverse();

  const latest = events[events.length - 1];
  const status = (root ? findHeadline(root) : '') || latest.status;
  const podUrl = findPodUrl(root || scans);

  return {
    success: true,
    currentStatus: status,
    latestDate: latest.date,
    latestLocation: latest.location,
    city: String(latest.location || '').split(/[,_(]/)[0].trim(),
    podUrl,
    podAvailable: !!podUrl,
    isDelivered: /delivered/i.test(status),
    events
  };
}

/** Read a payload end to end; null when it carries no recognisable scans. */
function readPayload(json) {
  const scans = findScanArray(json);
  if (!scans) return null;
  return fromScanArray(scans, json);
}

module.exports = {
  pick, isScanEntry, findScanArray, findPodUrl, findHeadline, fromScanArray, readPayload,
  STATUS_KEY, TIME_KEY, LOCATION_KEY, POD_KEY, FILE_URL
};
