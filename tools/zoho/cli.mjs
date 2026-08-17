#!/usr/bin/env node
// Zoho Mail → CEO operations dashboard.
//
//   node tools/zoho/cli.mjs auth <grant-code>   # one time: grant code -> refresh token
//   node tools/zoho/cli.mjs fetch               # pull mail + bodies -> build/zoho/bundle.json
//   node tools/zoho/cli.mjs render              # bundle.json + analysis.json -> dashboard.html
//
// `fetch` deliberately stops at raw material. The judgement pass — priority,
// whether the CEO must step in, what the situation actually is — happens over
// bundle.json and lands in analysis.json, because it needs reading, not regex.
//
// Credentials come from the environment, never from a committed file:
//   ZOHO_DC (com|in|eu|au|jp|ca, default com), ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
//   ZOHO_REFRESH_TOKEN, ZOHO_SINCE (YYYY-MM-DD, default 2026-08-01)

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  exchangeCode, accessToken, client, drainFolder, mapLimit,
  addressOf, displayNameOf, recipientsOf, receivedAt, isUnread, htmlToText, stripQuotedTail, SCOPES,
} from './zoho-api.mjs';
import { buildTriage } from './triage.mjs';
import { renderDashboard } from './render.mjs';

const env = (k, fallback) => process.env[k] ?? fallback;
const OUT = resolve(env('ZOHO_OUT_DIR', 'build/zoho'));

function creds() {
  const clientId = env('ZOHO_CLIENT_ID');
  const clientSecret = env('ZOHO_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET (see tools/zoho/README.md)');
  }
  return { dc: env('ZOHO_DC', 'com'), clientId, clientSecret };
}

async function cmdAuth(code) {
  if (!code) throw new Error(`usage: cli.mjs auth <grant-code>   (scopes: ${SCOPES})`);
  const res = await exchangeCode({ ...creds(), code });
  if (!res.refresh_token) {
    throw new Error('Zoho returned no refresh_token — regenerate the Self Client code with "Offline" access type');
  }
  console.log(`\nZOHO_REFRESH_TOKEN=${res.refresh_token}\n`);
  console.log('Store that in the environment; it does not expire unless revoked.');
}

function pickFolder(folders, ...names) {
  for (const want of names.map((n) => n.toLowerCase())) {
    const hit = folders.find((f) => String(f.folderName || f.name || '').toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

async function connect() {
  const c = creds();
  const refreshToken = env('ZOHO_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('set ZOHO_REFRESH_TOKEN (run `cli.mjs auth <grant-code>` first)');
  const { access_token } = await accessToken({ ...c, refreshToken });
  const api = client({ dc: c.dc, accessToken: access_token });

  const account = (await api.accounts())?.data?.[0];
  if (!account) throw new Error('Zoho returned no mail accounts for this token');
  const accountId = account.accountId ?? account.account_id;
  const ownEmails = [
    account.primaryEmailAddress,
    account.mailboxAddress,
    ...(Array.isArray(account.emailAddress) ? account.emailAddress.map((e) => e?.mailId ?? e) : []),
  ].map(addressOf).filter(Boolean);

  return { api, accountId, ownEmails, account };
}

async function cmdFetch() {
  const { api, accountId, ownEmails } = await connect();
  console.error(`account: ${ownEmails[0] || accountId}`);

  const sinceDate = env('ZOHO_SINCE', '2026-08-01');
  const since = Date.parse(`${sinceDate}T00:00:00Z`);
  if (!Number.isFinite(since)) throw new Error(`ZOHO_SINCE must be YYYY-MM-DD, got "${sinceDate}"`);

  const folders = (await api.folders(accountId))?.data || [];
  const inboxF = pickFolder(folders, 'inbox');
  const sentF = pickFolder(folders, 'sent', 'sent items', 'sentmail');
  if (!inboxF || !sentF) {
    throw new Error(`could not find Inbox/Sent among folders: ${folders.map((f) => f.folderName).join(', ')}`);
  }

  const [inboxRaw, sentRaw] = await Promise.all([
    drainFolder(api, accountId, inboxF.folderId, { max: 1200, since }),
    drainFolder(api, accountId, sentF.folderId, { max: 1200, since }),
  ]);
  const inWindow = (m) => receivedAt(m) >= since;
  const inbox = inboxRaw.filter(inWindow);
  const sent = sentRaw.filter(inWindow);
  console.error(`in window since ${sinceDate}: ${inbox.length} inbox / ${sent.length} sent`);

  // Every inbox message in the window gets its body read — that is the point of
  // the exercise; the CEO asked for understood, not counted.
  const bodyCap = Number(env('ZOHO_BODY_CAP', 400));
  const toRead = inbox.slice(0, bodyCap);
  if (inbox.length > toRead.length) {
    console.error(`WARNING: reading bodies for ${toRead.length} of ${inbox.length} (ZOHO_BODY_CAP=${bodyCap})`);
  }
  let done = 0;
  const bodies = await mapLimit(toRead, 6, async (m) => {
    const res = await api.content(accountId, m.folderId ?? inboxF.folderId, m.messageId);
    if (++done % 25 === 0) console.error(`  bodies ${done}/${toRead.length}`);
    return htmlToText(res?.data?.content ?? res?.data?.body ?? '');
  });

  const messages = toRead.map((m, i) => {
    const from = addressOf(m.fromAddress || m.sender);
    const body = bodies[i];
    const text = typeof body === 'string' ? stripQuotedTail(body) : '';
    return {
      id: String(m.messageId ?? ''),
      subject: String(m.subject || '(no subject)').trim(),
      from,
      fromName: displayNameOf(m.sender || m.fromAddress, from),
      to: recipientsOf(m),
      ccIncludes: String(m.ccAddress || '').split(/[,;]/).map(addressOf).filter(Boolean),
      receivedAt: receivedAt(m),
      unread: isUnread(m),
      hasAttachment: Boolean(m.hasAttachment && m.hasAttachment !== '0'),
      body: text,
      bodyError: typeof body === 'object' && body?.__error ? body.__error : null,
    };
  });

  const bundle = {
    fetchedAt: Date.now(),
    since,
    sinceDate,
    account: ownEmails[0] || '',
    ownEmails,
    counts: { inbox: inbox.length, sent: sent.length, bodiesRead: messages.filter((m) => m.body).length },
    triage: buildTriage({ inbox, sent, ownEmails, windowDays: Math.ceil((Date.now() - since) / 86400000) }),
    messages,
  };

  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, 'bundle.json'), JSON.stringify(bundle, null, 2));
  console.error(`wrote ${OUT}/bundle.json — ${bundle.counts.bodiesRead} bodies read`);
  console.error(`unreplied: ${bundle.triage.stats.needsReply} · unread: ${bundle.triage.stats.unread}`);
}

async function cmdRender() {
  const bundle = JSON.parse(await readFile(resolve(OUT, 'bundle.json'), 'utf8'));
  let analysis = null;
  try {
    analysis = JSON.parse(await readFile(resolve(OUT, 'analysis.json'), 'utf8'));
  } catch {
    console.error('note: no analysis.json — rendering mechanical view only');
  }
  await writeFile(resolve(OUT, 'dashboard.html'), renderDashboard(bundle, analysis));
  console.error(`wrote ${OUT}/dashboard.html`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'auth') await cmdAuth(rest[0]);
  else if (cmd === 'fetch') await cmdFetch();
  else if (cmd === 'render') await cmdRender();
  else {
    console.error('usage: cli.mjs auth <grant-code> | cli.mjs fetch | cli.mjs render');
    process.exit(1);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
