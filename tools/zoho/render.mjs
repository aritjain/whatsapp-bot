// Renders the CEO mail dashboard from a fetch bundle plus (optionally) the
// judgement pass in analysis.json.
//
// Output is a page fragment — <title>, <style>, then content — so the same file
// works opened locally and published as an Artifact.

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const DAY = 86400000;

function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtDateTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Severity band for "days waiting" — drives the row stripe and the pill label. */
function band(days) {
  if (days >= 14) return { key: 'critical', label: 'stalled' };
  if (days >= 7) return { key: 'serious', label: 'overdue' };
  if (days >= 3) return { key: 'warning', label: 'ageing' };
  return { key: 'ok', label: 'fresh' };
}

function statTile({ label, value, sub, tone = '' }) {
  return `<div class="tile${tone ? ` tile--${tone}` : ''}">
      <span class="tile__label">${esc(label)}</span>
      <span class="tile__value">${esc(value)}</span>
      ${sub ? `<span class="tile__sub">${esc(sub)}</span>` : ''}
    </div>`;
}

/** 14-day received/sent columns. Two series, direct-labelled in the legend. */
function volumeChart(volume) {
  if (!volume?.length) return '';
  const max = Math.max(1, ...volume.map((d) => Math.max(d.in, d.out)));
  const cols = volume
    .map((d) => {
      const day = new Date(`${d.date}T00:00:00Z`);
      const tick = day.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'UTC' });
      return `<div class="vcol" tabindex="0" aria-label="${esc(d.date)}: ${d.in} received, ${d.out} sent">
          <div class="vcol__bars">
            <i class="vbar vbar--in" style="height:${(d.in / max) * 100}%"></i>
            <i class="vbar vbar--out" style="height:${(d.out / max) * 100}%"></i>
          </div>
          <span class="vcol__tick">${esc(tick)}</span>
          <span class="vcol__tip">${esc(d.date)} · ${d.in} in · ${d.out} out</span>
        </div>`;
    })
    .join('');
  return `<section class="panel">
      <div class="panel__head">
        <h2>Volume, last 14 days</h2>
        <div class="legend">
          <span class="legend__item"><i class="swatch swatch--in"></i>Received</span>
          <span class="legend__item"><i class="swatch swatch--out"></i>Sent</span>
        </div>
      </div>
      <div class="vchart">${cols}</div>
    </section>`;
}

function itemRow(item) {
  const days = Number(item.waitingDays ?? 0);
  const b = band(days);
  const pri = String(item.priority || 'P3').toUpperCase();
  const needs = item.interference === 'required';
  return `<article class="row row--${b.key}${needs ? ' row--flagged' : ''}">
      <div class="row__rail" aria-hidden="true"></div>
      <div class="row__main">
        <div class="row__top">
          <span class="pri pri--${esc(pri.toLowerCase())}">${esc(pri)}</span>
          <span class="row__who">${esc(item.fromName || item.from)}</span>
          ${item.company ? `<span class="row__org">${esc(item.company)}</span>` : ''}
          ${item.unread ? '<span class="chip chip--unread">unread</span>' : ''}
          ${item.unreplied ? '<span class="chip">no reply sent</span>' : ''}
        </div>
        <h3 class="row__subject">${esc(item.subject)}</h3>
        ${item.ask ? `<p class="row__ask">${esc(item.ask)}</p>` : ''}
        ${
          needs
            ? `<p class="row__flag"><span class="flag">Needs you</span>${
                item.interferenceWhy ? ` ${esc(item.interferenceWhy)}` : ''
              }</p>`
            : ''
        }
        ${
          item.obs?.answered
            ? `<p class="row__obs"><span class="chip chip--obs">Already answered on OBS</span> ${esc(
                item.obs.note || '',
              )}${item.obs.url ? ` <a href="${esc(item.obs.url)}" rel="noreferrer noopener">reference</a>` : ''}</p>`
            : ''
        }
        ${item.suggestedAction ? `<p class="row__action"><b>Do:</b> ${esc(item.suggestedAction)}</p>` : ''}
      </div>
      <div class="row__meta">
        <span class="row__age">${days}d</span>
        <span class="row__band row__band--${b.key}">${esc(b.label)}</span>
        <span class="row__date">${esc(fmtDate(item.receivedAt))}</span>
        <span class="row__addr">${esc(item.from || '')}</span>
      </div>
    </article>`;
}

/** Fallback when analysis.json is absent: the mechanical unreplied list. */
function mechanicalItems(triage) {
  return (triage?.needsReply || []).map((t) => ({
    priority: 'P3',
    fromName: t.counterpart,
    from: t.counterpartAddress,
    subject: t.subject,
    ask: t.preview,
    unread: t.unread,
    unreplied: true,
    waitingDays: t.waitingDays,
    receivedAt: t.lastInboundAt,
    interference: 'none',
  }));
}

export function renderDashboard(bundle, analysis = null) {
  const triage = bundle?.triage || {};
  const stats = triage.stats || {};
  const items = analysis?.items?.length ? analysis.items : mechanicalItems(triage);

  const byPriority = { P1: [], P2: [], P3: [] };
  for (const it of items) {
    const key = String(it.priority || 'P3').toUpperCase();
    (byPriority[key] || byPriority.P3).push(it);
  }
  for (const k of Object.keys(byPriority)) {
    byPriority[k].sort((a, b) => (b.waitingDays ?? 0) - (a.waitingDays ?? 0));
  }
  const flagged = items.filter((i) => i.interference === 'required').length;
  const obsAnswered = items.filter((i) => i.obs?.answered).length;

  const section = (key, title, note) =>
    byPriority[key].length
      ? `<section class="panel">
          <div class="panel__head">
            <h2>${esc(title)}</h2>
            <span class="panel__count">${byPriority[key].length}</span>
          </div>
          ${note ? `<p class="panel__note">${esc(note)}</p>` : ''}
          <div class="rows">${byPriority[key].map(itemRow).join('')}</div>
        </section>`
      : '';

  const vipList = (analysis?.vips || [])
    .map(
      (v) =>
        `<li><b>${esc(v.name)}</b> <span class="mono">${esc(v.address)}</span>${
          v.company ? ` · ${esc(v.company)}` : ''
        }${v.why ? `<span class="vip__why">${esc(v.why)}</span>` : ''}</li>`,
    )
    .join('');

  const waiting = (triage.waitingOnOthers || []).slice(0, 8);

  return `<title>Mailbox Situation Report</title>
<style>
  :root {
    color-scheme: light;
    --ground: #fbfbf9;
    --surface: #ffffff;
    --sunken: #f4f3ef;
    --ink: #101010;
    --ink-2: #4c4b47;
    --muted: #8a8880;
    --rule: #e3e2db;
    --rule-strong: #c9c8c0;
    --accent: #2a78d6;
    --in: #2a78d6;
    --out: #eb6834;
    --critical: #d03b3b;
    --serious: #ec835a;
    --warning: #fab219;
    --good: #0ca30c;
    --shadow: 0 1px 2px rgba(16,16,16,.05);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --ground: #131312;
      --surface: #1b1b19;
      --sunken: #232320;
      --ink: #f6f5f0;
      --ink-2: #c3c2b7;
      --muted: #8a8880;
      --rule: #2e2e2b;
      --rule-strong: #3f3f3a;
      --accent: #3987e5;
      --in: #3987e5;
      --out: #d95926;
      --critical: #e06a6a;
      --serious: #ec835a;
      --warning: #fab219;
      --good: #35b535;
      --shadow: none;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --ground: #131312;
    --surface: #1b1b19;
    --sunken: #232320;
    --ink: #f6f5f0;
    --ink-2: #c3c2b7;
    --muted: #8a8880;
    --rule: #2e2e2b;
    --rule-strong: #3f3f3a;
    --accent: #3987e5;
    --in: #3987e5;
    --out: #d95926;
    --critical: #e06a6a;
    --serious: #ec835a;
    --warning: #fab219;
    --good: #35b535;
    --shadow: none;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 72px; display: flex; flex-direction: column; gap: 22px; }

  .masthead { display: flex; flex-direction: column; gap: 6px; border-bottom: 2px solid var(--ink); padding-bottom: 14px; }
  .masthead__eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .masthead h1 { margin: 0; font-size: clamp(26px, 4vw, 34px); font-weight: 650; letter-spacing: -.02em; text-wrap: balance; }
  .masthead__meta { font-family: var(--mono); font-size: 12px; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px 16px; }

  .brief { background: var(--surface); border: 1px solid var(--rule); border-left: 3px solid var(--accent); padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow); }
  .brief h2 { margin: 0; font-size: 18px; font-weight: 620; letter-spacing: -.01em; text-wrap: balance; }
  .brief p { margin: 0; color: var(--ink-2); max-width: 68ch; }
  .brief__label { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
  .tile { background: var(--surface); padding: 14px 16px; display: flex; flex-direction: column; gap: 3px; }
  .tile__label { font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .tile__value { font-size: 30px; font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
  .tile__sub { font-size: 12px; color: var(--ink-2); }
  .tile--critical .tile__value { color: var(--critical); }
  .tile--warning .tile__value { color: var(--serious); }

  .panel { background: var(--surface); border: 1px solid var(--rule); box-shadow: var(--shadow); }
  .panel__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--rule); }
  .panel__head h2 { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
  .panel__count { font-family: var(--mono); font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .panel__note { margin: 0; padding: 10px 18px 0; color: var(--ink-2); font-size: 13px; }
  .rows { display: flex; flex-direction: column; }

  .row { display: grid; grid-template-columns: 3px 1fr auto; gap: 0 14px; padding: 0; border-top: 1px solid var(--rule); }
  .row:first-child { border-top: 0; }
  .row__rail { background: transparent; }
  .row--warning .row__rail { background: var(--warning); }
  .row--serious .row__rail { background: var(--serious); }
  .row--critical .row__rail { background: var(--critical); }
  .row--flagged { background: color-mix(in srgb, var(--critical) 5%, var(--surface)); }
  .row__main { padding: 14px 0 14px 4px; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .row__top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .row__who { font-weight: 600; }
  .row__org { font-size: 12.5px; color: var(--muted); }
  .row__subject { margin: 0; font-size: 15px; font-weight: 500; color: var(--ink); text-wrap: balance; }
  .row__ask, .row__flag, .row__obs, .row__action { margin: 0; font-size: 13.5px; color: var(--ink-2); max-width: 72ch; }
  .row__action b { color: var(--ink); font-weight: 600; }
  .row__meta { padding: 14px 18px 14px 0; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; text-align: right; white-space: nowrap; }
  .row__age { font-family: var(--mono); font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .row__band { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .row__band--warning { color: var(--serious); }
  .row__band--serious { color: var(--serious); }
  .row__band--critical { color: var(--critical); }
  .row__date, .row__addr { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  .row__addr { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }

  .pri { font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .06em; padding: 1px 6px; border: 1px solid currentColor; color: var(--muted); }
  .pri--p1 { color: var(--critical); }
  .pri--p2 { color: var(--serious); }

  .chip { font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); background: var(--sunken); border: 1px solid var(--rule); padding: 1px 6px; }
  .chip--unread { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--rule)); }
  .chip--obs { color: var(--good); border-color: color-mix(in srgb, var(--good) 40%, var(--rule)); }
  .flag { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--critical); font-weight: 700; margin-right: 6px; }

  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); }
  .legend__item { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .swatch--in { background: var(--in); }
  .swatch--out { background: var(--out); }

  .vchart { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; align-items: end; padding: 18px; height: 150px; }
  .vcol { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; }
  .vcol__bars { display: flex; align-items: flex-end; gap: 2px; height: 100%; width: 100%; justify-content: center; }
  .vbar { width: 42%; max-width: 16px; display: block; border-radius: 3px 3px 0 0; min-height: 2px; }
  .vbar--in { background: var(--in); }
  .vbar--out { background: var(--out); }
  .vcol__tick { font-family: var(--mono); font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .vcol__tip { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--ground); font-family: var(--mono); font-size: 11px; padding: 4px 8px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .12s; z-index: 2; }
  .vcol:hover .vcol__tip, .vcol:focus-visible .vcol__tip { opacity: 1; }
  .vcol:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .list { margin: 0; padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; list-style: none; }
  .list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 13.5px; color: var(--ink-2); border-bottom: 1px solid var(--rule); padding-bottom: 8px; }
  .list li:last-child { border-bottom: 0; padding-bottom: 0; }
  .list b { color: var(--ink); font-weight: 600; }
  .vip__why { flex-basis: 100%; color: var(--muted); font-size: 12.5px; }
  .mono { font-family: var(--mono); font-size: 12px; color: var(--muted); }

  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 620px) {
    .row { grid-template-columns: 3px 1fr; }
    .row__meta { grid-column: 2; flex-direction: row; align-items: baseline; gap: 10px; padding: 0 0 14px 4px; text-align: left; flex-wrap: wrap; }
    .row__addr { max-width: 100%; }
  }
</style>

<div class="wrap">
  <header class="masthead">
    <span class="masthead__eyebrow">Mailbox operations</span>
    <h1>Situation report${bundle?.account ? ` — ${esc(bundle.account)}` : ''}</h1>
    <div class="masthead__meta">
      <span>Window from ${esc(bundle?.sinceDate || '—')}</span>
      <span>Fetched ${esc(fmtDateTime(bundle?.fetchedAt))}</span>
      <span>${Number(bundle?.counts?.inbox ?? 0)} received · ${Number(bundle?.counts?.sent ?? 0)} sent</span>
      <span>${Number(bundle?.counts?.bodiesRead ?? 0)} read in full</span>
    </div>
  </header>

  ${
    analysis?.situation
      ? `<section class="brief">
          <span class="brief__label">Where things stand</span>
          <h2>${esc(analysis.situation.headline)}</h2>
          ${(analysis.situation.summary || '')
            .split('\n')
            .filter(Boolean)
            .map((p) => `<p>${esc(p)}</p>`)
            .join('')}
        </section>`
      : `<section class="brief">
          <span class="brief__label">Where things stand</span>
          <h2>Mechanical view only</h2>
          <p>No judgement pass has been run against this fetch, so priorities, escalations and the OBS cross-check are absent. The counts and the unreplied list below are computed directly from the mailbox.</p>
        </section>`
  }

  <div class="tiles">
    ${statTile({ label: 'Awaiting reply', value: stats.needsReply ?? 0, sub: 'they spoke last' })}
    ${statTile({ label: 'Unread', value: stats.unread ?? 0, sub: `since ${bundle?.sinceDate || '—'}` })}
    ${statTile({ label: 'P1 open', value: byPriority.P1.length, sub: 'important people involved', tone: byPriority.P1.length ? 'critical' : '' })}
    ${statTile({ label: 'Needs you', value: flagged, sub: 'cannot be delegated', tone: flagged ? 'critical' : '' })}
    ${statTile({ label: 'Oldest waiting', value: `${stats.oldestWaitingDays ?? 0}d`, sub: 'longest unanswered', tone: (stats.oldestWaitingDays ?? 0) >= 7 ? 'warning' : '' })}
    ${statTile({ label: 'Answered on OBS', value: obsAnswered, sub: 'reply with the link' })}
  </div>

  ${section('P1', 'P1 — important people involved', 'From or CC includes someone on the priority list.')}
  ${section('P2', 'P2 — needs a decision')}
  ${section('P3', 'P3 — routine and unreplied')}

  ${
    waiting.length
      ? `<section class="panel">
          <div class="panel__head"><h2>Waiting on others</h2><span class="panel__count">${waiting.length}</span></div>
          <ul class="list">
            ${waiting
              .map(
                (t) =>
                  `<li><b>${esc(t.counterpart)}</b> <span class="mono">${esc(t.counterpartAddress)}</span> · ${esc(
                    t.subject,
                  )} <span class="mono">${t.waitingDays}d since you wrote</span></li>`,
              )
              .join('')}
          </ul>
        </section>`
      : ''
  }

  ${volumeChart(triage.volume)}

  ${
    vipList
      ? `<section class="panel">
          <div class="panel__head"><h2>Priority list in force</h2><span class="panel__count">${
            (analysis.vips || []).length
          }</span></div>
          <ul class="list">${vipList}</ul>
        </section>`
      : ''
  }
</div>`;
}
