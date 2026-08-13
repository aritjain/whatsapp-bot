'use strict';

const { verifyRequest, cors, json } = require('./lib/auth-jwt');
const { POD_HOST_ALLOWLIST } = require('./lib/carriers');
const reLogistics = require('./lib/relogistics');

// Carriers whose POD cannot be expressed as a plain URL — an ASP.NET postback,
// or anything else needing server-side state. The browser asks for
// ?carrier=<id>&docket=<n> and the resolver returns the bytes.
const POD_RESOLVERS = { relogistics: reLogistics.fetchPod };

const MAX_BYTES = 12 * 1024 * 1024;

/** Only fetch from known POD hosts — otherwise this is an open proxy (SSRF). */
function allowed(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return POD_HOST_ALLOWLIST.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Strip anything that could break out of the Content-Disposition header. */
function safeFilename(s) {
  return String(s || 'POD').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'POD';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (!verifyRequest(event)) return json(401, { error: 'Unauthorized' });

  const { url, docket, carrier } = event.queryStringParameters || {};

  // Carrier-resolved POD (postback or multi-step flow).
  if (carrier) {
    const resolve = POD_RESOLVERS[carrier];
    if (!resolve) return json(400, { error: `No POD resolver for ${carrier}` });
    if (!docket) return json(400, { error: 'Missing docket' });
    try {
      const { buffer, contentType } = await resolve(docket);
      if (buffer.length > MAX_BYTES) return json(413, { error: 'POD too large' });
      return {
        statusCode: 200,
        headers: {
          ...cors,
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${safeFilename(docket)}.${/pdf/i.test(contentType) ? 'pdf' : 'jpg'}"`
        },
        body: buffer.toString('base64'),
        isBase64Encoded: true
      };
    } catch (e) {
      return json(502, { error: e.message });
    }
  }

  if (!url) return json(400, { error: 'Missing url or carrier' });
  if (!allowed(url)) return json(403, { error: 'URL host not allowed' });

  try {
    const r = await fetch(url, {
      headers: { Referer: 'https://skyking.co/', 'User-Agent': 'Mozilla/5.0', Origin: 'https://skyking.co' },
      redirect: 'follow'
    });
    if (!r.ok) return json(r.status, { error: `Upstream error: ${r.status}` });

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return json(413, { error: 'POD too large' });

    const ct = r.headers.get('content-type') || 'application/pdf';
    const ext = ct.includes('pdf') ? 'pdf' : 'jpg';
    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': ct,
        'Content-Disposition': `attachment; filename="${safeFilename(docket)}.${ext}"`
      },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (e) {
    return json(502, { error: e.message });
  }
};
