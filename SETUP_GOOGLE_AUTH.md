# Restricting Dynamic Spatial Model Builder to your Google Workspace

This adds a Google sign-in gate in front of the whole app (every page and
every `/api/warehouses` call) so only people signed into a Google account on
your Workspace domain can reach it. Nobody else gets past the sign-in
screen, regardless of the URL they try.

New files added:

- `lib/session.js` — signs/verifies the session cookie and the OAuth `state` param.
- `api/auth/login.js` — starts Google sign-in.
- `api/auth/callback.js` — handles Google's redirect back, verifies the account's domain, sets the session cookie.
- `api/auth/logout.js` — clears the cookie (wired to the new "Sign Out" link in the top bar).
- `middleware.js` — the actual gate. Runs before every request and checks the cookie.

None of this requires a new npm dependency or a database change — it's all
plain Node/Web APIs.

## 1. Create the OAuth client in Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (or reuse one) **under your Spatialis OS Workspace account** — make sure you're signed into the right Google account/organization before creating it.
2. Go to **APIs & Services → OAuth consent screen**.
   - User type: choose **Internal** if it's offered (this restricts sign-in to your Workspace at the Google level, on top of the domain check this app does itself — belt and suspenders). If your Cloud project isn't tied to a Workspace org, you'll only see **External** — that's fine, the app's own domain check still enforces the restriction.
   - Fill in an app name and support email, save.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized redirect URIs**, add exactly:
     ```
     https://warehouse-builder-nine.vercel.app/api/auth/callback
     ```
   - Save.
4. Copy the **Client ID** and **Client Secret** it generates — you'll paste these into Vercel next.

## 2. Generate a session secret

Run this once, locally, and copy the output:

```bash
openssl rand -base64 32
```

(No `openssl`? `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` works the same way.)

This is just a random signing key for the app's own session cookies — it's
not shared with Google. Keep it secret; anyone who has it could forge a
valid session cookie.

## 3. Set environment variables in Vercel

In your Vercel project → **Settings → Environment Variables**, add all four
(for Production, and Preview too if you want auth on preview deployments):

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 1 |
| `GOOGLE_CLIENT_SECRET` | from step 1 |
| `ALLOWED_GOOGLE_DOMAIN` | your Workspace domain, e.g. `spatialis.io` (no `@`, no `https://`) |
| `SESSION_SECRET` | from step 2 |

## 4. Deploy and test

Redeploy after setting the env vars (env var changes don't apply
retroactively to a running deployment). Then:

1. Open the app in a private/incognito window.
2. You should be redirected to a Google sign-in screen, pre-filtered to your Workspace domain.
3. Sign in with a Workspace account → you should land back in the app, and the "Sign Out" link should now appear in the top bar.
4. Sign out, then try signing in with a personal Gmail account (or any account outside your domain) → you should see an "Access is restricted to @yourdomain.com" message, and no session should be created.

**Recommended:** test this on a Preview deployment (push to a branch) before
it hits everyone on Production, since it changes access for the whole app at
once.

## Emergency rollback

If this ever misfires and locks everyone out (wrong domain typo, missing
env var, etc.), delete `middleware.js` (or rename it to something Vercel
won't pick up, like `middleware.js.disabled`) and redeploy. The app goes
back to fully open access immediately — nothing else needs to change to
recover.

## What this does and doesn't protect

- This gates the app's own UI and its `/api/warehouses` endpoints — nobody
  without a valid session cookie can load the app or read/write warehouse
  data.
- It does **not** replace the per-warehouse password Lock feature already in
  the app — that's a separate, finer-grained "read-only for everyone until
  unlocked" control *within* the app, for people who already got past this
  Workspace gate.
- The `hd` parameter on the Google sign-in screen only pre-filters which
  accounts Google's account picker shows; the actual enforcement is the
  server-side domain check in `api/auth/callback.js`, which runs regardless
  of what URL or params someone hits.
