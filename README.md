# JMS India — Sale Register Courier Tracker

Upload a monthly Sale Register (`SaleRegister_New`), track every docket by its
**CARRIER NAME**, and pull PODs. Rebuild of the Skyking tracker for the Sale
Register format: carriers are resolved from the carrier column instead of from
docket-number prefixes.

## Run locally

```bash
node dev-server.js          # → http://localhost:8888
PORT=3000 node dev-server.js
```

No install step and no dependencies — SheetJS and qrcodejs are vendored into
`public/vendor/`. The dev server serves `public/` and maps the same `/api/*`
routes that `netlify.toml` declares onto the function handlers, so local
behaviour matches production. Function edits are picked up without a restart.

Log in with the access key or a 6-digit authenticator code.

## How a row is routed

`CARRIER NAME` is matched against the registry in
`netlify/functions/lib/carriers.js`. Each carrier declares one of three modes:

| Mode | Meaning |
|---|---|
| `api` | Server fetches status automatically |
| `link` | Deep link only |
| `offline` | Never tracked |

| Carrier | Mode | How status is fetched |
|---|---|---|
| Delhivery | `api` | `dlv-api.delhivery.com` unified-tracking \* |
| RE Logistics | `api` | Aggregator scrape |
| Safexpress | `api` | Aggregator scrape \* |
| SmartShift | `api` | Aggregator scrape \* |
| Allcargo | `api` | Aggregator scrape \* |
| R.V. Express | `api` | Aggregator scrape \* |
| Skyking / Quick India | `api` | First-party APIs (carried over, proven) |
| **JMS Trading Services** | `offline` | **Never tracked** |
| blank carrier | `offline` | Never tracked |

Unrecognised carrier names are also tried through the aggregator using the name
itself, so a new carrier in next month's register still gets a status attempt.

\* **Unverified.** These adapters were written without being able to reach the
upstream hosts — the build environment enforces an egress allowlist. They are
defensive and fail safe, but the response shapes have not been confirmed.

### Automatic status, with a link as the safety net

Every trackable carrier attempts a real status lookup. If an adapter throws or
returns nothing recognisable, `track.js` catches it and the row falls back to a
deep link, so a broken adapter degrades one row instead of failing the report.

The aggregator scrape ([thedeliverytracker.com](https://thedeliverytracker.com))
covers every carrier through one integration: it takes the carrier name as a URL
parameter. The extractor handles scan tables, two-column summary tables, and
bare status phrases, and treats "no record found" as a negative result.

### Verifying and finalising an adapter

Run the probe on a machine with normal internet access:

```bash
node tools/probe.js                                   # one sample per carrier
node tools/probe.js 71199373 "RE LOGISTICS SOLUTIONS" # a single docket
node tools/probe.js --save                            # dump raw bodies
```

It runs the shipped adapters against live endpoints and prints both the parsed
result and the raw upstream body, which is what an adapter needs to be corrected
against reality.

To replace an aggregator scrape with a carrier's own API: DevTools → Network on
the carrier's tracking page, find the XHR returning the status JSON, then write
an adapter beside `trackSkyking`. The contract is
`async (docket, ctx) => TrackResult`.

## Configuration

All secrets read from environment variables, with fallbacks to the previous
hardcoded values so an existing deployment keeps working. **The fallbacks are in
source control — set these in Netlify and rotate them.**

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs session tokens |
| `TOTP_SECRET` | Base32 authenticator secret |
| `ADMIN_PASSWORD` | Guards the credentials screen |
| `STATIC_ACCESS_KEY` | Permanent login key |
| `TOKEN_TTL_DAYS` | Session lifetime (default 7) |
| `ALLOWED_ORIGIN` | CORS origin (default `*`; set to your domain) |
| `POD_HOST_ALLOWLIST` | Hosts the POD proxy may fetch |
| `DELIVERYTRACKER_ID` | `thedelivid` parameter for the aggregator |
| `TRACK_CONCURRENCY` | Parallel upstream requests (default 6) |

## Layout

```
public/index.html              UI, parser, table, export
public/vendor/                 SheetJS + qrcodejs (no CDN)
netlify/functions/auth.js      TOTP / static-key login → JWT
netlify/functions/track.js     Batching, concurrency, routing
netlify/functions/pod-image.js POD proxy (host-allowlisted)
netlify/functions/lib/         Carrier registry + JWT helpers
dev-server.js                  Local runner
```

## Notes

- The parser locates the header row by looking for the docket and carrier
  columns, so the merged title block, the sub-header row and the trailing
  `Total` row are skipped automatically. Old `LR POD.xlsx` headers are accepted
  as aliases, so both workbook formats load.
- Tracking is deduplicated by docket — July's 1,261 lines are 953 lookups — and
  sent in batches of 25 with 6 concurrent upstream requests.
- Excel export mirrors the register's own columns plus `Status` and `POD Link`.
  Cell styling is deliberately absent: `.s` styles are a SheetJS Pro feature and
  are silently dropped by the community build. Column widths, autofilter and
  hyperlinks do work and are used.
