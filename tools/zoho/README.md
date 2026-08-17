# Zoho Mail → CEO situation report

Pulls the mailbox, reads every message body in the window, and renders an
operations dashboard: what is unread, what is unreplied, what is P1, and where
the CEO personally has to step in.

The pipeline is deliberately in three parts, because only two of them are
mechanical:

| Step | Command | What it does |
|---|---|---|
| 1. Authorise | `cli.mjs auth <grant-code>` | Swaps a Self Client grant code for a refresh token. Once. |
| 2. Fetch | `cli.mjs fetch` | Pulls Inbox + Sent, reads bodies, writes `build/zoho/bundle.json`. |
| 3. Judge | *(no command)* | Reading `bundle.json` and writing `analysis.json` — priority, escalation, OBS cross-check. Needs a reader, not a regex. |
| 4. Render | `cli.mjs render` | `bundle.json` + `analysis.json` → `build/zoho/dashboard.html`. |

Step 4 works without step 3 — you get the mechanical view (counts and the
unreplied list) with the judgement panels absent and labelled as such.

## Network requirement

**Zoho is not reachable from the Claude Code web sandbox.** The environment's
network policy answers `403` to `CONNECT accounts.zoho.com:443`, and IMAP
port 993 times out. Run `fetch` somewhere with open outbound access — your own
machine — or add `zoho.com` to the environment's allowed hosts
([network policy docs](https://code.claude.com/docs/en/claude-code-on-the-web)).

## Getting credentials

Zoho Mail's REST API is OAuth-only; a mailbox password will not authenticate it.

1. [api-console.zoho.com](https://api-console.zoho.com) → **Self Client** → Create.
2. **Generate Code** tab → scope `ZohoMail.accounts.READ,ZohoMail.messages.READ`,
   duration 10 minutes → copy the code (single use, expires fast).
3. Exchange it:

```bash
export ZOHO_DC=in                 # com | in | eu | au | jp | ca — match your Zoho region
export ZOHO_CLIENT_ID=1000.xxxxx
export ZOHO_CLIENT_SECRET=xxxxx
node tools/zoho/cli.mjs auth 1000.thecodeyoujustcopied
# prints ZOHO_REFRESH_TOKEN=...  -> keep it in your environment
```

The refresh token does not expire unless revoked. **Never commit any of these** —
`build/` is gitignored and no credential is written to disk by these scripts.

## Fetching

```bash
export ZOHO_REFRESH_TOKEN=1000.xxxxx
export ZOHO_SINCE=2026-08-01      # everything received on/after this date
node tools/zoho/cli.mjs fetch
```

Knobs: `ZOHO_BODY_CAP` (default 400) caps how many bodies are read and **warns
loudly** when it truncates; `ZOHO_OUT_DIR` (default `build/zoho`).

Bodies are fetched one request each at concurrency 6 — Zoho throttles parallel
body reads. Quoted reply chains and forwarded tails are stripped so the analysis
reads what each message actually says rather than the thread history repeated in
every reply.

## `analysis.json` shape

```jsonc
{
  "situation": { "headline": "…", "summary": "para\npara" },
  "vips": [{ "name": "…", "address": "…", "company": "…", "why": "…" }],
  "items": [{
    "priority": "P1",              // P1 = a VIP is in From or CC
    "subject": "…", "from": "…", "fromName": "…", "company": "…",
    "receivedAt": 1755000000000, "waitingDays": 9,
    "unread": true, "unreplied": true,
    "ask": "what they actually want",
    "interference": "required",    // required | watch | none
    "interferenceWhy": "why nobody else can close this",
    "obs": { "answered": true, "url": "…", "note": "…" },
    "suggestedAction": "…"
  }]
}
```

## Threading

Zoho's message-list endpoint does not reliably carry a thread id, so threads are
reconstructed: group by reply-stripped subject (`Re:`/`Fwd:`/`AW:`/`RE[2]:` …),
then union messages in that group sharing any external participant. This keeps
reply-all chains together without collapsing unrelated same-subject mails from
different people. A thread is **unreplied** when its newest message is inbound.
