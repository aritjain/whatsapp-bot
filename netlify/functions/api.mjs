// JMS Chief-of-Staff v2 — single backend function.
// Auth (phone + password), role-scoped data API on Netlify Blobs, v1 migration.
// Members only ever receive their own tasks; personal/phonebook docs are never
// read while serving a member request.

import { getStore } from '@netlify/blobs';
import {
  scryptSync, randomBytes, timingSafeEqual, createHmac,
} from 'node:crypto';

/* ---------------- store ---------------- */
const DOCS = {
  config: 'meta/config',
  loginFail: 'meta/login-failures',
  users: 'users',
  groups: 'data/groups',
  contacts: 'data/contacts',
  tasks: 'data/tasks',
  personal: 'data/personal',
  phonebook: 'data/phonebook',
};

function store() {
  if (globalThis.__JMS_TEST_STORE__) return globalThis.__JMS_TEST_STORE__;
  return getStore({ name: 'jms', consistency: 'strong' });
}

async function readDocMeta(key, fallback) {
  try {
    const res = await store().getWithMetadata(key, { type: 'json' });
    if (res && res.data !== null && res.data !== undefined) {
      return { value: res.data, etag: res.etag };
    }
  } catch { /* missing key */ }
  return { value: structuredClone(fallback), etag: null };
}
async function readDoc(key, fallback) { return (await readDocMeta(key, fallback)).value; }

async function rawSet(key, value, opts) {
  return store().set(key, JSON.stringify(value), opts);
}

// Read-modify-write with etag retry; falls back to unconditional write if the
// runtime doesn't support conditional ops.
async function casWrite(key, fallback, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value, etag } = await readDocMeta(key, fallback);
    const next = mutate(value);
    try {
      const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const res = await rawSet(key, next, opts);
      if (res && res.modified === false) continue; // etag conflict → retry
      return next;
    } catch {
      await rawSet(key, next); // conditional writes unsupported → last-write
      return next;
    }
  }
  const { value } = await readDocMeta(key, fallback);
  const next = mutate(value);
  await rawSet(key, next);
  return next;
}

/* ---------------- shared helpers (keep normPhone identical to client) ---------------- */
export function normPhone(raw) {
  const s = String(raw || '').trim();
  const plus = s.startsWith('+');
  let d = s.replace(/[^0-9]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!plus && d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!plus && d.length === 10 && /^[6-9]/.test(d)) d = '91' + d;
  return d;
}
export function phoneOk(raw) {
  const s = String(raw || '').trim();
  const plus = s.startsWith('+');
  const d = normPhone(raw);
  if (d.length < 11 || d.length > 15) return false;
  if (d.startsWith('91')) return d.length === 12 && /^[6-9]/.test(d.slice(2)); // Indian mobile
  if (plus || d.length >= 11) return true; // international with country code
  return false;
}
const uid = () => Date.now().toString(36) + randomBytes(4).toString('hex');
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

/* ---------------- auth ---------------- */
async function getSecret() {
  if (process.env.JMS_AUTH_SECRET) return process.env.JMS_AUTH_SECRET;
  let cfg = await readDoc(DOCS.config, null);
  if (!cfg || !cfg.secret) {
    cfg = { secret: randomBytes(32).toString('base64url'), createdAt: Date.now() };
    await casWrite(DOCS.config, null, (cur) => (cur && cur.secret ? cur : cfg));
    cfg = await readDoc(DOCS.config, cfg);
  }
  return cfg.secret;
}
const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function hmac(payload, secret) { return createHmac('sha256', secret).update(payload).digest('base64url'); }

async function signToken(user) {
  const secret = await getSecret();
  const payload = b64u({ uid: user.id, role: user.role, tv: user.tokenVersion || 0, exp: Date.now() + 30 * 24 * 3600 * 1000 });
  return payload + '.' + hmac(payload, secret);
}
async function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const secret = await getSecret();
  const expect = hmac(payload, secret);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.uid || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(String(password), salt, 32).toString('base64url');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = String(stored).split(':');
    const calc = scryptSync(String(password), salt, 32);
    const want = Buffer.from(hash, 'base64url');
    return calc.length === want.length && timingSafeEqual(calc, want);
  } catch { return false; }
}

async function requireAuth(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const claims = await verifyToken(token);
  if (!claims) return null;
  const users = await readDoc(DOCS.users, []);
  const user = users.find((u) => u.id === claims.uid);
  if (!user || user.disabled) return null;
  if ((claims.tv || 0) !== (user.tokenVersion || 0)) return null; // revoked by reset/disable
  return user;
}

/* login throttling: 5 failures per phone → 10-minute lock */
async function loginLocked(np) {
  const fails = await readDoc(DOCS.loginFail, {});
  const f = fails[np];
  return !!(f && f.n >= 5 && Date.now() < f.until);
}
async function recordLoginFail(np) {
  await casWrite(DOCS.loginFail, {}, (fails) => {
    const f = fails[np] || { n: 0, lastAt: 0, until: 0 };
    f.n = (Date.now() - f.lastAt < 3600000 ? f.n : 0) + 1;
    f.lastAt = Date.now();
    if (f.n >= 5) f.until = Date.now() + 10 * 60 * 1000;
    fails[np] = f;
    return fails;
  });
}
async function clearLoginFail(np) {
  await casWrite(DOCS.loginFail, {}, (fails) => { delete fails[np]; return fails; });
}

const safeUser = (u) => ({
  id: u.id, name: u.name, phone: u.phone, normPhone: u.normPhone,
  role: u.role, contactId: u.contactId || null, disabled: !!u.disabled, createdAt: u.createdAt,
});

/* ---------------- backups ---------------- */
async function ensureDailyBackup(forceKeySuffix) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = 'backup/' + day + (forceKeySuffix || '');
    if (!forceKeySuffix) {
      const existing = await readDoc(key, null);
      if (existing) return;
    }
    const [users, groups, contacts, tasks, personal, phonebook] = await Promise.all([
      readDoc(DOCS.users, []), readDoc(DOCS.groups, []), readDoc(DOCS.contacts, []),
      readDoc(DOCS.tasks, []), readDoc(DOCS.personal, []), readDoc(DOCS.phonebook, []),
    ]);
    await rawSet(key, { ts: Date.now(), users, groups, contacts, tasks, personal, phonebook });
    const { blobs } = await store().list({ prefix: 'backup/' });
    const keys = blobs.map((b) => b.key).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 30))) await store().delete(k);
  } catch { /* backups are best-effort */ }
}

/* ---------------- scoped snapshots ---------------- */
async function scopeSnapshot(user) {
  if (user.role === 'admin') {
    const [groups, contacts, tasks, personal, users] = await Promise.all([
      readDoc(DOCS.groups, []), readDoc(DOCS.contacts, []), readDoc(DOCS.tasks, []),
      readDoc(DOCS.personal, []), readDoc(DOCS.users, []),
    ]);
    return { groups, contacts, tasks, personal, users: users.map(safeUser) };
  }
  // member: physically never read personal/phonebook/users docs
  const [groups, contacts, tasks] = await Promise.all([
    readDoc(DOCS.groups, []), readDoc(DOCS.contacts, []), readDoc(DOCS.tasks, []),
  ]);
  const mine = tasks.filter((t) => t.contactId && t.contactId === user.contactId);
  const gids = new Set(mine.map((t) => t.groupId));
  const own = contacts.find((c) => c.id === user.contactId);
  // display names only (first name) for users referenced by the member's own tasks
  const uids = new Set();
  for (const t of mine) {
    if (t.createdBy) uids.add(t.createdBy);
    if (t.verifiedBy) uids.add(t.verifiedBy);
    for (const a of (t.activity || [])) if (a.uid) uids.add(a.uid);
  }
  const users = await readDoc(DOCS.users, []);
  const names = {};
  for (const u of users) if (uids.has(u.id)) names[u.id] = String(u.name || '').split(/\s+/)[0];
  return {
    groups: groups.filter((g) => gids.has(g.id)).map((g) => ({ id: g.id, name: g.name, type: g.type, color: g.color })),
    contacts: own ? [own] : [],
    tasks: mine,
    names,
  };
}
async function syncResponse(user) {
  return json({ user: safeUser(user), data: await scopeSnapshot(user), serverTime: Date.now() });
}

/* ---------------- activity ---------------- */
function appendActivity(task, ev) {
  task.activity = Array.isArray(task.activity) ? task.activity : [];
  task.activity.push({ ts: Date.now(), ...ev });
}

/* ---------------- push ops ---------------- */
const ADMIN_COLS = { groups: DOCS.groups, contacts: DOCS.contacts, tasks: DOCS.tasks, personal: DOCS.personal };

async function handlePush(req, user) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [];
  if (!ops.length) return syncResponse(user);
  await ensureDailyBackup();
  const rejected = [];

  // group ops per collection so each doc is written once
  const taskOps = [];
  const colOps = { groups: [], contacts: [], personal: [] };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    const isTaskOp = ['status', 'comment', 'remind'].includes(op.t)
      || (['upsert', 'delete'].includes(op.t) && op.col === 'tasks');
    if (user.role !== 'admin') {
      if (!['status', 'comment'].includes(op.t)) { rejected.push({ i, reason: 'not allowed' }); continue; }
      taskOps.push({ i, op });
      continue;
    }
    if (isTaskOp) taskOps.push({ i, op });
    else if (['upsert', 'delete'].includes(op.t) && colOps[op.col]) colOps[op.col].push({ i, op });
    else if (op.t === 'pbMerge') colOps.pb = (colOps.pb || []).concat([{ i, op }]);
    else rejected.push({ i, reason: 'unknown op' });
  }

  if (taskOps.length) {
    await casWrite(DOCS.tasks, [], (tasks) => {
      for (const { i, op } of taskOps) {
        const idx = tasks.findIndex((t) => t.id === (op.id || op.rec?.id));
        const old = idx >= 0 ? tasks[idx] : null;
        if (op.t === 'status') {
          if (!old) { rejected.push({ i, reason: 'no such task' }); continue; }
          if (user.role !== 'admin') {
            if (old.contactId !== user.contactId) { rejected.push({ i, reason: 'not your task' }); continue; }
            if (!['open', 'inprogress', 'awaiting_verify'].includes(op.to)) { rejected.push({ i, reason: 'status not allowed' }); continue; }
          }
          if (!['open', 'inprogress', 'awaiting_verify', 'done'].includes(op.to)) { rejected.push({ i, reason: 'bad status' }); continue; }
          const verified = op.to === 'done' && old.status === 'awaiting_verify';
          old.status = op.to;
          old.doneAt = op.to === 'done' ? Date.now() : old.doneAt;
          if (op.to !== 'done' && op.to !== 'awaiting_verify') old.doneAt = null;
          if (verified) old.verifiedBy = user.id;
          old.updatedAt = Date.now(); old.updatedBy = user.id;
          appendActivity(old, { uid: user.id, type: verified ? 'verified' : 'status', data: { to: op.to } });
          if (op.to === 'done' && old.repeat && old.repeat !== 'none' && old.deadline && op.roll) {
            appendActivity(old, { uid: user.id, type: 'recurred', data: { periodDue: old.deadline, completedAt: Date.now() } });
            old.deadline = op.nextDeadline || old.deadline;
            old.status = 'open'; old.doneAt = null;
          }
        } else if (op.t === 'comment') {
          if (!old) { rejected.push({ i, reason: 'no such task' }); continue; }
          if (user.role !== 'admin' && old.contactId !== user.contactId) { rejected.push({ i, reason: 'not your task' }); continue; }
          const text = String(op.text || '').slice(0, 2000);
          if (!text) { rejected.push({ i, reason: 'empty comment' }); continue; }
          old.updatedAt = Date.now(); old.updatedBy = user.id;
          appendActivity(old, { uid: user.id, type: 'comment', data: { text } });
        } else if (op.t === 'remind') {
          const ids = Array.isArray(op.ids) ? op.ids : [];
          for (const id of ids) {
            const t = tasks.find((x) => x.id === id);
            if (!t) continue;
            t.lastRemindedAt = Date.now();
            t.remindCount = (t.remindCount || 0) + 1;
            t.updatedAt = Date.now(); t.updatedBy = user.id;
            appendActivity(t, { uid: user.id, type: 'reminded' });
          }
        } else if (op.t === 'upsert') {
          const rec = op.rec || {};
          if (!rec.id) { rejected.push({ i, reason: 'no id' }); continue; }
          // LWW with tolerance: server stamps updatedAt with its own clock while
          // clients stamp with theirs, so only reject writes that are stale by
          // more than 5 minutes (a genuinely old offline edit), not by the
          // debounce window or minor clock skew.
          if (old && (old.updatedAt || 0) - (rec.updatedAt || 0) > 300000) { rejected.push({ i, reason: 'stale' }); continue; }
          const clean = {
            id: rec.id,
            title: String(rec.title || '').slice(0, 500),
            notes: String(rec.notes || '').slice(0, 4000),
            groupId: rec.groupId || null,
            contactId: rec.contactId || null,
            priority: ['P1', 'P2', 'P3', 'P4'].includes(rec.priority) ? rec.priority : 'P2',
            deadline: rec.deadline || null,
            repeat: rec.repeat || 'none',
            status: ['open', 'inprogress', 'awaiting_verify', 'done'].includes(rec.status) ? rec.status : 'open',
            createdAt: old ? old.createdAt : (rec.createdAt || Date.now()),
            createdBy: old ? old.createdBy : user.id,
            doneAt: rec.status === 'done' ? (old?.doneAt || rec.doneAt || Date.now()) : null,
            verifiedBy: old?.verifiedBy || null,
            lastRemindedAt: old?.lastRemindedAt || null,
            remindCount: old?.remindCount || 0,
            updatedAt: Date.now(), updatedBy: user.id,
            activity: old?.activity || [],
          };
          if (!old) appendActivity(clean, { uid: user.id, type: 'created' });
          else {
            if (old.contactId !== clean.contactId) appendActivity(clean, { uid: user.id, type: 'assigned', data: { to: clean.contactId } });
            if (old.status !== clean.status) appendActivity(clean, { uid: user.id, type: 'status', data: { to: clean.status } });
            else appendActivity(clean, { uid: user.id, type: 'edited' });
          }
          if (idx >= 0) tasks[idx] = clean; else tasks.push(clean);
        } else if (op.t === 'delete') {
          if (idx >= 0) tasks.splice(idx, 1);
        }
      }
      return tasks;
    });
  }

  for (const col of ['groups', 'contacts', 'personal']) {
    const list = colOps[col];
    if (!list || !list.length) continue;
    await casWrite(ADMIN_COLS[col], [], (docs) => {
      for (const { i, op } of list) {
        const id = op.id || op.rec?.id;
        const idx = docs.findIndex((r) => r.id === id);
        if (op.t === 'delete') { if (idx >= 0) docs.splice(idx, 1); continue; }
        const rec = { ...op.rec };
        if (!rec.id) { rejected.push({ i, reason: 'no id' }); continue; }
        if (idx >= 0 && (docs[idx].updatedAt || 0) - (rec.updatedAt || 0) > 300000) { rejected.push({ i, reason: 'stale' }); continue; }
        if (col === 'contacts') {
          rec.normPhone = normPhone(rec.phone);
          rec.phoneOk = phoneOk(rec.phone);
          rec.memberships = Array.isArray(rec.memberships) ? rec.memberships : [];
        }
        rec.updatedAt = Date.now(); rec.updatedBy = user.id;
        if (idx >= 0) docs[idx] = rec; else docs.push(rec);
      }
      return docs;
    });
  }

  if (colOps.pb && colOps.pb.length) {
    await casWrite(DOCS.phonebook, [], (pb) => {
      const seen = new Map(pb.map((c) => [c.normPhone || normPhone(c.phone), c]));
      for (const { op } of colOps.pb) {
        for (const e of (op.entries || [])) {
          const np = normPhone(e.phone);
          if (!np || seen.has(np)) continue;
          const entry = { name: String(e.name || '').slice(0, 200), phone: e.phone, normPhone: np };
          pb.push(entry); seen.set(np, entry);
        }
      }
      return pb;
    });
  }

  const res = await scopeSnapshot(user);
  return json({ user: safeUser(user), data: res, rejected, serverTime: Date.now() });
}

/* ---------------- v1 migration ---------------- */
export function migrateV1(old) {
  const now = Date.now();
  const groups = (old.groups || []).map((g) => ({ ...g, updatedAt: g.updatedAt || now }));
  const contacts = [];
  const byPhone = new Map();
  const remap = {};
  for (const p of (old.people || [])) {
    const np = normPhone(p.phone);
    let c = np ? byPhone.get(np) : null;
    if (!c) {
      c = {
        id: p.id, name: p.name, phone: p.phone, normPhone: np, phoneOk: phoneOk(p.phone),
        memberships: [], updatedAt: now, updatedBy: null,
      };
      contacts.push(c);
      if (np) byPhone.set(np, c);
    }
    if (p.groupId && !c.memberships.some((m) => m.groupId === p.groupId)) {
      c.memberships.push({ groupId: p.groupId, role: p.role || '' });
    } else if (p.role && !c.memberships.some((m) => m.role)) {
      const m = c.memberships.find((x) => x.groupId === p.groupId);
      if (m && !m.role) m.role = p.role;
    }
    remap[p.id] = c.id;
  }
  let remapped = 0;
  const tasks = (old.tasks || []).map((t) => {
    const contactId = t.personId ? (remap[t.personId] || null) : null;
    if (t.personId && contactId !== t.personId) remapped++;
    const task = {
      id: t.id, title: t.title, notes: t.notes || '', groupId: t.groupId || null,
      contactId, priority: t.priority || 'P2', deadline: t.deadline || null,
      repeat: t.repeat || 'none',
      status: ['open', 'inprogress', 'done'].includes(t.status) ? t.status : 'open',
      createdAt: t.createdAt || now, createdBy: null,
      doneAt: t.doneAt || null, verifiedBy: null,
      lastRemindedAt: null, remindCount: 0,
      updatedAt: t.doneAt || t.createdAt || now, updatedBy: null,
      activity: [{ ts: t.createdAt || now, uid: null, type: 'created' }],
    };
    if (t.doneAt) task.activity.push({ ts: t.doneAt, uid: null, type: 'status', data: { to: 'done' } });
    return task;
  });
  const personal = (old.personal || []).map((t) => ({ ...t, updatedAt: t.updatedAt || t.createdAt || now }));
  const pbSeen = new Set();
  const phonebook = [];
  for (const e of (old.phonebook || [])) {
    const np = normPhone(e.phone);
    if (!np || pbSeen.has(np)) continue;
    pbSeen.add(np);
    phonebook.push({ name: e.name, phone: e.phone, normPhone: np });
  }
  return {
    groups, contacts, tasks, personal, phonebook,
    report: {
      peopleRows: (old.people || []).length,
      contacts: contacts.length,
      tasksRemapped: remapped,
      phonebookDeduped: (old.phonebook || []).length - phonebook.length,
    },
  };
}

function isV1Shape(d) { return d && Array.isArray(d.groups) && !d.contacts; }

async function handleImport(req, user) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const data = body.data || body;
  if (!data || !Array.isArray(data.groups)) return json({ error: 'Not a valid backup file' }, 400);
  // full snapshot immediately before every import, not just the daily one
  await ensureDailyBackup('-preimport-' + new Date().toISOString().slice(11, 19).replace(/:/g, ''));
  const incoming = isV1Shape(data) ? migrateV1(data) : {
    groups: data.groups || [], contacts: data.contacts || [], tasks: data.tasks || [],
    personal: data.personal || [], phonebook: data.phonebook || [],
    report: { peopleRows: 0, contacts: (data.contacts || []).length, tasksRemapped: 0, phonebookDeduped: 0 },
  };
  const report = { ...incoming.report, merged: {}, migratedFromV1: isV1Shape(data) };

  // contacts first: build normPhone remap against existing contacts
  const contactRemap = {};
  await casWrite(DOCS.contacts, [], (cur) => {
    const byId = new Map(cur.map((c) => [c.id, c]));
    const byPhone = new Map(cur.filter((c) => c.normPhone).map((c) => [c.normPhone, c]));
    let added = 0, mergedN = 0;
    for (const inc of incoming.contacts) {
      const match = byId.get(inc.id) || (inc.normPhone && byPhone.get(inc.normPhone));
      if (!match) {
        cur.push(inc); byId.set(inc.id, inc);
        if (inc.normPhone) byPhone.set(inc.normPhone, inc);
        contactRemap[inc.id] = inc.id; added++;
      } else {
        contactRemap[inc.id] = match.id; mergedN++;
        for (const m of (inc.memberships || [])) {
          if (!match.memberships.some((x) => x.groupId === m.groupId)) match.memberships.push(m);
        }
        if ((inc.updatedAt || 0) > (match.updatedAt || 0)) {
          match.name = inc.name; match.phone = inc.phone;
          match.normPhone = inc.normPhone; match.phoneOk = inc.phoneOk;
          match.updatedAt = inc.updatedAt;
        }
      }
    }
    report.merged.contacts = { added, merged: mergedN };
    return cur;
  });

  const mergeById = (cur, inc, label) => {
    const byId = new Map(cur.map((r) => [r.id, r]));
    let added = 0, updated = 0, kept = 0;
    for (const rec of inc) {
      const old = byId.get(rec.id);
      if (!old) { cur.push(rec); byId.set(rec.id, rec); added++; } else if ((rec.updatedAt || 0) > (old.updatedAt || 0)) {
        Object.assign(old, rec); updated++;
      } else kept++;
    }
    report.merged[label] = { added, updated, kept };
    return cur;
  };

  await casWrite(DOCS.groups, [], (cur) => mergeById(cur, incoming.groups, 'groups'));
  await casWrite(DOCS.tasks, [], (cur) => mergeById(cur, incoming.tasks.map((t) => ({
    ...t,
    contactId: t.contactId ? (contactRemap[t.contactId] || t.contactId) : null,
    createdBy: t.createdBy || user.id,
  })), 'tasks'));
  await casWrite(DOCS.personal, [], (cur) => mergeById(cur, incoming.personal, 'personal'));
  await casWrite(DOCS.phonebook, [], (pb) => {
    const seen = new Set(pb.map((c) => c.normPhone || normPhone(c.phone)));
    let added = 0;
    for (const e of incoming.phonebook) {
      if (!e.normPhone || seen.has(e.normPhone)) continue;
      pb.push(e); seen.add(e.normPhone); added++;
    }
    report.merged.phonebook = { added };
    return pb;
  });

  // link users → contacts by phone where missing
  const contacts = await readDoc(DOCS.contacts, []);
  await casWrite(DOCS.users, [], (users) => {
    for (const u of users) {
      if (!u.contactId) {
        const c = contacts.find((x) => x.normPhone === u.normPhone);
        if (c) u.contactId = c.id;
      }
    }
    return users;
  });

  const fresh = await readDoc(DOCS.users, []);
  const me = fresh.find((u) => u.id === user.id) || user;
  return json({ report, user: safeUser(me), data: await scopeSnapshot(me), serverTime: Date.now() });
}

/* ---------------- users admin ---------------- */
async function handleUsers(req, user) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const action = body.action || 'create';
  await ensureDailyBackup();
  let error = null;
  let users = await readDoc(DOCS.users, []);

  if (action === 'create') {
    const np = normPhone(body.phone);
    if (!body.name || !np) error = 'Name and valid phone required';
    else if (String(body.password || '').length < 8) error = 'Password must be at least 8 characters';
    else if (users.some((u) => u.normPhone === np)) error = 'A user with this phone already exists';
    if (error) return json({ error }, 400);
    let contactId = body.contactId || null;
    const contacts = await readDoc(DOCS.contacts, []);
    if (!contactId) {
      const c = contacts.find((x) => x.normPhone === np);
      contactId = c ? c.id : null;
    }
    if (!contactId) {
      const c = {
        id: uid(), name: body.name, phone: body.phone, normPhone: np,
        phoneOk: phoneOk(body.phone), memberships: [], updatedAt: Date.now(), updatedBy: user.id,
      };
      await casWrite(DOCS.contacts, [], (cur) => { cur.push(c); return cur; });
      contactId = c.id;
    }
    const nu = {
      id: uid(), name: body.name, phone: body.phone, normPhone: np, role: 'member',
      contactId, hash: hashPassword(body.password), disabled: false,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    users = await casWrite(DOCS.users, [], (cur) => {
      if (cur.some((u) => u.normPhone === np)) return cur;
      cur.push(nu); return cur;
    });
  } else {
    const target = users.find((u) => u.id === body.userId);
    if (!target) return json({ error: 'No such user' }, 404);
    if (target.role === 'admin' && ['disable'].includes(action)) return json({ error: 'Cannot disable the admin' }, 400);
    users = await casWrite(DOCS.users, [], (cur) => {
      const t = cur.find((u) => u.id === body.userId);
      if (!t) return cur;
      if (action === 'resetPassword') {
        if (String(body.password || '').length >= 8) {
          t.hash = hashPassword(body.password);
          t.tokenVersion = (t.tokenVersion || 0) + 1; // revoke existing sessions
        }
      } else if (action === 'disable') { t.disabled = true; t.tokenVersion = (t.tokenVersion || 0) + 1; }
      else if (action === 'enable') t.disabled = false;
      else if (action === 'update') {
        if (body.name) t.name = body.name;
        if (body.contactId !== undefined) t.contactId = body.contactId || null;
      }
      t.updatedAt = Date.now();
      return cur;
    });
  }
  return json({ users: users.map(safeUser) });
}

/* ---------------- router ---------------- */
export default async function handler(req) {
  const url = new URL(req.url);
  let path = url.pathname;
  path = path.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';
  const method = req.method.toUpperCase();

  // Deploy previews of a public repo must never reach the live store: an
  // attacker's PR could ship its own function code. Only production (and
  // local `netlify dev`) may serve the API; set JMS_ALLOW_NONPROD=1 to
  // deliberately open branch deploys.
  const ctx = process.env.CONTEXT;
  if (ctx && ctx !== 'production' && ctx !== 'dev' && !process.env.JMS_ALLOW_NONPROD) {
    return json({ error: 'API disabled outside production deploys' }, 403);
  }

  try {
    if (path === '/ping') return json({ ok: true, ts: Date.now() });

    if (path === '/state' && method === 'GET') {
      const users = await readDoc(DOCS.users, []);
      return json({ bootstrapped: users.length > 0 });
    }

    if (path === '/bootstrap' && method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
      const users = await readDoc(DOCS.users, []);
      if (users.length) return json({ error: 'Already set up' }, 409);
      const np = normPhone(body.phone);
      if (!body.name || !np) return json({ error: 'Name and valid phone required' }, 400);
      if (String(body.password || '').length < 10) return json({ error: 'Admin password must be at least 10 characters' }, 400);
      await getSecret();
      const admin = {
        id: uid(), name: body.name, phone: body.phone, normPhone: np, role: 'admin',
        contactId: null, hash: hashPassword(body.password), disabled: false,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const after = await casWrite(DOCS.users, [], (cur) => (cur.length ? cur : [admin]));
      const me = after.find((u) => u.role === 'admin');
      if (!me || me.id !== admin.id) return json({ error: 'Already set up' }, 409);
      return json({ token: await signToken(admin), user: safeUser(admin) });
    }

    if (path === '/login' && method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
      const users = await readDoc(DOCS.users, []);
      if (!users.length) return json({ error: 'Not set up yet', bootstrapped: false }, 401);
      const np = normPhone(body.phone);
      if (await loginLocked(np)) return json({ error: 'Too many attempts — try again in 10 minutes', bootstrapped: true }, 429);
      const user = users.find((u) => u.normPhone === np);
      if (!user || user.disabled || !verifyPassword(body.password, user.hash)) {
        await recordLoginFail(np);
        return json({ error: 'Phone number or password incorrect', bootstrapped: true }, 401);
      }
      await clearLoginFail(np);
      return json({ token: await signToken(user), user: safeUser(user) });
    }

    const user = await requireAuth(req);
    if (!user) {
      const users = await readDoc(DOCS.users, []);
      return json({ error: 'Login required', bootstrapped: users.length > 0 }, 401);
    }

    if (path === '/sync' && method === 'GET') return syncResponse(user);
    if (path === '/push' && method === 'POST') return handlePush(req, user);

    if (user.role !== 'admin') return json({ error: 'Admin only' }, 403);
    if (path === '/phonebook' && method === 'GET') return json({ phonebook: await readDoc(DOCS.phonebook, []) });
    if (path === '/users' && method === 'POST') return handleUsers(req, user);
    if (path === '/import' && method === 'POST') return handleImport(req, user);
    if (path === '/export' && method === 'GET') {
      const [groups, contacts, tasks, personal, phonebook] = await Promise.all([
        readDoc(DOCS.groups, []), readDoc(DOCS.contacts, []), readDoc(DOCS.tasks, []),
        readDoc(DOCS.personal, []), readDoc(DOCS.phonebook, []),
      ]);
      return json({ v: 2, exportedAt: Date.now(), groups, contacts, tasks, personal, phonebook });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') }, 500);
  }
}
