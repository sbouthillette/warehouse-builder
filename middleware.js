// middleware.js — Vercel Edge Middleware. Runs on every request except the
// auth routes themselves (see `matcher` below); redirects to the email
// sign-in form unless a valid, unexpired session cookie proves the visitor
// signed in with an address in the `allowed_emails` table (see
// sql/allowed_emails.sql and lib/allowlist.js). The allowlist is re-checked
// on every request (through a short in-memory cache — see lib/allowlist.js),
// so removing someone revokes their access without waiting for their
// session cookie to expire.
//
// EMERGENCY OFF SWITCH: if this ever locks everyone out (bad migration,
// database unreachable, etc.), delete or rename this file and redeploy.
// The app falls back to fully open access immediately — no other change
// needed.
import { verifyToken, SESSION_COOKIE } from './lib/session.js';
import { getAllowlist } from './lib/allowlist.js';

export const config = {
  // Everything except /api/auth/* (the login/logout routes must stay
  // reachable to unauthenticated visitors, or nobody could ever sign in).
  // This covers the static app shell, every other /api route, and all
  // pages.
  matcher: ['/((?!api/auth/).*)']
};

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function middleware(request) {
  const secret = process.env.SESSION_SECRET;

  if (secret) {
    const cookie = getCookie(request, SESSION_COOKIE);
    const session = await verifyToken(cookie, secret);
    if (session && session.email) {
      try {
        const allowlist = await getAllowlist();
        if (allowlist.has(String(session.email).toLowerCase())) {
          return; // authenticated — let the request through
        }
      } catch (err) {
        // Database unreachable and no cached allowlist to fall back on yet
        // — fail closed (send to login) rather than opening the app to
        // everyone. Falls through to the redirect below.
      }
    }
  }

  const url = new URL(request.url);
  const loginUrl = new URL('/api/auth/login', url.origin);
  loginUrl.searchParams.set('next', url.pathname);
  return Response.redirect(loginUrl, 302);
}
