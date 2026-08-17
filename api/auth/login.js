// api/auth/login.js — step 1 of the sign-in gate: a branded HTML form
// asking for an email address, which on submit gets a one-time 6-digit
// code emailed to it (see lib/mailer.js and lib/loginCodes.js). Step 2,
// checking that code and actually signing someone in, is
// api/auth/verify.js — this file never sets a session cookie and never
// touches the `allowed_emails` table itself.
//
// This code step exists specifically to keep bots and randomly-typed
// addresses out: before it existed, typing *any* email-shaped string got
// you a guest session immediately, no proof you owned that address. Now
// getting in requires reading a code out of that inbox, which a bot
// guessing addresses (or a human fat-fingering someone else's) can't do.
//
// Self-serve guest access is still the model — nobody has to be
// pre-approved — it's just proven-self-serve now: an address that isn't
// already on `allowed_emails` gets auto-added as a non-admin guest once
// (and only once) its code is verified. Admins are the exception to that:
// those rows are seeded/promoted only via the in-app "Manage Access" panel
// (api/admin/allowed-emails.js), never by this self-serve path.
import { sql } from '@vercel/postgres';
import { formPage, codeFormPage, safeNext, EMAIL_RE } from '../../lib/authPages.js';
import { generateCode, hashCode, CODE_TTL_MS, RESEND_COOLDOWN_MS } from '../../lib/loginCodes.js';
import { sendVerificationCode } from '../../lib/mailer.js';

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

    // Cooldown check: if this address was already sent a code very
    // recently, don't send another one. This isn't just about not being
    // annoying — without it, this form is an open "email anyone,
    // repeatedly, on demand" tool (type a stranger's real address, hit
    // submit in a loop), and it also protects the sending mailbox from
    // tripping Google's rate limits.
    let existing;
    try {
      const { rows } = await sql`SELECT created_at FROM login_codes WHERE email = ${lowerEmail}`;
      existing = rows[0] || null;
    } catch (err) {
      res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(formPage({ next, error: 'Could not start sign-in right now (database unreachable). Try again in a moment.' }));
      return;
    }

    const onCooldown = !!existing && (Date.now() - new Date(existing.created_at).getTime()) < RESEND_COOLDOWN_MS;

    if (!onCooldown) {
      const code = generateCode();
      try {
        const codeHash = await hashCode(secret, lowerEmail, code);
        await sql`
          INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at)
          VALUES (${lowerEmail}, ${codeHash}, ${new Date(Date.now() + CODE_TTL_MS).toISOString()}, 0, now())
          ON CONFLICT (email) DO UPDATE SET
            code_hash = EXCLUDED.code_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            created_at = now()
        `;
      } catch (err) {
        res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(formPage({ next, error: 'Could not start sign-in right now (database unreachable). Try again in a moment.' }));
        return;
      }

      try {
        await sendVerificationCode(lowerEmail, code);
      } catch (err) {
        console.error('Could not send verification email', err);
        res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(formPage({ next, error: "Couldn't send the verification email right now. Try again in a moment." }));
        return;
      }
    }

    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(codeFormPage({ email: lowerEmail, next, error: null, justSent: !onCooldown }));
    return;
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).send('Method not allowed');
}
