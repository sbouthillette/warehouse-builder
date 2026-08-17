// api/auth/login.js — the whole sign-in gate: a branded HTML form asking
// for an email address. Self-serve: an address that isn't already on the
// `allowed_emails` table (see sql/allowed_emails.sql) gets auto-added here
// as a non-admin guest and signed straight in — nobody has to approve them
// first. Admins are the exception: those rows are seeded/promoted only via
// the in-app "Manage Access" panel (api/admin/allowed-emails.js), never by
// this self-serve path (see the `false` literal in the INSERT below).
//
// IMPORTANT: this does NOT verify that the visitor actually owns the email
// they type in — there's no confirmation link, no password, no external
// identity provider. It only checks "is this a plausible email address".
// That's a deliberate choice: this app is meant to be handed out as a
// public demo link (e.g. emailed to prospects), so the goal is the lowest
// possible friction to "look around," not real identity verification. It
// does mean anyone who reaches this URL can create a guest session as
// whatever email they type — don't put anything here you wouldn't want a
// stranger to see or edit. Any warehouse you want protected from guest
// editing should be locked with a password (the in-app Lock feature) —
// this login gate is about who gets in the door, not what they can touch
// once inside.
import { sql } from '@vercel/postgres';
import { signToken, SESSION_COOKIE, SESSION_MAX_AGE } from '../../lib/session.js';
import { getAllowlist, invalidateAllowlistCache } from '../../lib/allowlist.js';

// Best-effort visit logging for the admin-only "Visitor Log" panel (see
// sql/login_events.sql and api/admin/login-history.js). Never let a
// logging failure block someone from actually signing in — swallow and
// move on.
async function recordLoginEvent(req, email) {
  try {
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null)
      || req.socket?.remoteAddress
      || null;
    await sql`
      INSERT INTO login_events (email, user_agent, ip)
      VALUES (${email}, ${req.headers['user-agent'] || null}, ${ip})
    `;
  } catch (err) {
    console.error('Could not record login event', err);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only ever accept a same-site path for the post-login redirect — never let
// this become an open redirect to an attacker-controlled URL.
function safeNext(raw) {
  const next = typeof raw === 'string' ? raw : '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Branded, self-contained sign-in page — reuses the app's own stylesheet,
// fonts and logo (all served as static files, reachable from this API
// route the same as from index.html) rather than duplicating the design
// system inline, so this page automatically stays in sync with the rest
// of the app's look. Only the page-specific layout (the centered card;
// there's no #app shell here to hang off of) lives in the local <style>
// block below.
function formPage({ next, error }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Dynamic Spatial Model Builder</title>
<meta name="theme-color" content="#ffffff" />
<link rel="icon" href="/icons/icon-192.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Barlow+Semi+Condensed:wght@500&family=Barlow+Condensed:wght@700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/css/style.css" />
<style>
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: var(--sp-6); box-sizing: border-box; }
  .auth-card {
    width: 100%;
    max-width: 400px;
    text-align: center;
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid var(--glass-border-soft);
    border-radius: var(--radius-lg);
    padding: var(--sp-8) var(--sp-6);
    box-shadow: var(--glass-inset-highlight), var(--glass-shadow-lifted);
    box-sizing: border-box;
  }
  .auth-logo { width: 200px; max-width: 70%; height: auto; margin: 0 auto var(--sp-6); display: block; }
  .auth-card h1 {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    font-size: 26px;
    margin: 0 0 4px;
    color: var(--ink);
  }
  .auth-tagline { margin: 0 0 var(--sp-6); font-size: 14px; color: var(--ink-secondary); }
  .auth-card input[type=email] {
    width: 100%;
    box-sizing: border-box;
    background: var(--glass-bg-strong);
    border: 1px solid var(--glass-border-soft);
    border-radius: var(--radius-sm);
    padding: 11px 14px;
    font-family: 'Barlow', sans-serif;
    font-size: 15px;
    color: var(--ink);
    margin: 0 0 var(--sp-3);
  }
  .auth-card input[type=email]:focus {
    outline: none;
    border-color: var(--primary-2);
    box-shadow: 0 0 0 3px rgba(201, 126, 13, 0.18);
  }
  .auth-card button[type=submit] { width: 100%; }
  .auth-error {
    background: var(--status-danger-bg);
    color: var(--status-danger-text);
    border-radius: var(--radius-sm);
    padding: var(--sp-2) var(--sp-3);
    margin: 0 0 var(--sp-3);
    font-size: 13px;
    text-align: left;
  }
  .auth-footnote { margin: var(--sp-6) 0 0; font-size: 12px; color: var(--ink-secondary); }
</style>
</head><body>
  <div class="auth-card">
    <img class="auth-logo" src="/assets/logo/spatialis-horizontal-colour.png" alt="Spatialis OS" />
    <h1>Dynamic Spatial Model Builder</h1>
    <p class="auth-tagline">Spatialis OS · Explore a live digital twin of your warehouse</p>
    ${error ? `<div class="auth-error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/api/auth/login">
      <input type="email" name="email" placeholder="you@example.com" required autofocus />
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <button type="submit" class="btn btn-primary">Continue</button>
    </form>
    <p class="auth-footnote">Enter any email to get started — you'll get your own guest access, no approval needed.</p>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    res.status(500).send(
      "Email sign-in is not configured yet. Set SESSION_SECRET in the Vercel project's " +
      "Environment Variables, then redeploy. (The access list itself now lives in the " +
      "database — see sql/allowed_emails.sql — not an env var.)"
    );
    return;
  }

  if (req.method === 'GET') {
    const next = safeNext(req.query.next);
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(formPage({ next, error: null }));
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const next = safeNext(body.next);

    if (!email || !EMAIL_RE.test(email)) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(formPage({ next, error: 'Enter a valid email address.' }));
      return;
    }
    const lowerEmail = email.toLowerCase();

    let allowlist;
    try {
      // A fresh sign-in should see the just-edited list, not a stale cache.
      allowlist = await getAllowlist({ fresh: true });
    } catch (err) {
      res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(formPage({ next, error: 'Could not check the access list right now (database unreachable). Try again in a moment.' }));
      return;
    }

    if (!allowlist.has(lowerEmail)) {
      // Self-serve guest access: anyone with a plausible email gets in as a
      // non-admin guest, automatically — see the file-level comment above.
      // `ON CONFLICT ... DO NOTHING` matters here: a race with another
      // request for the same brand-new address (or with an admin adding
      // this exact address at the same moment) must never downgrade an
      // existing admin row to a guest one.
      try {
        await sql`
          INSERT INTO allowed_emails (email, is_admin, added_by)
          VALUES (${lowerEmail}, false, 'self-serve')
          ON CONFLICT (email) DO NOTHING
        `;
        invalidateAllowlistCache();
      } catch (err) {
        res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(formPage({ next, error: 'Could not set up guest access right now (database unreachable). Try again in a moment.' }));
        return;
      }
    }

    await recordLoginEvent(req, lowerEmail);

    const sessionToken = await signToken({ email: lowerEmail }, secret, SESSION_MAX_AGE);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${sessionToken}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
    );
    res.writeHead(302, { Location: next });
    res.end();
    return;
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).send('Method not allowed');
}
