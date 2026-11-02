# Creoveya AI Live Studio (Node.js)

Real-time AI face transformation platform for ECO SOLACE GLOBAL LTD. Built on
Node.js/Express with a **Postgres (Neon) database** and a full admin control
panel.

## Quick Start

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL (your Neon connection string), SESSION_SECRET,
# DECART_API_KEY, INITIAL_ADMIN_PASSWORD
npm start
```

Visit `http://localhost:3000`. Log into `/admin_dashboard` with the
`INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` you set in `.env`.

## Connecting to Neon (Postgres)

1. In your Neon project dashboard, copy the connection string — it looks like:
   ```
   postgresql://neondb_owner:AbC123@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
2. Paste it into `.env` as `DATABASE_URL` (keep `?sslmode=require` — the app
   also sets `ssl: { require: true }` in code, but Neon expects it in the URL
   too).
3. That's it — on first boot, `db/index.js` runs `initDb()`, which creates
   every table (`users`, `credit_plans`, `payment_methods`,
   `payment_submissions`, `platform_settings`, `looks`, `stream_sessions`,
   `contact_messages`) if they don't exist yet, and seeds the default admin
   account + Starter/Creator plans. This runs on every boot but is
   idempotent (`CREATE TABLE IF NOT EXISTS`, and seed inserts are guarded by
   count checks), so it's safe to deploy repeatedly.
4. Sessions are also stored in the same Neon database (via
   `connect-pg-simple`, in an auto-created `session` table) — no separate
   session store to configure.

No other code changes are needed to switch environments (local dev vs.
staging vs. production) — just point `DATABASE_URL` at a different Neon
branch/database.

## Deploying (e.g. Render)

1. Set `DATABASE_URL` (Neon), `SESSION_SECRET`, `DECART_API_KEY`,
   `NODE_ENV=production` in your Render service's environment variables.
2. Build command: `npm install`. Start command: `npm start`.
3. No persistent disk is needed anymore for the database — Neon *is* the
   persistent storage. (You may still want one if you'd rather store
   uploaded receipts/looks outside the container filesystem long-term; see
   "Known follow-ups" below.)

## What's preserved from your original Node.js prototype

The Decart connection flow in `public/js/studio.js` (`goLive()`) is a direct port of
`creoveya_3.zip`'s working `public/app.js`: same SDK import, same `models.realtime('lucy-2.1')`
model, same `getUserMedia` constraints, same `client.realtime.connect(...)` /
`.set(...)` / `.disconnect()` calls. The only things added around it are the
server-side start/heartbeat/stop calls that enforce usage limits — the transformation
pipeline itself is untouched.

## Credit & Usage Model (see spec point 21)

- `credits_balance` is the number shown to users (their "wallet").
- `seconds_balance` is the number the backend actually enforces — it's what gates
  starting a stream, switching a Look, and it's what a stream is force-stopped on.
- Both are always topped up **together, from the same source** (an approved plan or a
  manual admin adjustment), so they can never drift into contradicting each other.
- `platform_settings.credits_per_minute` (admin-editable under Platform Settings) is
  the single global rate used to convert between the two everywhere in the app —
  there's no second hardcoded rate anywhere else in the codebase.
- Actual deduction happens in `routes/studio.js` → `reconcileSession()`, using the
  **server's** clock difference between heartbeats — never a client-reported timer.
  A stream that runs out mid-broadcast is force-stopped server-side on the next
  heartbeat (~every 10s), and the frontend tears down the Decart connection
  immediately when it sees `exhausted: true`.

## Security notes

- Passwords hashed with bcrypt (12 rounds).
- Sessions stored server-side (SQLite-backed), `httpOnly` + `SameSite=Lax` cookies,
  `secure` cookies automatically enabled when `NODE_ENV=production`.
- `/admin_dashboard` (and its `admin.js`) is verified against a **fresh DB read of
  `req.user.is_admin` on every single request** — not just at login — and the admin
  frontend files live outside `/public` so they can't be fetched directly, bypassing
  the check.
- Suspension is enforced the same way: a suspended user is blocked immediately, even
  on an already-open session/tab, not just on their next login.
- The Decart API key never reaches the browser. The server exchanges it for a
  short-lived client token per session (`utils/decart.js`).
- Receipts and Look reference images are served through authenticated routes
  (`/api/payments/receipt/:id`, `/api/admin/payments/:id/receipt`,
  `/api/studio/looks/:id/image`) that check ownership/admin role — never as plain
  static files.
- All credit/usage math is recomputed server-side on every relevant request; nothing
  about balances or usage is trusted from the client.

## Project layout

```
server.js              Express app entry, session config, page routing/guards
db/index.js             SQLite schema + seed data (idempotent)
middleware/auth.js       loadUser / requireLogin / requireAdmin / requireActiveAccess
routes/auth.js           register / login / logout / session
routes/payments.js       public plans + methods, receipt submission
routes/studio.js         stream start/heartbeat/stop, looks, Decart token
routes/admin.js          all /api/admin/* endpoints (users, plans, methods, payments, settings)
routes/pages.js          contact form + Telegram forwarding, telegram-link
utils/decart.js          Decart API key resolution + token exchange
admin_assets/            Admin dashboard HTML/JS (intentionally outside /public)
public/                  Public site, auth pages, user dashboard, studio, legal pages
```

## Contact Us → Telegram

Every submission is always saved in the database and visible under
**Admin → Payment Approvals is separate; contact messages land wherever you extend
Overview** — for direct-to-Telegram delivery, set `TELEGRAM_BOT_TOKEN` in `.env`
(create a bot via @BotFather) and the admin's configured Telegram username under
**Platform Settings → Support Contact**; messages will be forwarded automatically.
Without a bot token, messages are still safely stored — just not auto-forwarded.

## Known follow-ups (not yet built)

- Individual user detail/edit view (list + suspend/delete/add-credits are all live;
  a dedicated per-user profile page isn't).
- Real production file storage for receipts/looks: they currently save to
  `uploads/` on the container's local disk, which works fine on a host with a
  persistent disk but is wiped on a fresh container elsewhere — swap to S3/R2
  if your host doesn't persist local files across deploys.
- Password reset flow (currently: register/login only).
- The Windows desktop app (`desktop-app/`) is a working Electron project but
  the actual `.exe` installer needs to be built on Windows or via CI (see
  `desktop-app/README.md`) — it can't be cross-compiled from this Linux
  environment. The homepage's "Download for Windows" button links to
  `/downloads/CreoveyaSetup.exe`, which you'll need to build and place there.
- Carousel images are hotlinked from Unsplash's CDN (free-license photos) —
  fine for a demo, but for production it's worth downloading them into
  `public/img/` so the site doesn't depend on Unsplash's uptime.



## Sign-in, security & appearance (v4)

- **Password reset** — `/forgot-password.html` emails a one-time link
  (valid 30 minutes, single use, older links die when a new one is requested).
  Works for admin accounts too; an admin with no email on file receives the
  link at `ADMIN_NOTIFICATION_EMAIL`. Needs working SMTP (see `.env.example`).
- **Continue with Google** — set `GOOGLE_CLIENT_ID` (see `.env.example`). The
  button is hidden until it is set and in the Windows desktop app.
- **"I'm not a robot"** — on sign in, register, forgot password and contact.
  Built-in checkbox by default; set `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`
  to use Cloudflare Turnstile instead. Auth endpoints are also rate-limited.
- **Remember me** — 30-day login and remembered username; without it the login
  ends when the browser/app is closed.
- **Night mode** — toggle in every header; choice is remembered per device.
- **Link previews** — Open Graph/Twitter tags on every public page use
  `https://creoveya.com` and `/img/og-preview.jpg` (1200x630). After deploying,
  force WhatsApp to refresh a cached preview with the Facebook Sharing Debugger.
