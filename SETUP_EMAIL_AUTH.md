# Sign-in gate for Dynamic Spatial Model Builder (self-serve, code-verified guest access)

This puts a sign-in screen in front of the whole app (every page and every
`/api/warehouses` call) — nobody reaches any of it without an email address
first. It's still **not** invite-only: anyone who owns a real inbox gets in
automatically, as a non-admin guest, no approval needed. That's
deliberate — this app is meant to be handed out as a public demo link
(e.g. emailed to prospects), so the goal is "know who's in the building"
and "keep guests away from admin controls," not "keep people out."

What changed from the original version: sign-in is now **two steps**
instead of one. Typing an email address no longer gets you straight in —
it sends a 6-digit code to that address, and you have to type the code
back in to actually sign in. This exists specifically to stop bots (and
randomly-typed or mistyped addresses) from getting sessions: before this,
anything shaped like an email worked immediately, with no proof anyone
actually read mail sent to it. Admin access is still the one thing that's
curated on top of that — see below.

The access list (who's signed in, and who's an admin) lives in the
database and is managed from inside the app — click **Manage Access** in
the top bar (only admins see that button) to promote/demote admins or
revoke someone's access entirely. No Vercel dashboard, no env vars, no
redeploy required for day-to-day changes.

**Important — read before relying on this:** verifying a code proves
someone can read mail sent to that address at that moment — it's real
ownership proof, not identity proof. Anyone with access to an inbox
(including a throwaway/temp-mail address) can still get a guest session as
that address. Guests can still see and edit any warehouse that isn't
locked (see "What this does and doesn't protect" below) — the Lock
feature, not this sign-in gate, is what protects a specific warehouse from
guest edits.

Files involved:

- `lib/session.js` — signs/verifies the session cookie.
- `lib/allowlist.js` — reads the `allowed_emails` database table, with a
  30-second in-memory cache so a single page load's dozen-odd asset
  requests don't each hit the database.
- `lib/loginCodes.js` — generates the 6-digit codes and hashes them
  (HMAC-SHA256, keyed with `SESSION_SECRET` — no separate secret needed)
  for storage; also the shared constants (code lifetime, max wrong
  attempts, resend cooldown).
- `lib/mailer.js` — sends the code by email, via Google Workspace SMTP
  (`smtp.gmail.com`) using an app password. See step 1e below.
- `lib/loginEvents.js` — records a row in `login_events` once a sign-in is
  actually completed (used by the Visitor Log panel).
- `lib/authPages.js` — the shared HTML/CSS for all three screens in the
  flow (email form, code form, "you're in" confirmation), so
  `api/access/login.js` and `api/access/verify.js` render identical-looking
  cards instead of two copies of the same styling.
- `sql/allowed_emails.sql` — creates the `allowed_emails` table and seeds
  the first admin. Run once, see step 1c below.
- `sql/login_codes.sql` — creates the `login_codes` table (one pending
  code per email, deleted once used or overwritten by a newer one). Run
  once, see step 1d below.
- `sql/login_events.sql` — creates the `login_events` table, one row per
  successful sign-in. Run once, see step 1d below.
- `api/access/login.js` — **step 1.** Shows the branded email form; on
  submit, generates a 6-digit code, stores its hash, emails it, and shows
  the "enter your code" form. Does *not* touch `allowed_emails` or set any
  cookie — nothing is granted until the code is verified.
- `api/access/verify.js` — **step 2.** Checks the submitted code against the
  stored hash (expiry + max-attempts enforced). Only on a correct code:
  adds the address to `allowed_emails` as a non-admin guest if it's new,
  logs the visit, and sets the session cookie.
- `api/access/logout.js` — clears the cookie (wired to the "Sign Out" link
  in the top bar).
- `middleware.js` — the actual gate. Runs before every request and checks
  for a valid session cookie, redirecting to the sign-in page if there
  isn't one.
- `api/access/me.js` — tells the front end the signed-in email and whether
  they're an admin; `js/main.js` uses this to show/hide the Export JSON /
  Import JSON controls and the Manage Access / Visitor Log buttons.
- `api/admin/allowed-emails.js` — the API behind the Manage Access panel
  (list everyone / promote / demote / revoke). Every call re-checks that
  the caller is an admin — being merely signed in isn't enough, and this
  route is the *only* way an address becomes an admin (self-serve sign-in
  never sets `is_admin`).
- `api/admin/login-history.js` — the API behind the **Visitor Log** panel:
  for every address that's ever signed in, how many times and when.

This uses the Postgres database you already provisioned for warehouse
data (see the main `README.md`) — no new database. It does add one new npm
dependency, `nodemailer` (already added to `package.json` /
`package-lock.json`), for sending the code emails.

## 1. One-time setup

**a. Generate a session secret.** Run this once, locally, and copy the output:

```bash
openssl rand -base64 32
```

(No `openssl`? `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` works the same way.)

This is a random signing key for the app's own session cookies *and* for
hashing the verification codes. Keep it secret; anyone who has it could
forge a valid session cookie or a valid code hash.

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
— anyone can still get in as a guest once they verify their code. But
nobody can ever *become* an admin except by an existing admin promoting
them in Manage Access, so with zero seeded admins, admin features (Manage
Access, Visitor Log, Export/Import JSON) become permanently unreachable
through the UI — you'd have to go back into the Vercel Query panel and
flip `is_admin` by hand to recover. Seed yourself first.

**d. Create the code and visitor-log tables.** Same process, run
`sql/login_codes.sql` and `sql/login_events.sql` once each against your
database. `sql/login_codes.sql` is required — sign-in can't complete
without it (there'd be nowhere to store a code to check against).
`sql/login_events.sql` isn't required for sign-in to work; skip it and the
app still runs fine, but the **Visitor Log** panel will show an error
until it's been run.

**e. Set up the sending mailbox (Google Workspace).** The verification
code is sent via SMTP from a Google Workspace mailbox on your own domain
— e.g. `verify@spatialisos.com` — rather than a third-party email
provider, since that domain's mail is already on Workspace with SPF
already in place.

1. Decide which mailbox will send these — a dedicated one like
   `verify@spatialisos.com` or `noreply@spatialisos.com` is recommended
   over a personal inbox, so replies (and the app password below) aren't
   tied to your actual account. Create it in the Workspace admin console
   if it doesn't exist yet.
2. Turn on **2-Step Verification** for that account (Google Account →
   Security) — required before Google will issue an app password.
3. Google Account → **Security** → **2-Step Verification** → **App
   passwords**. Create one (name it something like "Spatialis OS sign-in
   emails"), and copy the 16-character password it gives you — you won't
   be able to see it again.
4. Set these in Vercel (Project → **Settings → Environment Variables**):

   | Name | Value |
   |---|---|
   | `GMAIL_USER` | the mailbox address, e.g. `verify@spatialisos.com` |
   | `GMAIL_APP_PASSWORD` | the 16-character app password from step 3 |
   | `GMAIL_FROM_NAME` | *(optional)* display name, defaults to `Spatialis OS` |

5. **Recommended, not required:** turn on DKIM signing for the domain
   (Workspace Admin console → **Apps → Google Workspace → Gmail →
   Authenticate email**) — it generates one DNS TXT record to add at your
   registrar/DNS host. Workspace mail generally delivers fine without it,
   but it noticeably improves the odds a first-time recipient's spam
   filter doesn't second-guess the message.

Google Workspace's SMTP relay has a daily sending cap (in the low
thousands), which is irrelevant at this app's volume — worth knowing about
only if this ever gets used well beyond a handful of demo invites a day.

## 2. Deploy and test

Redeploy after setting the env vars above (env var changes don't apply
retroactively to a running deployment). Then:

1. Open the app in a private/incognito window.
2. You should land on the branded sign-in screen asking for an email
   address.
3. Enter your seeded admin address → you should land on a "check your
   email" screen. Open the email (check spam if it doesn't show up in a
   few seconds), copy the 6-digit code, enter it → you should land back in
   the app on a brief "You're in" confirmation, then the app itself, with
   "Sign Out", "Export JSON", "Import JSON", "Manage Access", and "Visitor
   Log" all visible in the top bar.
4. Try entering the wrong code once on purpose — you should see "Incorrect
   code, N attempts left" rather than being silently let in or bounced
   back to square one.
5. Sign out, then try a completely made-up (but real, checkable) address
   you've never used before → same code flow → you should land in the app
   as a guest (none of the admin-only controls above visible), not get
   rejected. Check **Manage Access** as your admin account afterward and
   confirm that address now shows up in the list, unchecked as Admin.

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
  ~30 seconds (the cache window), not instantly — and if they sign in
  again with that same address, self-serve will just re-add them as a
  guest after they verify a fresh code, since this gate no longer
  distinguishes "never invited" from "revoked." If you truly need to keep
  someone out permanently, that's outside what this simple, address-based
  gate can enforce.
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

This counts *completed* sign-ins (a verified code), not every page load or
every email-address submission — once someone's session cookie is active
(up to 14 days), continuing to use the app doesn't add new rows. So "last
visit" is really "last time they had to sign in again," which usually
means their first visit unless the cookie expired or they signed in from a
new device/browser in between.

## Emergency rollback

If this ever misfires and locks everyone out (bad data in a table,
database unreachable, sending mailbox broken, etc.), delete
`middleware.js` (or rename it to something Vercel won't pick up, like
`middleware.js.disabled`) and redeploy. The app goes back to fully open
access immediately — nothing else needs to change to recover. Once you can
get back in, fix the affected table directly via the Vercel Query panel if
needed.

Note this system now depends on the database being reachable (for the
allowlist and the codes) *and* on the sending mailbox working (for codes
to actually arrive): if the database is down, `middleware.js` fails closed
(denies everyone) unless it still has a cached copy of the allowlist from
the last successful check; if the mailbox is misconfigured or Google
rejects a send, `api/access/login.js` shows an error on that submission
rather than silently failing.

## What this does and doesn't protect

- This gates the app's own UI and its `/api/warehouses` endpoints — nobody
  without a valid session cookie (any email, guest or admin) can load the
  app or read/write warehouse data.
- It now requires proving control of the email address (via the 6-digit
  code) before granting that session — a meaningful bar against bots and
  mistyped/randomly-generated addresses, though not against a determined
  human willing to use a real (even disposable) inbox.
- It does **not** gate *which* warehouses a signed-in guest can see or
  edit. Every warehouse in the switcher is shared across every signed-in
  person, guest or admin — there's no per-person ownership. If you don't
  want guests editing (or deleting) a particular warehouse, use the
  in-app **Lock** feature on it (top bar, next to the warehouse switcher)
  and keep the password to yourself; a locked warehouse is read-only for
  everyone until unlocked. Anything left unlocked should be treated as a
  shared sandbox anyone signed in can change.
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
