// api/auth/me.js — tells the front end who's signed in, and whether that
// address is on ADMIN_EMAILS. Used to show/hide admin-only UI (currently:
// the whole-project Export JSON / Import JSON controls in the top bar).
//
// NOTE: this only gates the UI. The underlying warehouse data is already
// visible to any signed-in user through the app itself (2D/3D views,
// tables, etc.) — hiding the JSON export/import shortcut keeps non-admins
// from grabbing/overwriting the raw project file in one click, but it is
// not a data-access boundary. Don't rely on it as one.
import { verifyToken, SESSION_COOKIE } from '../../lib/session.js';

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function parseEmailList(raw) {
  return String(raw || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  const session = secret ? await verifyToken(getCookie(req, SESSION_COOKIE), secret) : null;

  if (!session || !session.email) {
    res.status(401).json({ email: null, isAdmin: false });
    return;
  }

  const email = String(session.email).toLowerCase();
  const adminEmails = parseEmailList(process.env.ADMIN_EMAILS);
  res.status(200).json({ email, isAdmin: adminEmails.includes(email) });
}
