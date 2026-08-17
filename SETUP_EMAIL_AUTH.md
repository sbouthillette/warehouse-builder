# Restricting Dynamic Spatial Model Builder by email address

This adds a sign-in gate in front of the whole app (every page and every
`/api/warehouses` call) so only people whose email is on an allowlist can
reach it. Nobody else gets past the sign-in screen, regardless of the URL
they try.

The allowlist itself lives in the database and is managed from inside the
app — click **Manage Access** in the top bar (only admins see that button)
to add or remove people, or promote/demote admins. No Vercel dashboard, no
env vars, no redeploy required for day-to-day changes.

**Important — read before enabling this:** the sign-in screen only asks a
visitor to *type* an email address; it does not verify they actually own
it (no confirmation link, no password, no external identity provider).
Anyone who knows an allowed address can type it in and get a session as
that address. This is a simple, low-friction gate suitable for a small
trusted team or an internal tool where "knowing the list" is already a
reasonable proxy for "should have access" — it is not equivalent to real
authentication. If you need to actually verify identity, use something
like magic-link email verification or a real OAuth/SSO provider instead.

Files involved:

- `lib/session.js` — signs/verifies the session cookie.
- `lib/allowlist.js` — reads the `allowed_emails` database table, with a
  30-second in-memory cache so a single page load's dozen-odd asset
  requests don't each hit the database.
- `sql/allowed_emails.sql` — creates the `allowed_emails` table and seeds
  the first admin. Run once, see step 1 below.
- `api/auth/login.js` — shows the email form and checks it against the
  table, then sets the session cookie.
- `api/auth/logout.js` — clears the cookie (wired to the "Sign Out" link
  in the top bar).
- `middleware.js` — the actual gate. Runs before every request, checks the
  cookie, and re-checks the email against the table every time (through
  the cache above), so removing someone revokes their access within
  ~30 seconds, without waiting for their session cookie to expire.
- `api/auth/me.js` — tells the front end the signed-in email and whether
  they're an admin; `js/main.js` uses this to show/hide the Export JSON /
  Import JSON controls and the Manage Access button.
- `api/admin/allowed-emails.js` — the API behind the Manage Access panel
  (list / add / remove / promote / demote). Every call re-checks that the
  caller is an admin — being merely signed in isn't enough.
- `sql/login_events.sql` — creates the `login_events` table, one row per
  successful sign-in. Run once, same way as `sql/allowed_emails.sql`.
- `api/admin/login-history.js` — the API behind the **Visitor Log** panel:
  for every address on the access list, how many times they've signed in
  and when.

This uses the Postgres database you already provisioned for warehouse
data (see the main `README.md`) — no new npm dependency.

## 1. One-time setup

**a. Generate a session secret.** Run this once, locally, and copy the output:

```bash
openssl rand -base64 32
```

(No `openssl`? `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` works the same way.)

This is a random signing key for the app's own session cookies. Keep it
secret; anyone who has it could forge a valid session cookie.

**b. Set the env var in Vercel.** Project → **Settings → Environment
Variables** (for Production, and Preview too if you want auth on preview
deployments):

| Name | Value |
|---|---|
| `SESSION_SECRET` | from step (a) |

**c. Create and seed the allowlist table.** Open `sql/allowed_emails.sql`,
check the seed email at the bottom is the address you want as the first
admin (defaults to `sebastien.bouthillette@spatialisos.com`), then run the
file once against your database — same way you ran `sql/schema.sql`
originally: Vercel dashboard → **Storage** → your DB → **Query**, paste
the file's contents, run it. (Or `psql "$POSTGRES_URL" -f sql/allowed_emails.sql`
after `vercel env pull .env.local`.)

**This step is required before deploying** — until that seed row exists,
the allowlist is empty and nobody, including you, can sign in.

**d. Create the visitor log table.** Same process, this time with
`sql/login_events.sql` — run its contents once against your database. This
one isn't required for sign-in to work; skip it and the app still runs
fine, but the **Visitor Log** panel (see below) will show an error until
it's been run.

## 2. Deploy and test

Redeploy after setting `SESSION_SECRET` (env var changes don't apply
retroactively to a running deployment). Then:

1. Open the app in a private/incognito window.
2. You should land on a "Sign in" form asking for an email address.
3. Enter your seeded admin address → you should land back in the app, and
   "Sign Out", "Export JSON", "Import JSON", and "Manage Access" should
   all appear in the top bar.
4. Sign out, then try an address that isn't on the list → you should see
   a "not on the access list" message, and no session should be created.
5. Click **Manage Access**, add a teammate's email (leave "Admin"
   unchecked), and confirm they can sign in but don't see Export/Import/
   Manage Access themselves.

**Recommended:** test this on a Preview deployment (push to a branch)
before it hits everyone on Production, since it changes access for the
whole app at once. Preview deployments share the same database unless you
provisioned a separate one, so testing there uses the same allowlist.

## Adding, removing, or promoting someone day-to-day

Click **Manage Access** in the top bar (admins only):

- **Add**: type an email, optionally check "Admin", click Add.
- **Remove**: click ✕ next to their row. They're signed out within
  ~30 seconds (the cache window), not instantly.
- **Promote/demote**: toggle their "Admin" checkbox.

You can't remove or demote the last remaining admin — the API blocks it —
so you can't accidentally lock everyone out of the admin panel itself.

## Visitor Log — knowing who's actually signed in

Click **Visitor Log** in the top bar (admins only) to see, for every
address on the access list: when they were invited, how many times
they've signed in, and their first/last sign-in time. Addresses that
haven't signed in yet show "Never" — useful right after you've emailed
people the app URL and want to know who's actually shown up. A **Copy
emails that haven't visited** button grabs that list for a follow-up
email.

This counts *sign-ins* (submitting the email form), not every page load —
once someone's session cookie is active (up to 14 days), continuing to use
the app doesn't add new rows. So "last visit" is really "last time they
had to sign in again," which usually means their first visit unless the
cookie expired or they signed in from a new device/browser in between.

## Emergency rollback

If this ever misfires and locks everyone out (bad data in the table,
database unreachable, etc.), delete `middleware.js` (or rename it to
something Vercel won't pick up, like `middleware.js.disabled`) and
redeploy. The app goes back to fully open access immediately — nothing
else needs to change to recover. Once you can get back in, fix the
`allowed_emails` table directly via the Vercel Query panel if needed.

Note this system now depends on the database being reachable: if it's
down, `middleware.js` fails closed (denies everyone) unless it still has
a cached copy of the allowlist from the last successful check — so a
short outage is usually invisible, but a long one will lock everyone out
until the database recovers or you use the rollback above.

## What this does and doesn't protect

- This gates the app's own UI and its `/api/warehouses` endpoints —
  nobody without a valid session cookie can load the app or read/write
  warehouse data.
- It does **not** replace the per-warehouse password Lock feature already
  in the app — that's a separate, finer-grained "read-only for everyone
  until unlocked" control *within* the app, for people who already got
  past this gate.
- It does **not** verify identity. See the callout at the top of this
  document.
- The admin-only Export/Import JSON and Manage Access restrictions are a
  UI convenience, not a data-access boundary. Every signed-in user (admin
  or not) can already see and edit warehouse data through the app itself
  — hiding those controls only removes the one-click way to grab/overwrite
  the raw project file or change who's allowed in; it doesn't further
  restrict what data a non-admin can reach.

## Cleaning up (optional)

If you previously set `ALLOWED_EMAILS` or `ADMIN_EMAILS` in Vercel's
Environment Variables, they're no longer read by any code path — safe to
delete whenever convenient.
