'use strict';

/**
 * Endpoint probe — run this on a machine with normal internet access.
 *
 *   node tools/probe.js                          # one sample docket per carrier
 *   node tools/probe.js 71199373 "RE LOGISTICS SOLUTIONS"
 *   node tools/probe.js --save                   # also dump raw bodies to ./probe-out
 *
 * For each carrier it runs the adapter that ships in the registry and prints
 * what came back, so an adapter can be corrected against real responses instead
 * of guesswork. Nothing here is used at runtime.
 */

const fs = require('fs');
const path = require('path');
const { resolveCarrier } = require('../netlify/functions/lib/carriers');

const SAMPLES = [
  ['307744222', 'DELHIVERY  LIMITED'],
  ['71199373', 'RE LOGISTICS SOLUTIONS'],
  ['500311046453', 'SAFEXPRESS PVT LIMITED'],
  ['CRN1542661708', 'SMARTSHIFT LOGISTICS SOLUTIONS'],
  ['215317237', 'ALL CARGO LOGISTICS LIMITED'],
  ['381042', 'R.V.EXPRESS PVT. LTD.']
];

const save = process.argv.includes('--save');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const cases = args.length >= 2 ? [[args[0], args.slice(1).join(' ')]] : SAMPLES;

const ctx = {
  _c: new Map(),
  once(k, fn) {
    if (!this._c.has(k)) this._c.set(k, fn());
    return this._c.get(k);
  }
};

(async () => {
  if (save) fs.mkdirSync(path.join(__dirname, '..', 'probe-out'), { recursive: true });

  for (const [docket, carrierName] of cases) {
    const carrier = resolveCarrier(carrierName);
    console.log('\n' + '='.repeat(72));
    console.log(`${carrierName}  docket=${docket}`);
    console.log(`  → id=${carrier.id} mode=${carrier.mode}`);
    if (typeof carrier.link === 'function') console.log(`  → link: ${carrier.link(docket)}`);

    if (carrier.mode !== 'api' || typeof carrier.adapter !== 'function') {
      console.log('  (no adapter — link only)');
      continue;
    }

    // Capture the raw body the adapter sees, for shaping the parser.
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (u, o) => {
      const res = await realFetch(u, o);
      const clone = res.clone();
      clone
        .text()
        .then((t) => bodies.push({ url: String(u), status: res.status, body: t }))
        .catch(() => {});
      return res;
    };

    const t0 = Date.now();
    try {
      const out = await carrier.adapter(docket, ctx);
      console.log(`  ✓ ${Date.now() - t0}ms`);
      console.log('  ' + JSON.stringify(out, null, 2).split('\n').join('\n  '));
    } catch (e) {
      console.log(`  ✗ ${Date.now() - t0}ms — ${e.message}`);
    } finally {
      globalThis.fetch = realFetch;
    }

    for (const b of bodies) {
      console.log(`  ── upstream ${b.status} ${b.url}`);
      console.log('     ' + b.body.slice(0, 400).replace(/\s+/g, ' '));
      if (save) {
        const f = path.join(__dirname, '..', 'probe-out', `${carrier.id}-${docket}.txt`);
        fs.writeFileSync(f, `${b.url}\nHTTP ${b.status}\n\n${b.body}`);
        console.log(`     saved → ${f}`);
      }
    }
  }
  console.log('\nDone. Share probe-out/ (or the printed snippets) to have the adapters finalised.\n');
})();
