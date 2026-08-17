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
vercel env pull .env.local   # pulls POSTGRES_URL etc. from your Vercel project
npm run dev                  # runs `vercel dev`, serving both the static app and /api routes
```

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
