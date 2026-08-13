'use strict';

/**
 * RE Logistics Solutions — carrier-native integration.
 *
 * Portal: https://lms.relogi.in/WebTracking/WebTracking.aspx?AwbNo=<docket>
 * (Sagar Informatics LMS, ASP.NET WebForms, server-rendered.)
 *
 * The page carries everything needed: a status badge, a "Shipment details"
 * table whose POD row holds View/Download links, and a "Tracking History"
 * table of date/activity rows, newest first.
 *
 * The POD link may be either a real href or a WebForms `__doPostBack`. Both are
 * handled: a direct href is returned as a URL, and a postback is replayed
 * server-side by `fetchPod` when the user opens the POD.
 */

const { UA, text, tableRows, postBackTarget, postBack, absolute } = require('./aspnet');

const BASE = process.env.RELOGISTICS_BASE || 'https://lms.relogi.in';
const pageUrl = (docket) => `${BASE}/WebTracking/WebTracking.aspx?AwbNo=${encodeURIComponent(docket)}`;

const DATE_RE = /^\d{1,2}[-/\s](?:\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/\s]\d{2,4}/i;
const isDate = (s) => DATE_RE.test(String(s || '').trim());
const parseDate = (s) => Date.parse(String(s || '').replace(/-/g, ' '));

async function fetchPage(docket) {
  const url = pageUrl(docket);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html', Referer: `${BASE}/` },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`RE Logistics ${res.status}`);
  return { url, html: await res.text() };
}

/**
 * Read the tracking page. Returns null when the page carries no shipment,
 * so the caller can fall through to another source.
 */
function parseTracking(html, url) {
  const rows = tableRows(html);

  // Label/value rows (AWB No, Pcs, Origin, Destination, POD …) versus the
  // history table, which is distinguished by a date in the first cell.
  const details = new Map();
  const events = [];
  for (const cells of rows) {
    if (cells.length < 2) continue;
    const first = cells[0].text;
    if (isDate(first)) {
      const activity = cells
        .slice(1)
        .map((c) => c.text)
        .filter(Boolean)
        .join(' — ');
      if (activity) events.push({ date: first, location: '', status: activity });
    } else if (first) {
      details.set(first.replace(/[.:]\s*$/, '').toLowerCase(), cells[1]);
    }
  }

  // The history table renders newest-first; the app expects oldest-last.
  if (events.length > 1) {
    const a = parseDate(events[0].date);
    const b = parseDate(events[events.length - 1].date);
    if (!Number.isNaN(a) && !Number.isNaN(b) && a > b) events.reverse();
  }

  // Status: the badge above the card, else the newest history activity.
  const badge = /(DELIVERED|UNDELIVERED|OUT FOR DELIVERY|IN\s*TRANSIT|BOOKED|PENDING|RTO)/i.exec(
    text(html.replace(/<table[\s\S]*?<\/table>/gi, ' '))
  );
  const latest = events[events.length - 1] || {};
  const status = (badge && badge[1]) || latest.status || '';

  const flat = text(html);
  const field = (label) => {
    const m = new RegExp(label + '\\s*:?\\s*([A-Za-z0-9 ,./-]{2,40})', 'i').exec(flat);
    return m ? m[1].trim() : '';
  };
  const destination = (details.get('destination') || {}).text || field('Destination');

  if (!status && !events.length) return null;

  // POD: the row labelled POD holds View/Download links.
  const podCell = details.get('pod');
  let podUrl = '';
  let podPostBack = null;
  if (podCell && podCell.links.length) {
    // Prefer an explicit Download link, else the first one offered.
    const link = podCell.links.find((l) => /download/i.test(l.label)) || podCell.links[0];
    const pb = postBackTarget(link.href);
    if (pb) podPostBack = pb;
    else if (!/^javascript:/i.test(link.href)) podUrl = absolute(link.href, url);
  }

  return {
    success: true,
    currentStatus: status,
    latestDate: latest.date || field('Delivery Date'),
    latestLocation: destination,
    city: String(destination || '').split(',')[0].trim(),
    podUrl,
    podAvailable: !!(podUrl || podPostBack),
    podPageUrl: url,
    isDelivered: /^delivered$/i.test(status.trim()),
    events
  };
}

/** Adapter used by the carrier registry. */
async function track(docket) {
  const { html, url } = await fetchPage(docket);
  const result = parseTracking(html, url);
  if (!result) throw new Error('RE Logistics: no shipment on page');
  return result;
}

/**
 * Resolve the POD bytes. Handles the direct-href case and the WebForms
 * postback case, and is called by the POD proxy rather than the browser so the
 * postback state never leaves the server.
 */
async function fetchPod(docket) {
  const { html, url } = await fetchPage(docket);
  const parsed = parseTracking(html, url);
  if (!parsed || !parsed.podAvailable) throw new Error('No POD on this consignment');

  if (parsed.podUrl) {
    const r = await fetch(parsed.podUrl, { headers: { 'User-Agent': UA, Referer: url } });
    if (!r.ok) throw new Error(`POD fetch ${r.status}`);
    return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'image/jpeg' };
  }

  const rows = tableRows(html);
  const podRow = rows.find((cells) => cells[0] && /^pod$/i.test(cells[0].text.replace(/[.:]\s*$/, '')));
  const link = podRow && (podRow[1].links.find((l) => /download/i.test(l.label)) || podRow[1].links[0]);
  const pb = link && postBackTarget(link.href);
  if (!pb) throw new Error('POD link not resolvable');

  const res = await postBack(url, html, pb.target, pb.argument);
  if (!res.ok) throw new Error(`POD postback ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (/text\/html/i.test(ct)) throw new Error('POD postback returned a page, not a file');
  return { buffer, contentType: ct || 'image/jpeg' };
}

module.exports = { track, fetchPod, parseTracking, pageUrl, BASE };
