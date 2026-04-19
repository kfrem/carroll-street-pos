# Carroll Street Café POS — Claude Context

## What this project is
A full Point-of-Sale system for Carroll Street Café at Medgar Evers College, Brooklyn. Two components:
1. **`index.html`** — Mobile-first web POS (single static HTML file, no build step, uses Supabase + Stripe Terminal)
2. **`bot.js`** — Telegram bot with full menu ordering, voice transcription (Groq), discounts, and reporting (Express/Node.js server)

---

## Deployment — NEVER suggest manual uploads

All deployments are automated. **Push to GitHub `main` branch and everything updates everywhere automatically.**

### GitHub
- Repo: `https://github.com/kfrem/carroll-street-pos.git`
- Branch: `main`
- All changes must be committed and pushed here first

### Hostinger (index.html + USER_GUIDE.html)
- Platform: Hostinger hPanel → workmaster.uk → Advanced → GIT
- Connected repo: `https://github.com/kfrem/carroll-street-pos.git`
- Deploy folder: `cs-cafepos` (inside `public_html`)
- Branch: `main`
- **Auto Deployment: ON** — Hostinger pulls from GitHub automatically on every push
- Live URLs:
  - POS: `https://workmaster.uk/cs-cafepos/index.html`
  - User guide: `https://workmaster.uk/cs-cafepos/USER_GUIDE.html`
- **No FTP, no File Manager, no manual upload ever needed**

### Railway (bot.js)
- Hosts the Node.js Telegram bot server
- **Auto-deploys from GitHub on every push to main**
- Environment variables set on Railway (never hardcode these):
  - `BOT_TOKEN` — Telegram bot token
  - `SUPABASE_URL` — `https://fxkudktemkkevmjibyjp.supabase.co`
  - `SUPABASE_KEY` — Supabase anon/service key
  - `ALLOWED_CHAT_IDS` — comma-separated Telegram chat IDs allowed to use the bot
  - `GROQ_API_KEY` — for voice transcription via Groq Whisper
  - `STRIPE_SECRET_KEY` — Stripe secret key (`sk_live_...`) for Terminal payments
  - `PORT` — set automatically by Railway

### Supabase (database)
- Project URL: `https://fxkudktemkkevmjibyjp.supabase.co`
- Anon/publishable key hardcoded in `index.html` (safe — RLS is enabled)
- Tables: `sales`, `menu_items`, `settings`
- Realtime enabled on `sales` table
- Schema file: `supabase_setup.sql` — run manually in Supabase SQL Editor only when adding new tables

### Telegram Bot
- Bot code lives in `bot.js` — auto-deployed via Railway → no action needed after a push
- Webhook is registered separately (one-time setup)
- To add a new authorised user: add their Telegram chat ID to `ALLOWED_CHAT_IDS` on Railway and redeploy

---

## Correct deploy workflow
```
Edit files locally → git add → git commit → git push origin main
```
That single push updates: GitHub → Hostinger (index.html, USER_GUIDE.html) → Railway (bot.js) automatically.

---

## Architecture

### index.html
- Single self-contained HTML file — no framework, no build step
- Supabase JS SDK loaded from CDN
- Stripe Terminal JS SDK loaded from CDN
- Menu stored in `localStorage` (falls back to `DEFAULT_MENU` hardcoded in file)
- PIN stored in Supabase `settings` table (key: `pos_pin`, default: `1234`)
- Staff names stored in `localStorage`
- `BACKEND_URL` config variable near top of `<script>` — must point to Railway bot server URL for Stripe Terminal to work
- Key functions: `initApp()`, `checkPin()`, `buildMenu()`, `addItem()`, `confirmSale()`, `completeSale()`, `finalizeSale()`, `initStripeTerminal()`, `discoverReaders()`, `buildReport()`

### bot.js
- Express server, single file
- Telegram webhook at `POST /webhook`
- Stripe Terminal endpoints: `POST /stripe/connection-token`, `POST /stripe/create-payment-intent`
- In-memory sessions (lost on restart — intentional, orders are short-lived)
- Menu (`MENU` array) must be kept in sync with `DEFAULT_MENU` in `index.html` manually
- Report command sends 3 separate Telegram messages (revenue/time, items/categories, staff/insights)

### Supabase `sales` table schema
```
id          BIGSERIAL PRIMARY KEY
created_at  TIMESTAMPTZ DEFAULT NOW()
staff       TEXT
items       JSONB  -- [{name, price, qty}]
total       NUMERIC(10,2)
note        TEXT
source      TEXT  -- 'pos' | 'telegram' | 'refund'
```

---

## Key files
| File | Purpose |
|---|---|
| `index.html` | Web POS — edit for UI/UX, menu, reports, Stripe Terminal frontend |
| `bot.js` | Telegram bot + Stripe Terminal backend endpoints |
| `package.json` | Node.js dependencies — `stripe`, `express`, `node-fetch`, `form-data`, `@supabase/supabase-js` |
| `supabase_setup.sql` | DB schema — only run in Supabase SQL Editor when adding new tables |
| `USER_GUIDE.html` | Interactive user manual — update this whenever features change |
| `SETUP_GUIDE.html` | Original technical setup guide |

---

## Things to know
- Menu changes in the web POS Manage tab save to `localStorage` only — they do NOT sync to other devices or to `bot.js`. If the menu changes, update `DEFAULT_MENU` in `index.html` AND `MENU` in `bot.js` manually.
- The Stripe Terminal reader must be reconnected each time the POS is opened (takes ~5 seconds via Manage tab → Discover Readers). This is by design.
- `USER_GUIDE.html` has a "Last updated" date in the sidebar footer — update it whenever the guide is edited.
- The `📖 Guide` button in the POS header links to `USER_GUIDE.html` (relative path — works because both files are in the same Hostinger directory).
- Refunds in the POS only log a negative transaction — actual card refunds must be processed separately in Stripe Dashboard.
- `clearDay()` in Reports permanently deletes today's sales from Supabase — no undo.
