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
| `offline` | Local delivery — never tracked |

Local carriers (own fleet, nothing to look up): **JMS Trading**, **Kent**,
**SmartShift**. Their rows read `Local` and never hit the network.

| Carrier | Mode | How status is fetched |
|---|---|---|
| Carrier | Mode | Status source | POD |
|---|---|---|---|
| RE Logistics | `api` | `lms.relogi.in` portal (ASP.NET, server-rendered) | **Yes** — direct link or WebForms postback |
| Delhivery | `api` | `delhivery.com/track-v2/lr/<LR>` — embedded page state, then JSON APIs \* | Whatever the payload carries \* |
| Safexpress | `api` | Guessed endpoint \* | Guessed endpoint \* |
| Allcargo | `api` | `allcargologistics.com` API (form-driven, no URL route) \* | **Yes** — page offers Download POD |
| R.V. Express | `api` | Aggregator chain | No |
| Skyking / Quick India | `api` | First-party APIs (carried over, proven) | Yes |
| JMS, Kent, SmartShift | `offline` | **Local — never tracked** | — |
| blank carrier | `offline` | Never tracked | — |

Unrecognised carrier names are also tried through the aggregator using the name
itself, so a new carrier in next month's register still gets a status attempt.

\* **Unverified.** These adapters were written without being able to reach the
upstream hosts — the build environment enforces an egress allowlist. They are
defensive and fail safe, but the response shapes have not been confirmed.

### Where status and POD come from

**Only carrier-native adapters return POD images.** Ship24, 17track,
TrackingMore and AfterShip all return scan events only, so the carrier's own
API is tried first for the three carriers where POD matters:

```
Delhivery / Safexpress / RE Logistics:
   carrier API (status + POD) → Ship24 → 17track → TrackingMore → AfterShip
                              → HTML aggregator → link
everything else:
   Ship24 → 17track → TrackingMore → AfterShip → HTML aggregator → link
```

If the carrier API answers with a POD it wins outright. If it answers without
one, the providers still get a look, so a carrier outage never costs status.

A provider is only used when its API key is set, so unconfigured ones cost
nothing. Order is configurable with `PROVIDER_ORDER`. Every provider that
supports batching uses it — the whole request is fetched in one round trip and
each docket reads the shared result, which matters because all four bill per
tracking number.

Statuses from every source are normalised to one vocabulary — `Delivered`,
`Out for Delivery`, `In Transit`, `Picked Up`, `Booked`, `Awaiting Pickup`,
`Undelivered`, `Not Found` — so the report reads the same regardless of which
provider answered. The carrier's own wording is kept and shown in the tooltip.

If everything fails, the row shows "Lookup failed" with a small ↗ to the
tracking page. There is no "go to carrier site" button in the normal path.

Allcargo's tracking page posts the docket through a form rather than putting it
in the URL, so there is no page to GET — the result comes from an API the page
calls. The adapter tries GET and POST candidates with several body field names;
the real route can be found with `/api/probe?carrier=allcargo`.

Delhivery's `track-v2` route is keyed by **LR number**, which is exactly what
the register's DOCKET NO column holds, so the URL is built straight from the
sheet. Their AWB is a separate identifier and is not needed. The adapter reads
state embedded in the document first, falls back to the rendered timeline, then
to JSON API candidates.

RE Logistics runs Sagar Informatics' LMS on ASP.NET WebForms, so its POD link
is often `__doPostBack(...)` rather than a URL. `lib/aspnet.js` replays that
postback server-side, carrying `__VIEWSTATE` and `__EVENTVALIDATION`, and the
POD proxy streams the bytes back — the browser asks for
`/api/pod-image?carrier=relogistics&docket=<n>` and never sees the form state.

Note that `m.17track.net` is the mobile web app and renders results
client-side, so it cannot be fetched server-side; the integration uses their
API at `api.17track.net`, which needs a free token.

**None of the four provider integrations has been verified against a live
response** — this build environment blocks egress to all of them. Each parser
reads defensively and returns nothing rather than guessing, so an unverified
parser falls through to the next provider instead of showing a wrong status.

### Finding the real carrier endpoints

The carrier-native endpoints in `lib/candidates.js` are guesses — this build
environment cannot reach any carrier host. `/api/probe` does the DevTools work
from the deployed site instead, and is designed to be opened on a phone:

```
https://<your-site>/api/probe?carrier=relogistics&docket=71199373&token=<jwt>
```

It fetches the carrier's tracking page and its JavaScript bundles, extracts
every URL that looks like a tracking or POD API, then tries each known
candidate with a real docket and reports status, content type, size, whether
the response mentions the docket, and whether it is an image. Add
`&format=json` for the raw output. Carriers: `delhivery`, `safexpress`,
`relogistics`.

Getting the token: log in, then in Safari's address bar the session token is in
`localStorage.jms_jwt` — or call `/api/auth/verify` and copy the token.

### Verifying an adapter

Run the probe from a machine with normal internet access:

```bash
node tools/probe.js                                   # one sample per carrier
node tools/probe.js 71199373 "RE LOGISTICS SOLUTIONS" # a single docket
node tools/probe.js --save                            # dump raw bodies
```

It runs the shipped chain against live endpoints and prints both the parsed
result and the raw upstream body.

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
| `DELIVERYTRACKER_ID` | `thedelivid` parameter for the HTML aggregator |
| `SHIP24_KEY` | Ship24 API key (`apik_…`) |
| `SEVENTEENTRACK_KEY` | 17track API token |
| `TRACKINGMORE_KEY` | TrackingMore API key |
| `AFTERSHIP_KEY` | AfterShip API key |
| `PROVIDER_ORDER` | Chain order, default `ship24,17track,trackingmore,aftership` |
| `TRACK_CONCURRENCY` | Parallel upstream requests (default 6) |

## Layout

```
public/index.html              UI, parser, table, export
public/vendor/                 SheetJS + qrcodejs (no CDN)
netlify/functions/auth.js      TOTP / static-key login → JWT
netlify/functions/track.js     Batching, concurrency, routing
netlify/functions/pod-image.js POD proxy (host-allowlisted)
netlify/functions/lib/         Carrier registry, provider chain, JWT helpers
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
