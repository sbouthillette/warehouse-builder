// lib/loginEvents.js — best-effort visit logging for the admin-only
// "Visitor Log" panel (see sql/login_events.sql and
// api/admin/login-history.js). Called only from api/auth/verify.js, once a
// sign-in has actually been proven with a valid code — a row here means
// someone really did complete a sign-in, not just submit an email address.
import { sql } from '@vercel/postgres';

export async function recordLoginEvent(req, email) {
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
    // Never let a logging failure block someone from actually signing in.
    console.error('Could not record login event', err);
  }
}
