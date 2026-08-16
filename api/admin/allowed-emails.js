// api/admin/allowed-emails.js — CRUD for the sign-in allowlist, backing the
// in-app "Manage Access" panel (js/main.js). Every method requires the
// caller to already be an admin in the allowed_emails table — middleware.js
// only checks that a visitor is *on* the list, not that they're an admin,
// so this route re-checks admin status itself before doing anything.
import { sql } from '@vercel/postgres';
import { verifyToken, SESSION_COOKIE } from '../../lib/session.js';
import { getAllowlist, invalidateAllowlistCache } from '../../lib/allowlist.js';

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns the caller's lowercased email if they're a signed-in admin,
// otherwise writes the appropriate error response and returns null.
async function requireAdmin(req, res) {
  const secret = process.env.SESSION_SECRET;
  const session = secret ? await verifyToken(getCookie(req, SESSION_COOKIE), secret) : null;
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return null;
  }
  const email = String(session.email).toLowerCase();
  const allowlist = await getAllowlist({ fresh: true });
  if (allowlist.get(email) !== true) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return email;
}

// True if `email` is currently the only admin on the list — used to block
// actions that would leave nobody able to manage access (or sign in, for
// a delete) at all.
async function isLastAdmin(email) {
  const { rows } = await sql`SELECT email FROM allowed_emails WHERE is_admin = true`;
  return rows.length === 1 && String(rows[0].email).toLowerCase() === email;
}

export default async function handler(req, res) {
  let callerEmail;
  try {
    callerEmail = await requireAdmin(req, res);
  } catch (err) {
    res.status(502).json({ error: 'Could not verify admin access (database unreachable)' });
    return;
  }
  if (!callerEmail) return; // requireAdmin already sent the response

  try {
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT email, is_admin, added_by, created_at FROM allowed_emails ORDER BY created_at ASC
      `;
      res.status(200).json(rows.map((r) => ({
        email: r.email,
        isAdmin: r.is_admin === true,
        addedBy: r.added_by,
        createdAt: r.created_at
      })));
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const email = String(body.email || '').trim().toLowerCase();
      const isAdmin = body.isAdmin === true;

      if (!email || !EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'Enter a valid email address' });
        return;
      }
      if (!isAdmin && (await isLastAdmin(email))) {
        res.status(400).json({ error: "Can't remove admin from the last remaining admin — promote someone else first." });
        return;
      }

      await sql`
        INSERT INTO allowed_emails (email, is_admin, added_by)
        VALUES (${email}, ${isAdmin}, ${callerEmail})
        ON CONFLICT (email) DO UPDATE SET is_admin = ${isAdmin}
      `;
      invalidateAllowlistCache();
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const email = String(req.query.email || '').trim().toLowerCase();
      if (!email) {
        res.status(400).json({ error: 'Missing email' });
        return;
      }
      if (await isLastAdmin(email)) {
        res.status(400).json({ error: "Can't remove the last remaining admin — promote someone else first." });
        return;
      }
      await sql`DELETE FROM allowed_emails WHERE email = ${email}`;
      invalidateAllowlistCache();
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error', detail: String(err?.message || err) });
  }
}
