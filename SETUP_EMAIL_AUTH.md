# Sign-in gate for Dynamic Spatial Model Builder (self-serve guest access)

This puts a sign-in screen in front of the whole app (every page and every
`/api/warehouses` call) — nobody reaches any of it without an email address
first. It is **not** an invite-only gate: anyone who types a plausible
email address gets in automatically, as a non-admin guest, no approval
needed. That's deliberate — this app is meant to be handed out as a public
demo link (e.g. emailed to prospects), so the goal is "know who's in the
building" and "keep guests away from admin controls," not "keep people
out." Admin access is the one thing that's still curated — see below.

The access list (who's signed in, and who's an admin) lives in the
database and is managed from inside the app — click **Manage Access** in
the top bar (only admins see that button) to promote/demote admins or
revoke someone's access entirely. No Vercel dashboard, no env vars, no
redeploy required for day-to-day changes.

**Important — read before relying on this:** the sign-in screen only asks
a visitor to *type* an email address; it does not verify they actually own
it (no confirmation link, no password, no external identity provider).
Anyone can type any address and get a guest session as that address. Since
this is now intentionally open to the public, treat every guest as an
anonymous visitor who happens to have typed something in an email-shaped
box — don't infer real identity from it, and don't put anything reachable
by a guest that you wouldn't show a stranger. Guests can still see and
edit any warehouse that isn't locked (see "What this does and doesn't
protect" below) — the Lock feature, not this sign-in gate, is what
protects a specific warehouse from guest edits.

Files involved:

- `lib/session.js` — signs/verifies the session cookie.
- `lib/allowlist.js` — reads the `allowed_emails` database table, with a
  30-second in-memory cache so a single page load's dozen-odd asset
  requests don't each hit the database.
- `sql/allowed_emails.sql` — creates the `allowed_emails` table and seeds
  the first admin. Run once, see step 1 below.
- `api/auth/login.js` — shows the branded email form; if the address isn't
  already in `allowed_emails`, inserts it as a non-admin guest on the
  spot, then sets the session cookie either way.
- `api/auth/logout.js` — clears the cookie (wired to the "Sign Out" link
  in the top bar).
- `middleware.js` — the actual gate. Runs before every request and checks
  for a valid session cookie (through the cache above), redirecting to
  the sign-in page if there isn't one.
- `api/auth/me.js` — tells the front end the signed-in email and whether
  they're an admin; `js/main.js` uses this to show/hide the Export JSON /
  Import JSON controls and the Manage Access / Visitor Log buttons.
- `api/admin/allowed-emails.js` — the API behind the Manage Access panel
  (list everyone / promote / demote / revoke). Every call re-checks that
  the caller is an admin — being merely signed in isn't enough, and this
  route is the *only* way an address becomes an admin (self-serve sign-in
  never sets `is_admin`).
- `sql/login_events.sql` — creates the `login_events` table, one row per
  successful sign-in. Run once, same way as `sql/allowed_emails.sql`.
- `api/admin/login-history.js` — the API behind the **Visitor Log** panel:
  for every address that's ever signed in, how many times and when.

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

**c. Create and seed the allowlist table with your first admin.** Open
`sql/allowed_emails.sql`, check the seed email at the bottom is the
address you want as the first admin (defaults to
`sebastien.bouthillette@spatialisos.com`), then run the file once against
your database — same way you ran `sql/schema.sql` originally: Vercel
dashboard → **Storage** → your DB → **Query**, paste the file's contents,
run it. (Or `psql "$POSTGRES_URL" -f sql/allowed_emails.sql` after
`vercel env pull .env.local`.)

**This step is required before deploying, and it's not optional the way
it might look.** Self-serve sign-in itself works fine with an empty table
— anyone can still get in as a guest. But nobody can ever *become* an
admin except by an existing admin promoting them in Manage Access, so
with zero seeded admins, admin features (Manage Access, Visitor Log,
Export/Import JSON) become permanently unreachable through the UI —
you'd have to go back into the Vercel Query panel and flip `is_admin` by
hand to recover. Seed yourself first.

**d. Create the visitor log table.** Same process, this time with
`sql/login_events.sql` — run its contents once against your database. This
one isn't required for sign-in to work; skip it and the app still runs
fine, but the **Visitor Log** panel (see below) will show an error until
it's been run.

## 2. Deploy and test

Redeploy after setting `SESSION_SECRET` (env var changes don't apply
retroactively to a running deployment). Then:

1. Open the app in a private/incognito window.
2. You should land on the branded sign-in screen asking for an email
   address.
3. Enter your seeded admin address → you should land back in the app, and
   "Sign Out", "Export JSON", "Import JSON", "Manage Access", and
   "Visitor Log" should all appear in the top bar.
4. Sign out, then try a completely made-up address you've never used
   before → you should land in the app as a guest (none of the
   admin-only controls above visible), not get rejected. Check **Manage
   Access** as your admin account afterward and confirm that address now
   shows up in the list, unchecked as Admin.

**Recommended:** test this on a Preview deployment (push to a branch)
before it hits everyone on Production, since it changes access for the
whole app at once. Preview deployments share the same database unless you
provisioned a separate one, so testing there uses the same allowlist.

## Promoting, demoting, or revoking someone

Click **Manage Access** in the top bar (admins only). Every row here is
someone who's signed in at least once (added automatically) or was added
by hand:

- **Add**: type an email, optionally check "Admin", click Add — mainly
  useful for pre-granting someone admin before they've ever signed in.
- **Revoke**: click ✕ next to their row. They're signed out within
  ~30 seconds (the cache window), not instantly — and if they try to sign
  in again with that same address, self-serve will just re-add them as a
  guest, since this gate no longer distinguishes "never invited" from
  "revoked." If you truly need to keep someone out permanently, that's
  outside what this simple, address-based gate can enforce.
- **Promote/demote**: toggle their "Admin" checkbox.

You can't remove or demote the last remaining admin — the API blocks it —
so you can't accidentally lock everyone out of the admin panel itself.

## Visitor Log — knowing who's actually signed in

Click **Visitor Log** in the top bar (admins only) to see, for every
address that's ever signed in (or been added by hand): when, how many
times, and their first/last sign-in time. Addresses added but never
signed in show "Never" — useful right after you've emailed someone the
app URL and want to know who's actually shown up. A **Copy emails that
haven't visited** button grabs that list for a follow-up email.

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

- This gates the app's own UI and its `/api/warehouses` endpoints — nobody
  without a valid session cookie (any email, guest or admin) can load the
  app or read/write warehouse data.
- It does **not** gate *which* warehouses a signed-in guest can see or
  edit. Every warehouse in the switcher is shared across every signed-in
  person, guest or admin — there's no per-person ownership. If you don't
  want guests editing (or deleting) a particular warehouse, use the
  in-app **Lock** feature on it (top bar, next to the warehouse switcher)
  and keep the password to yourself; a locked warehouse is read-only for
  everyone until unlocked. Anything left unlocked should be treated as a
  shared sandbox anyone signed in can change.
- It does **not** verify identity. See the callout at the top of this
  document.
- The admin-only Export/Import JSON and Manage Access restrictions are a
  UI convenience, not a data-access boundary. Every signed-in user (admin
  or not) can already see and edit unlocked warehouse data through the
  app itself — hiding those controls only removes the one-click way to
  grab/overwrite the raw project file or change who's an admin; it
  doesn't further restrict what data a guest can reach.

## Cleaning up (optional)

If you previously set `ALLOWED_EMAILS` or `ADMIN_EMAILS` in Vercel's
Environment Variables, they're no longer read by any code path — safe to
delete whenever convenient.
