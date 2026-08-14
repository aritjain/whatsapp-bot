# JMS Chief-of-Staff v2

Multi-company task assignment for JMS: assign tasks to people across companies (Sun Pharma, Lupin, Abbott, BSVL, …) and departments, chase them on WhatsApp with one morning batch, and give staff their own phone-number logins that show **only their own tasks**.

One static page (`index.html`) + one Netlify Function (`netlify/functions/api.mjs`) + Netlify Blobs storage. No framework, no build step.

## What's in v2

- **Real logins** — phone number + password. One admin (the CEO) and staff members. Auth and data filtering happen **on the server**: a staff phone never receives the phonebook, the CEO's personal tasks, or anyone else's tasks.
- **Contacts, not per-company rows** — one person can belong to many companies. "Remind all" sends ONE WhatsApp message covering all their pending work, grouped by company, with notes and "pending N days", signed by whoever sent it.
- **Chase Queue** — the app opens on who-owes-you-what, worst first. Tick people, send reminders one-by-one through a stepper, and each send is recorded (`reminded 3×, last 2d ago`). People reminded today grey out.
- **Verify-close** — staff mark a task done → it goes to *Awaiting verify* → admin confirms. Every task keeps an append-only activity log (created / assigned / status / reminded / verified / comments) written server-side.
- **Server is the system of record** — the phone is just a cache. Works offline, syncs when back. Daily + pre-import snapshots are kept in Blobs (last 30) as a safety net, but restoring one is a manual operation — so also tap **More → Export backup** weekly and keep the file somewhere off Netlify.
- **Login protection** — server-side password floors (10+ admin, 8+ staff), 10-minute lockout after 5 failed attempts, and password reset / disable instantly revokes that user's existing sessions.

## Deploy (one time, ~5 minutes)

1. **Netlify → Add new site → Import an existing project → GitHub** → pick this repo.
2. Set the **production branch** to the branch you want to serve (e.g. `main` after merging).
   Build command: *(leave empty)* · Publish directory: `.` — `netlify.toml` handles the rest.
3. **Site configuration → Build & deploy → turn Deploy Previews OFF and Branch deploys to "None"** (or production branch only). This repo is public — the API refuses to serve non-production deploys as a code-level backstop, but turn the previews off anyway so PR builds never exist.
4. Deploy. Netlify installs `@netlify/blobs` and wires `/api/*` automatically. No environment variables needed (an auth secret is generated and stored in Blobs on first run; set `JMS_AUTH_SECRET` only if you ever want to force one).

## First run

1. Open the site → it shows **Create the admin account**. Use the CEO's own phone number and a strong password (there is no self-service admin reset — save it).
2. **More (⋯) → Import backup / data file** → choose your exported `jms-tasks-….json` (the v1 export works as-is). The import **merges** — it never overwrites — and automatically:
   - de-duplicates people who existed under several companies (same phone = same person, memberships preserved),
   - re-links their tasks,
   - moves your personal phonebook and personal tasks into admin-only storage.
3. If the old v1 app was used on this phone, v2 also offers to upload that device data on first login.

## Staff logins

**More (⋯) → Staff logins → ➕** — pick the contact (people with open tasks are suggested first), a password is generated for you; send it via the WhatsApp button. Staff open the same site URL, log in with their number, and see only their tasks: To do / Waiting for verification / Done, with status buttons and comments back to you.

Reset a password or disable a login from the same screen at any time.

## Development

```bash
npm install
npx netlify dev   # serves the app + function with a LOCAL sandboxed blob store
```

Local data is separate from production data. The deployed store is site-wide (shared across branch deploys) by design, so a branch deploy and production see the same data.

## Privacy note

This repository is public — it contains **code only**. All data (tasks, contacts, phonebook) lives in your site's Netlify Blobs store and in backups you export yourself. Don't commit data files.
