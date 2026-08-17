// api/admin/login-history.js — backs the in-app "Visitor Log" panel
// (js/main.js): for every address on the sign-in allowlist (see
// sql/allowed_emails.sql), how many times they've actually signed in and
// when, from the login_events table (see sql/login_events.sql). Answers
// "I emailed people the app URL — who actually showed up?"
//
// Two shapes, both admin-only:
//   GET /api/admin/login-history               -> one row per address
//       (aggregated: visit count, first/last visit) — what the on-screen
//       table renders.
//   GET /api/admin/login-history?format=events  -> one row per individual
//       sign-in (email, timestamp, user agent, ip), most recent first —
//       what the "Export Visit Log" button downloads, since "how many
//       times" doesn't answer "show me every time they connected."
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

  const wantEvents = req.query.format === 'events';

  try {
    if (wantEvents) {
      // One row per sign-in, not per address — this is the "every time
      // they connected" view, for the Export Visit Log button. Joined
      // against allowed_emails only to tag admin rows in the export; an
      // event for an address later removed from the allowlist still shows
      // (is_admin comes back false in that case), since the visit itself
      // still happened.
      //
      // demo_bookings is pre-aggregated into its own subquery (per email)
      // before joining — joining the raw table directly here would fan out
      // each login_events row once per matching demo_bookings row.
      const { rows } = await sql`
        SELECT
          le.email,
          COALESCE(ae.is_admin, false) AS is_admin,
          le.logged_in_at,
          le.user_agent,
          le.ip,
          COALESCE(db.demo_count, 0)::int AS demo_count
        FROM login_events le
        LEFT JOIN allowed_emails ae ON ae.email = le.email
        LEFT JOIN (
          SELECT email, COUNT(*)::int AS demo_count
          FROM demo_bookings
          GROUP BY email
        ) db ON db.email = le.email
        ORDER BY le.logged_in_at DESC
      `;
      res.status(200).json(rows.map((r) => ({
        email: r.email,
        isAdmin: r.is_admin === true,
        loggedInAt: r.logged_in_at,
        userAgent: r.user_agent,
        ip: r.ip,
        demoCount: r.demo_count
      })));
      return;
    }

    // LEFT JOIN so someone who was invited but has never signed in still
    // shows up, with visitCount 0 and null first/last visit — that's the
    // whole point of this panel (who from the invite list hasn't visited).
    //
    // login_events and demo_bookings are each pre-aggregated into their own
    // subquery (per email) before joining into allowed_emails — joining
    // both "many" tables directly in one GROUP BY would fan out into a
    // cartesian product and inflate visit_count/demo_count.
    const { rows } = await sql`
      SELECT
        ae.email,
        ae.is_admin,
        ae.created_at AS invited_at,
        COALESCE(le.visit_count, 0)::int AS visit_count,
        le.first_visit,
        le.last_visit,
        COALESCE(db.demo_count, 0)::int AS demo_count,
        db.last_demo
      FROM allowed_emails ae
      LEFT JOIN (
        SELECT email, COUNT(*)::int AS visit_count,
          MIN(logged_in_at) AS first_visit, MAX(logged_in_at) AS last_visit
        FROM login_events
        GROUP BY email
      ) le ON le.email = ae.email
      LEFT JOIN (
        SELECT email, COUNT(*)::int AS demo_count, MAX(scheduled_at) AS last_demo
        FROM demo_bookings
        GROUP BY email
      ) db ON db.email = ae.email
      ORDER BY le.last_visit DESC NULLS LAST, ae.created_at ASC
    `;
    res.status(200).json(rows.map((r) => ({
      email: r.email,
      isAdmin: r.is_admin === true,
      invitedAt: r.invited_at,
      visitCount: r.visit_count,
      firstVisit: r.first_visit,
      lastVisit: r.last_visit,
      demoCount: r.demo_count,
      lastDemo: r.last_demo
    })));
  } catch (err) {
    console.error(err);
    // Most likely cause: sql/login_events.sql or sql/demo_bookings.sql
    // hasn't been run against this database yet. Say so plainly instead of
    // a bare 500.
    res.status(500).json({
      error: 'Could not load visitor log. If this is the first time you\'re seeing this, ' +
        'make sure sql/login_events.sql and sql/demo_bookings.sql have both been run against the database.',
      detail: String(err?.message || err)
    });
  }
}
