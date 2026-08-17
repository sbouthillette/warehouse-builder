// api/record-demo-scheduled.js — records that the signed-in visitor just
// completed a Calendly booking via the "Schedule a Full Demo" button (see
// js/main.js, setupScheduleDemoButton), so the admin-only Visitor Log can
// show who's actually scheduled a demo, not just who's signed in.
//
// Identity comes from the session cookie, never from the request body —
// otherwise anyone could POST an arbitrary email here and make it look
// like someone else booked a demo.
//
// This only captures "a booking happened, at this moment" — not the
// actual booked appointment time, which lives in Calendly/your calendar.
// See sql/demo_bookings.sql for why (avoiding a Calendly API token).
import { sql } from '@vercel/postgres';
import { verifyToken, SESSION_COOKIE } from '../lib/session.js';

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.SESSION_SECRET;
  const session = secret ? await verifyToken(getCookie(req, SESSION_COOKIE), secret) : null;
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  try {
    await sql`INSERT INTO demo_bookings (email) VALUES (${String(session.email).toLowerCase()})`;
    res.status(204).end();
  } catch (err) {
    console.error('Could not record demo booking', err);
    // Most likely cause: sql/demo_bookings.sql hasn't been run against
    // this database yet.
    res.status(500).json({ error: 'Could not record the booking (database unreachable)' });
  }
}
