// api/auth/login.js — the whole sign-in gate: a plain HTML form asking for
// an email address, checked against the `allowed_emails` table (see
// sql/allowed_emails.sql), managed from the in-app "Manage Access" panel.
//
// IMPORTANT: this does NOT verify that the visitor actually owns the email
// they type in — there's no confirmation link, no password, no external
// identity provider. It only checks "is this address on the list". That's
// a deliberate simplicity/security tradeoff: no OAuth client to register,
// no third-party dependency — in exchange for weaker guarantees than a
// real sign-in. Anyone who *knows* an allowed address can type it in and
// get a session as that address. Only rely on this if the people who
// might abuse that are already people you trust (e.g. a small internal
// team), not as a defense against a motivated outside attacker.
import { sql } from '@vercel/postgres';
import { signToken, SESSION_COOKIE, SESSION_MAX_AGE } from '../../lib/session.js';
import { getAllowlist } from '../../lib/allowlist.js';

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

function formPage({ next, error }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Dynamic Spatial Model Builder</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 400px; margin: 96px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p.sub { color: #666; margin-top: 0; }
  input[type=email] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; margin: 12px 0; }
  button { width: 100%; padding: 10px 12px; font-size: 1rem; border: none; border-radius: 6px; background: #1a1a1a; color: #fff; cursor: pointer; }
  button:hover { background: #333; }
  .error { background: #fdecea; color: #b3261e; padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 0.9rem; }
</style>
</head><body>
  <h1>Sign in</h1>
  <p class="sub">Enter your email to access the Dynamic Spatial Model Builder.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/api/auth/login">
    <input type="email" name="email" placeholder="you@example.com" required autofocus />
    <input type="hidden" name="next" value="${escapeHtml(next)}" />
    <button type="submit">Continue</button>
  </form>
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

    let allowlist;
    try {
      // A fresh sign-in should see the just-edited list, not a stale cache.
      allowlist = await getAllowlist({ fresh: true });
    } catch (err) {
      res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(formPage({ next, error: 'Could not check the access list right now (database unreachable). Try again in a moment.' }));
      return;
    }

    if (!allowlist.has(email.toLowerCase())) {
      res.status(403).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(formPage({
        next,
        error: `${email} is not on the access list. Ask an admin to add it, or try a different address.`
      }));
      return;
    }

    await recordLoginEvent(req, email.toLowerCase());

    const sessionToken = await signToken({ email: email.toLowerCase() }, secret, SESSION_MAX_AGE);
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
