'use strict';

/**
 * Zero-dependency local dev server.
 *
 *   node dev-server.js          → http://localhost:8888
 *   PORT=3000 node dev-server.js
 *
 * Serves ./public and maps the same /api/* routes that netlify.toml declares
 * onto the function handlers, so the app behaves locally exactly as it does on
 * Netlify. Handler modules are re-required on every request, so editing a
 * function does not need a restart.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8888);
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROUTES = {
  '/api/auth/verify': './netlify/functions/auth.js',
  '/api/track': './netlify/functions/track.js',
  '/api/pod-image': './netlify/functions/pod-image.js',
  '/api/probe': './netlify/functions/probe.js'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Build the event object a Netlify function handler expects. */
function toEvent(req, url, body) {
  const qs = {};
  url.searchParams.forEach((v, k) => {
    qs[k] = v;
  });
  return {
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: qs,
    body,
    path: url.pathname
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = ROUTES[url.pathname];

  if (route) {
    try {
      // Drop the module cache so function edits are picked up without a restart.
      const resolved = require.resolve(route);
      Object.keys(require.cache)
        .filter((k) => k.includes(`${path.sep}netlify${path.sep}functions${path.sep}`))
        .forEach((k) => delete require.cache[k]);
      void resolved;

      const { handler } = require(route);
      const result = await handler(toEvent(req, url, await readBody(req)));
      const headers = result.headers || {};
      res.writeHead(result.statusCode || 200, headers);
      res.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body || '');
    } catch (e) {
      console.error(`[api] ${url.pathname}`, e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    console.log(`${req.method} ${url.pathname} → ${res.statusCode}`);
    return;
  }

  // Static files out of ./public
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    }
    console.log(`${req.method} ${url.pathname} → ${res.statusCode}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n  JMS Courier Tracker — local dev\n  http://localhost:${PORT}\n`);
});
