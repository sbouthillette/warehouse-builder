// api/auth/verify.js — step 2 of the sign-in gate: checks the 6-digit code
// emailed by api/auth/login.js against the `login_codes` table (see
// sql/login_codes.sql). Only on a correct, unexpired, not-too-many-wrong-
// guesses code does this route actually authenticate anyone: add a
// brand-new address to `allowed_emails` as a non-admin guest (self-serve,
// but now proven-self-serve — see api/auth/login.js's file comment for
// why that distinction matters), log the visit, and set the session
// cookie. A GET here (e.g. someone bookmarked or refreshed this URL) just
// bounces back to the start of the flow — there's no page to show without
// a code having been submitted.
import { sql } from '@vercel/postgres';
import { signToken, SESSION_COOKIE, SESSION_MAX_AGE } from '../../lib/session.js';
import { getAllowlist, invalidateAllowlistCache } from '../../lib/allowlist.js';
import { codeFormPage, successPage, safeNext } from '../../lib/authPages.js';
import { hashCode, MAX_ATTEMPTS } from '../../lib/loginCodes.js';
import { recordLoginEvent } from '../../lib/loginEvents.js';

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    res.status(500).send(
      "Email sign-in is not configured yet. Set SESSION_SECRET in the Vercel project's " +
      "Environment Variables, then redeploy."
    );
    return;
  }

  if (req.method === 'GET') {
    const next = safeNext(req.query.next);
    res.writeHead(302, { Location: `/api/auth/login?next=${encodeURIComponent(next)}` });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).send('Method not allowed');
    return;
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const next = safeNext(body.next);

  if (!email) {
    res.writeHead(302, { Location: `/api/auth/login?next=${encodeURIComponent(next)}` });
    res.end();
    return;
  }

  const invalid = (message) => {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(codeFormPage({ email, next, error: message, justSent: false }));
  };

  let row;
  try {
    const { rows } = await sql`SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ${email}`;
    row = rows[0] || null;
  } catch (err) {
    invalid('Could not check that code right now (database unreachable). Try again in a moment.');
    return;
  }

  if (!row) {
    invalid('That code has expired or was never sent. Request a new one below.');
    return;
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    // Expired codes are inert anyway (the timestamp check below would
    // catch them) but clearing the row means a fresh "Continue" click
    // right after generates a brand-new code instead of hitting the
    // resend cooldown for a code that's already dead.
    try { await sql`DELETE FROM login_codes WHERE email = ${email}`; } catch { /* best effort */ }
    invalid('That code has expired. Request a new one below.');
    return;
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    invalid('Too many incorrect attempts. Request a new code below.');
    return;
  }

  if (!code || !/^\d{6}$/.test(code)) {
    invalid('Enter the 6-digit code from your email.');
    return;
  }

  const candidateHash = await hashCode(secret, email, code);
  if (candidateHash !== row.code_hash) {
    const attemptsLeft = MAX_ATTEMPTS - (row.attempts + 1);
    try {
      await sql`UPDATE login_codes SET attempts = attempts + 1 WHERE email = ${email}`;
    } catch { /* best effort — worst case someone gets one extra guess */ }
    invalid(
      attemptsLeft > 0
        ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`
        : 'Incorrect code. Request a new one below.'
    );
    return;
  }

  // Code is correct — this address is now proven, not just typed. The code
  // is single-use, so delete it before doing anything else.
  try {
    await sql`DELETE FROM login_codes WHERE email = ${email}`;
  } catch (err) {
    // Non-fatal: worst case a spent code lingers until its own expiry (it
    // can't be reused for a *different* verification since a wrong-code
    // check compares against this same hash and this row is already
    // logically consumed) — don't block sign-in over cleanup failing.
  }

  let allowlist;
  try {
    allowlist = await getAllowlist({ fresh: true });
  } catch (err) {
    invalid('Could not check the access list right now (database unreachable). Try again in a moment.');
    return;
  }

  const isNewGuest = !allowlist.has(email);
  if (isNewGuest) {
    // ON CONFLICT DO NOTHING matters here: a race with another verify for
    // this exact address, or with an admin adding it by hand at the same
    // moment, must never downgrade an existing admin row to a guest one.
    try {
      await sql`
        INSERT INTO allowed_emails (email, is_admin, added_by)
        VALUES (${email}, false, 'self-serve')
        ON CONFLICT (email) DO NOTHING
      `;
      invalidateAllowlistCache();
    } catch (err) {
      invalid('Could not set up guest access right now (database unreachable). Try again in a moment.');
      return;
    }
  }

  await recordLoginEvent(req, email);

  const sessionToken = await signToken({ email }, secret, SESSION_MAX_AGE);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${sessionToken}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
  );
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(successPage({ next, email, isNewGuest }));
}
