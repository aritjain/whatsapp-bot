'use strict';

const crypto = require('crypto');

// Secrets come from Netlify environment variables. The fallbacks keep an
// existing deployment working, but they are present in source control and must
// be treated as compromised — set the env vars and rotate.
const JWT_SECRET = process.env.JWT_SECRET || '86c897b3dba156edddbb1ffe6412a46b76271a17619b90e540f78e1fc6c3dd1e';

function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function signJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Verify the Bearer token on an incoming Netlify function event. */
function verifyRequest(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  try {
    const [head, body, sig] = auth.slice(7).split('.');
    if (!head || !body || !sig) return false;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const payload = JSON.parse(b64uDecode(body).toString());
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

const cors = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

module.exports = { JWT_SECRET, signJWT, verifyRequest, cors, json };
