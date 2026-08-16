// middleware.js — Vercel Edge Middleware. Runs on every request except the
// auth routes themselves (see `matcher` below); redirects to the email
// sign-in form unless a valid, unexpired session cookie proves the visitor
// signed in with an address on ALLOWED_EMAILS. The allowlist is re-checked
// on every request (not just at sign-in time), so removing an address from
// ALLOWED_EMAILS revokes access immediately, even for an existing session.
//
// EMERGENCY OFF SWITCH: if this ever locks everyone out (misconfigured env
// vars, etc.), delete or rename this file and redeploy. The app falls back
// to fully open access immediately — no other change needed.
import { verifyToken, SESSION_COOKIE } from './lib/session.js';

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

function parseAllowedEmails(raw) {
  return String(raw || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export default async function middleware(request) {
  const secret = process.env.SESSION_SECRET;
  const allowedEmails = parseAllowedEmails(process.env.ALLOWED_EMAILS);

  if (secret && allowedEmails.length > 0) {
    const cookie = getCookie(request, SESSION_COOKIE);
    const session = await verifyToken(cookie, secret);
    if (session && session.email && allowedEmails.includes(String(session.email).toLowerCase())) {
      return; // authenticated — let the request through
    }
  }
  // If env vars aren't set yet, this falls through to the login redirect
  // below rather than silently allowing everyone through — login.js shows
  // a clear "not configured" message instead of a broken redirect loop.

  const url = new URL(request.url);
  const loginUrl = new URL('/api/auth/login', url.origin);
  loginUrl.searchParams.set('next', url.pathname);
  return Response.redirect(loginUrl, 302);
}
