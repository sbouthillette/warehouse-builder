// api/admin/login-history.js — backs the in-app "Visitor Log" panel
// (js/main.js): for every address on the sign-in allowlist (see
// sql/allowed_emails.sql), how many times they've actually signed in and
// when, from the login_events table (see sql/login_events.sql). Answers
// "I emailed people the app URL — who actually showed up?"
//
// Admin-only, same pattern as api/admin/allowed-emails.js: this route
// re-checks admin status itself rather than trusting middleware.js, which
// only checks that a visitor is *on* the list, not that they're an admin.
import { sql } from '@vercel/postgres';
import { verifyToken, SESSION_COOKIE } from '../../lib/session.js';
import { getAllowlist } from '../../lib/allowlist.js';

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let callerEmail;
  try {
    callerEmail = await requireAdmin(req, res);
  } catch (err) {
    res.status(502).json({ error: 'Could not verify admin access (database unreachable)' });
    return;
  }
  if (!callerEmail) return; // requireAdmin already sent the response

  try {
    // LEFT JOIN so someone who was invited but has never signed in still
    // shows up, with visitCount 0 and null first/last visit — that's the
    // whole point of this panel (who from the invite list hasn't visited).
    const { rows } = await sql`
      SELECT
        ae.email,
        ae.is_admin,
        ae.created_at AS invited_at,
        COUNT(le.id)::int AS visit_count,
        MIN(le.logged_in_at) AS first_visit,
        MAX(le.logged_in_at) AS last_visit
      FROM allowed_emails ae
      LEFT JOIN login_events le ON le.email = ae.email
      GROUP BY ae.email, ae.is_admin, ae.created_at
      ORDER BY last_visit DESC NULLS LAST, ae.created_at ASC
    `;
    res.status(200).json(rows.map((r) => ({
      email: r.email,
      isAdmin: r.is_admin === true,
      invitedAt: r.invited_at,
      visitCount: r.visit_count,
      firstVisit: r.first_visit,
      lastVisit: r.last_visit
    })));
  } catch (err) {
    console.error(err);
    // Most likely cause: sql/login_events.sql hasn't been run against this
    // database yet. Say so plainly instead of a bare 500.
    res.status(500).json({
      error: 'Could not load visitor log. If this is the first time you\'re seeing this, ' +
        'make sure sql/login_events.sql has been run against the database.',
      detail: String(err?.message || err)
    });
  }
}
