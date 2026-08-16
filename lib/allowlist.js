// lib/allowlist.js — reads/writes the `allowed_emails` table (see
// sql/allowed_emails.sql), which replaced the ALLOWED_EMAILS/ADMIN_EMAILS
// env vars as the source of truth for who can sign in and who's an admin.
// Used by middleware.js (Edge runtime) to gate every request, and by the
// Node auth/admin routes to check and manage the list.
//
// Edge reads go through a short in-memory cache so a single page load's
// dozen-odd asset requests don't each hit the database — the tradeoff is
// that removing someone can take up to CACHE_TTL_MS to actually take
// effect, instead of being instant (it was instant when this was an env
// var check, at the cost of needing a redeploy to change the list at
// all). Writes (add/remove/promote) go straight to the database and then
// drop the cache so this same warm instance picks up the change on its
// very next read.
import { sql } from '@vercel/postgres';

const CACHE_TTL_MS = 30_000;
let cache = null; // { emails: Map<lowercased email, isAdmin boolean>, fetchedAt: number }

export async function getAllowlist({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.emails;
  try {
    const { rows } = await sql`SELECT email, is_admin FROM allowed_emails`;
    const emails = new Map(rows.map((r) => [String(r.email).toLowerCase(), r.is_admin === true]));
    cache = { emails, fetchedAt: now };
    return emails;
  } catch (err) {
    // Database unreachable: keep serving the last known-good list rather
    // than locking everyone out (or, worse, opening the app to everyone)
    // over a transient blip. If we've never successfully fetched, there's
    // nothing to fall back to — let the error propagate so the caller can
    // fail closed.
    if (cache) return cache.emails;
    throw err;
  }
}

export function invalidateAllowlistCache() {
  cache = null;
}
