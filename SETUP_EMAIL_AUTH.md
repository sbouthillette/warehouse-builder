# Restricting Dynamic Spatial Model Builder by email address

This adds a sign-in gate in front of the whole app (every page and every
`/api/warehouses` call) so only people whose email is on an allowlist can
reach it. Nobody else gets past the sign-in screen, regardless of the URL
they try.

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
- `api/auth/login.js` — shows the email form and checks it against
  `ALLOWED_EMAILS`, then sets the session cookie.
- `api/auth/logout.js` — clears the cookie (wired to the "Sign Out" link
  in the top bar).
- `middleware.js` — the actual gate. Runs before every request, checks the
  cookie, and re-checks the email against `ALLOWED_EMAILS` every time (so
  removing someone from the list revokes their access immediately, even if
  their session cookie hasn't expired).
- `api/auth/me.js` — tells the front end the signed-in email and whether
  it's on `ADMIN_EMAILS`; `js/main.js` uses this to show/hide the
  Export JSON / Import JSON controls in the top bar.

None of this requires a new npm dependency or a database change — it's all
plain Node/Web APIs.

## 1. Generate a session secret

Run this once, locally, and copy the output:

```bash
openssl rand -base64 32
```

(No `openssl`? `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` works the same way.)

This is a random signing key for the app's own session cookies. Keep it
secret; anyone who has it could forge a valid session cookie.

## 2. Set environment variables in Vercel

In your Vercel project → **Settings → Environment Variables**, add both
(for Production, and Preview too if you want auth on preview deployments):

| Name | Value |
|---|---|
| `ALLOWED_EMAILS` | comma-separated list of addresses to let in, e.g. `alice@example.com,bob@example.com` |
| `SESSION_SECRET` | from step 1 |
| `ADMIN_EMAILS` | comma-separated list of addresses allowed to see Export JSON / Import JSON, e.g. `sebastien.bouthillette@spatialisos.com`. Optional — leave unset and nobody sees those controls. |

Matching is case-insensitive and whitespace around each address is
trimmed, so `Alice@Example.com, bob@example.com` works fine — same for
`ADMIN_EMAILS`.

**Every address in `ADMIN_EMAILS` must also be in `ALLOWED_EMAILS`** —
admin status only matters once someone can sign in at all; it doesn't
grant sign-in access by itself.

## 3. Deploy and test

Redeploy after setting the env vars (env var changes don't apply
retroactively to a running deployment). Then:

1. Open the app in a private/incognito window.
2. You should land on a "Sign in" form asking for an email address.
3. Enter an address from `ALLOWED_EMAILS` → you should land back in the
   app, and the "Sign Out" link should now appear in the top bar.
4. Sign out, then try an address that is *not* on the list → you should
   see a "not on the access list" message, and no session should be
   created.

**Recommended:** test this on a Preview deployment (push to a branch)
before it hits everyone on Production, since it changes access for the
whole app at once.

## Adding or removing someone

Edit `ALLOWED_EMAILS` in Vercel's Environment Variables and redeploy.
Because the middleware re-checks the list on every request (not just at
sign-in), a removed address loses access immediately — no need to wait
for their session cookie to expire.

## Emergency rollback

If this ever misfires and locks everyone out (typo in the list, missing
env var, etc.), delete `middleware.js` (or rename it to something Vercel
won't pick up, like `middleware.js.disabled`) and redeploy. The app goes
back to fully open access immediately — nothing else needs to change to
recover.

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
- The `ADMIN_EMAILS` Export/Import restriction is a UI convenience, not a
  data-access boundary. Every signed-in user (admin or not) can already
  see and edit warehouse data through the app itself — hiding the JSON
  export/import buttons only removes the one-click way to grab or
  overwrite the raw project file; it doesn't further restrict what data a
  non-admin can reach.
