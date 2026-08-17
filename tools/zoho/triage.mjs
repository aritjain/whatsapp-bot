// Turns raw Zoho Mail message metadata into the triage model the dashboard renders.
//
// Zoho's message-list endpoint does not reliably carry a thread id, so threads
// are reconstructed: group by reply-stripped subject, then merge messages inside
// that group that share any external participant (this keeps reply-all chains
// together without collapsing unrelated "Hi" threads from different people).

import { receivedAt, isUnread, addressOf, displayNameOf, recipientsOf, normalizeSubject } from './zoho-api.mjs';

const DAY = 86400000;

function cluster(messages) {
  const parent = messages.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[rb] = ra;
  };

  const bySubject = new Map();
  messages.forEach((m, i) => {
    const key = m.subjectKey || `__no-subject-${i}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(i);
  });

  for (const idxs of bySubject.values()) {
    const seen = new Map(); // external address -> first message index carrying it
    for (const i of idxs) {
      for (const addr of messages[i].externals) {
        if (seen.has(addr)) union(seen.get(addr), i);
        else seen.set(addr, i);
      }
    }
  }

  const groups = new Map();
  messages.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  return [...groups.values()];
}

function normalize(raw, direction, ownAddresses) {
  const from = addressOf(raw.fromAddress || raw.sender);
  const to = recipientsOf(raw);
  const externals = [from, ...to].filter((a) => a && !ownAddresses.has(a));
  return {
    id: String(raw.messageId ?? raw.msgId ?? ''),
    subject: String(raw.subject || '(no subject)').trim() || '(no subject)',
    subjectKey: normalizeSubject(raw.subject),
    from,
    fromName: displayNameOf(raw.sender || raw.fromAddress, from),
    to,
    externals: [...new Set(externals)],
    at: receivedAt(raw),
    unread: direction === 'in' && isUnread(raw),
    summary: String(raw.summary || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    direction,
  };
}

/**
 * @param inbox    raw Zoho message rows from the Inbox folder
 * @param sent     raw Zoho message rows from the Sent folder
 * @param ownEmails the account's own addresses (and aliases)
 * @param now      epoch ms, injected so output is deterministic and testable
 */
export function buildTriage({ inbox = [], sent = [], ownEmails = [], now = Date.now(), windowDays = 60 }) {
  const own = new Set(ownEmails.map((e) => addressOf(e)).filter(Boolean));
  const cutoff = now - windowDays * DAY;

  const messages = [
    ...inbox.map((m) => normalize(m, 'in', own)),
    ...sent.map((m) => normalize(m, 'out', own)),
  ].filter((m) => Number.isFinite(m.at) && m.at >= cutoff);

  const threads = cluster(messages).map((idxs) => {
    const msgs = idxs.map((i) => messages[i]).sort((a, b) => a.at - b.at);
    const last = msgs[msgs.length - 1];
    const lastInbound = [...msgs].reverse().find((m) => m.direction === 'in') || null;
    const lastOutbound = [...msgs].reverse().find((m) => m.direction === 'out') || null;
    return {
      subject: last.subject,
      counterpart: lastInbound ? lastInbound.fromName : displayNameOf(last.to[0], last.to[0]),
      counterpartAddress: lastInbound ? lastInbound.from : last.to[0] || '',
      messageCount: msgs.length,
      unread: msgs.some((m) => m.unread),
      lastAt: last.at,
      lastDirection: last.direction,
      lastInboundAt: lastInbound?.at ?? null,
      lastOutboundAt: lastOutbound?.at ?? null,
      preview: (lastInbound || last).summary,
    };
  });

  const days = (t) => Math.max(0, Math.floor((now - t) / DAY));

  const needsReply = threads
    .filter((t) => t.lastDirection === 'in')
    .map((t) => ({ ...t, waitingDays: days(t.lastInboundAt) }))
    .sort((a, b) => b.waitingDays - a.waitingDays || Number(b.unread) - Number(a.unread));

  // "Waiting on others": you answered last and nothing has come back for 3+ days,
  // but only for threads they actually started — not one-way broadcasts you sent.
  const waitingOnOthers = threads
    .filter((t) => t.lastDirection === 'out' && t.lastInboundAt !== null && days(t.lastOutboundAt) >= 3)
    .map((t) => ({ ...t, waitingDays: days(t.lastOutboundAt) }))
    .sort((a, b) => b.waitingDays - a.waitingDays);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const respondedPairs = threads
    .filter((t) => t.lastInboundAt !== null && t.lastOutboundAt !== null && t.lastOutboundAt > t.lastInboundAt)
    .map((t) => t.lastOutboundAt - t.lastInboundAt);
  const medianResponseHours = respondedPairs.length
    ? Math.round((respondedPairs.sort((a, b) => a - b)[Math.floor(respondedPairs.length / 2)] / 3600000) * 10) / 10
    : null;

  return {
    generatedAt: now,
    windowDays,
    account: ownEmails[0] || '',
    stats: {
      needsReply: needsReply.length,
      unread: messages.filter((m) => m.unread).length,
      sentToday: messages.filter((m) => m.direction === 'out' && m.at >= todayMs).length,
      receivedToday: messages.filter((m) => m.direction === 'in' && m.at >= todayMs).length,
      waitingOnOthers: waitingOnOthers.length,
      oldestWaitingDays: needsReply.length ? needsReply[0].waitingDays : 0,
      threads: threads.length,
      medianResponseHours,
    },
    needsReply,
    waitingOnOthers,
    // Volume by day, oldest -> newest, for the sparkline strip.
    volume: (() => {
      const buckets = new Map();
      for (let d = 13; d >= 0; d--) {
        const key = new Date(todayMs - d * DAY).toISOString().slice(0, 10);
        buckets.set(key, { date: key, in: 0, out: 0 });
      }
      for (const m of messages) {
        const key = new Date(m.at).toISOString().slice(0, 10);
        const b = buckets.get(key);
        if (b) b[m.direction === 'in' ? 'in' : 'out']++;
      }
      return [...buckets.values()];
    })(),
    topSenders: (() => {
      const counts = new Map();
      for (const m of messages) {
        if (m.direction !== 'in' || !m.from) continue;
        const cur = counts.get(m.from) || { address: m.from, name: m.fromName, count: 0 };
        cur.count++;
        counts.set(m.from, cur);
      }
      return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 8);
    })(),
  };
}
