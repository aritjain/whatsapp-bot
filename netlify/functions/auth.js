'use strict';

const crypto = require('crypto');
const { signJWT, cors, json } = require('./lib/auth-jwt');

// Set these as Netlify environment variables. The fallbacks preserve the
// existing credentials so current authenticator entries keep working, but they
// are in source control — rotate them.
const TOTP_SECRET_B32 = process.env.TOTP_SECRET || 'MDCMZ3WRKXJLRSF4BUZ6HXPCT6JTP7LF';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Aritjain04';
const STATIC_ACCESS_KEY = process.env.STATIC_ACCESS_KEY || '8463AB01494B';
const TOKEN_TTL_DAYS = Number(process.env.TOKEN_TTL_DAYS || 7);

function b32decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let val = 0;
  const out = [];
  for (const c of s) {
    const idx = alpha.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function verifyTOTP(code) {
  const key = b32decode(TOTP_SECRET_B32);
  const step = Math.floor(Date.now() / 1000 / 30);
  let ok = false;
  for (let i = -1; i <= 1; i++) {
    const t = step + i;
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(t / 0x100000000), 0);
    buf.writeUInt32BE(t >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[19] & 0xf;
    const otp = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
    if (safeEqual(otp, code)) ok = true; // no early return: keep timing flat
  }
  return ok;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Best-effort in-memory throttle. Netlify recycles function instances, so this
// is a speed bump rather than a guarantee — it still blunts naive brute force.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, until: 0 };
  if (rec.until > now) return true;
  rec.n += 1;
  if (rec.n > 10) {
    rec.n = 0;
    rec.until = now + 60_000;
  }
  attempts.set(ip, rec);
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const ip =
    (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown';
  if (throttled(ip)) return json(429, { error: 'Too many attempts. Wait a minute and try again.' });

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { action, code, password } = body || {};

  if (action === 'getSecret') {
    if (!safeEqual(password || '', ADMIN_PASSWORD)) return json(401, { error: 'Invalid password' });
    return json(200, { secret: TOTP_SECRET_B32, staticKey: STATIC_ACCESS_KEY });
  }

  if (action === 'verify') {
    const c = String(code || '').trim();
    if (!c) return json(400, { error: 'Code required' });
    if (!safeEqual(c, STATIC_ACCESS_KEY) && !verifyTOTP(c)) return json(401, { error: 'Invalid code' });
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_DAYS * 86400;
    return json(200, { token: signJWT({ app: 'jms-tracker', iat: Math.floor(Date.now() / 1000), exp }) });
  }

  return json(400, { error: 'Unknown action' });
};
