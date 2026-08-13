# Handoff — finish the carrier integrations

You are continuing work on this repo from a session that had **no outbound
network access to any carrier or tracking-provider host**. Everything here is
built and tested against fixtures; the remaining work needs a real network,
which is why it moved to this machine.

Read `README.md` first for the architecture. This file is only the to-do.

## Run it

```bash
node dev-server.js      # → http://localhost:8888, no npm install needed
```

Log in with the access key (see `netlify/functions/auth.js`), upload the Sale
Register, press Track All.

## State of play

| Carrier | July lines | Status source | POD | Confidence |
|---|---|---|---|---|
| RE Logistics | 502 | `lms.relogi.in` ASP.NET portal | View/Download links | **Built from the real rendered page** |
| Safexpress | 223 | Guessed endpoints | Unknown | **Pure guesswork** |
| Allcargo | 97 | Form-driven JSON API | Download POD button exists | Route inferred, POD confirmed to exist |
| Delhivery | 81 | `delhivery.com/track-v2/lr/<LR>` | None seen | Route confirmed, payload inferred |
| R.V. Express | 5 | Aggregator chain | Unknown | Untouched |
| JMS, Kent, SmartShift | 330 | **Local — never tracked** | — | Confirmed by the owner |

Nothing in the `api`-mode column has ever seen a live response.

## Task 1 — capture real responses

```bash
node tools/probe.js --save
node tools/probe.js 71197243  "RE LOGISTICS SOLUTIONS"
node tools/probe.js 309020803 "DELHIVERY  LIMITED"
node tools/probe.js 215317329 "ALL CARGO LOGISTICS LIMITED"
```

`--save` writes raw upstream bodies to `probe-out/` (gitignored). The probe
prints both the parsed result and the raw body, which is what the parsers need
to be corrected against.

There is also a deployed-site version at `/api/probe?carrier=<id>&docket=<n>`
that scans a carrier's page **and its JavaScript bundles** for API URLs — use
it for Allcargo, whose route is the main unknown.

## Task 2 — fix each adapter against what came back

- `netlify/functions/lib/relogistics.js` — parses the portal HTML. Watch for:
  the POD link may be `__doPostBack(...)`, handled in `lib/aspnet.js`; the
  postback may also need a session cookie carried from the first GET, which is
  **not** currently implemented. If POD fails with a session error, that is the
  reason.
- `netlify/functions/lib/delhivery.js` — tries embedded page state, then the
  rendered timeline, then JSON APIs. Confirm which one actually works.
- `netlify/functions/lib/allcargo.js` — tries GET then POST candidates. The
  real route is the main unknown; the POD definitely exists.
- `netlify/functions/lib/safexpress.js` — **does not exist yet.** Nothing has
  been seen of this carrier. Track a docket manually first, then write it
  following the shape of `relogistics.js` (HTML portal) or `allcargo.js`
  (JSON API).

Shared helpers in `lib/jsonshape.js` find the scan array, POD URL and headline
status without a hard-coded schema — a JSON carrier usually needs only URLs.

## Task 3 — open questions for the owner

- Delhivery: is there a POD anywhere? The **Order Details** tab was never
  checked. If it is not public, their B2B portal login is the fallback and
  credentials would go in environment variables.
- 23 register lines have a **blank carrier** and are currently untracked.

## Rules that matter

- An adapter must **return null / throw rather than guess**. Wrong statuses on
  a delivery report are worse than a blank. The chain falls through to the next
  provider, then to a link.
- Run the fixture suites after changing a parser — they encode real page
  structure from screenshots, e.g. RE Logistics' postback POD.
- Secrets in `auth.js` and `lib/auth-jwt.js` have plaintext fallbacks that are
  **already compromised** (they were shared in a zip). Moving them to
  environment variables and rotating them is outstanding.
