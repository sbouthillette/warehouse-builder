# Dynamic Spatial Model Builder — Spatialis OS Digital Twin PWA

A PWA for building a digital twin of a warehouse: shell, zones, racking bays, racks and aisles, in both a 2D plan and a 3D view. Multiple warehouses are saved to a Postgres database so you can switch between them.

## 1. Provision the database

1. Push this project to GitHub and import it into Vercel (or run `vercel link` from this folder if it's already a Vercel project).
2. In the Vercel dashboard, open your project → **Storage** → **Create Database** → **Postgres**. This provisions a database and automatically adds the connection env vars (`POSTGRES_URL`, etc.) to your project.
3. Create the table. Easiest: in the Vercel dashboard, open the new database → **Query**, paste the contents of `sql/schema.sql`, and run it.
   Alternatively, from your machine: `vercel env pull .env.local` then `psql "$POSTGRES_URL" -f sql/schema.sql`.

## 2. Local development

```bash
npm install
npx vercel env pull .env.local   # pulls POSTGRES_URL etc. from your Vercel project
npx vercel dev                   # serves both the static app and /api routes
```

(`npx` downloads the Vercel CLI on the fly if you don't have it installed globally — if you do, drop `npx` and just run `vercel env pull .env.local` / `vercel dev`.)

**Run `vercel dev` directly — don't wrap it in an npm script.** There's deliberately no `"dev"` script in `package.json` for this. If you add one that calls `vercel dev` (or `npm run dev` that does), and your Vercel Project Settings' **Development Command** is also set to run that same script — which is a common default — `vercel dev` ends up trying to launch itself and fails with `Error: vercel dev must not recursively invoke itself`. If you ever hit that: open the project on vercel.com → **Settings → Build & Development Settings → Development Command**, and either clear it or turn its **Override** toggle off (this project has no framework/build step for the frontend, so there's nothing it needs to invoke).

Open the URL `vercel dev` prints (usually `http://localhost:3000`).

Note: plain static servers (`python -m http.server`, VS Code Live Server, etc.) won't work for the database features — the `/api/warehouses` routes are serverless functions that only run under `vercel dev` or an actual Vercel deployment. Those tools are still fine if you just want to look at the UI/2D/3D code without the switcher working.

## 3. Deploy

```bash
npm run deploy    # runs `vercel --prod`
```

or just push to GitHub if the project is connected to Vercel for auto-deploys.

## How data is stored

Each warehouse you create is one row in the `warehouses` table (`sql/schema.sql`): a UUID `id` plus a `data` JSONB column holding the whole project (shell, zones, bay templates, racks). The frontend (`js/model.js`) talks to `/api/warehouses` (list/create) and `/api/warehouses/:id` (load/save/delete). Edits autosave ~600ms after you stop typing; the status indicator in the top bar shows Saving…/Saved/failure.

The warehouse picker in the bar under the header lists all your saved warehouses by name (pulled from each project's shell name) and lets you switch, create, or delete one. Export/Import JSON still work, scoped to whichever warehouse is currently open — Import creates a new warehouse row from the file rather than overwriting.

## Project structure

- `index.html`, `css/style.css` — app shell and styling
- `js/model.js` — data model + cloud persistence (fetch calls to `/api/warehouses`)
- `js/main.js` — forms, tables, warehouse switcher, tab wiring
- `js/canvas2d.js` — 2D plan renderer
- `js/three3d.js` — 3D digital twin renderer (Three.js via CDN, ES modules)
- `api/warehouses/index.js`, `api/warehouses/[id].js` — Vercel serverless functions (CRUD)
- `sql/schema.sql` — Postgres table definition
- `manifest.json`, `sw.js`, `icons/` — PWA install/offline support (the service worker never caches `/api/*`, only the static app shell)

See `SETUP_EMAIL_AUTH.md` for the email sign-in gate, the admin-only Manage Access panel, and the Visitor Log (who from your invite list has actually signed in — `sql/login_events.sql`, `api/admin/login-history.js`).

## Set up "Schedule a Full Demo"

The "Schedule a Full Demo" button in the top bar (visible to every signed-in visitor) opens a real scheduler via [Calendly](https://calendly.com) — a visitor picks an open slot and it's booked straight onto your calendar, no email back-and-forth. This goes through Calendly rather than the Google Calendar API directly so there's no Google Cloud project, OAuth app, or credentials to manage — Calendly already handles that on their end.

1. Create a free Calendly account (or use an existing one) at [calendly.com](https://calendly.com).
2. In Calendly, go to **Availability → Connected Calendars** and connect the Google Calendar you want demo bookings to land on (the same Google account behind `spatialisos.com`, if that's what you want people booking into). This is what lets Calendly know which slots are actually free.
3. Create an event type for this — **Event Types → Create → One-on-One** — something like "Full Demo — 30 min," with whatever duration and buffer you want.
4. Open that event type, click **Add to website → Copy link** (you don't need the embed code, just the link — e.g. `https://calendly.com/your-username/full-demo`).
5. In `index.html`, find `id="btnScheduleDemo"` and replace its placeholder `href` with that link. Redeploy.

That's it — no other code changes needed. The button opens Calendly's own popup scheduler (`js/main.js`, `setupScheduleDemoButton`), which loads via the `<script>`/`<link>` tags for `assets.calendly.com` already in `index.html`'s `<head>`. If a visitor is signed in, their email is passed to Calendly to prefill the booking form.

To change the booking link later (a different event type, a different calendar), just update that one `href` — nothing else references it.
