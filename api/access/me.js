// api/access/me.js — tells the front end who's signed in, and whether that
// address is an admin in the allowed_emails table (see
// sql/allowed_emails.sql). Used to show/hide admin-only UI: the
// whole-project Export JSON / Import JSON controls, and the "Manage
// Access" panel itself.
//
// NOTE: this only gates the UI. The underlying warehouse data is already
// visible to any signed-in user through the app itself (2D/3D views,
// tables, etc.) — hiding the JSON export/import shortcut and the access
// list keeps non-admins from grabbing/overwriting the raw project file or
// changing who's allowed in, but it is not a data-access boundary. Don't
// rely on it as one.
import { verifyToken, SESSION_COOKIE } from '../../lib/session.js';
import { getAllowlist } from '../../lib/allowlist.js';

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  const session = secret ? await verifyToken(getCookie(req, SESSION_COOKIE), secret) : null;

  if (!session || !session.email) {
    res.status(401).json({ email: null, isAdmin: false });
    return;
  }

  const email = String(session.email).toLowerCase();
  let isAdmin = false;
  try {
    const allowlist = await getAllowlist();
    isAdmin = allowlist.get(email) === true;
  } catch (err) {
    // Database unreachable — leave isAdmin false rather than fail the
    // whole request; the admin-only UI just stays hidden until it recovers.
  }
  res.status(200).json({ email, isAdmin });
}
