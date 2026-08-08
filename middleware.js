// middleware.js — Vercel Edge Middleware. Runs on every request except the
// auth routes themselves (see `matcher` below); redirects to Google
// sign-in unless a valid, unexpired session cookie proves the visitor
// signed in with an account on ALLOWED_GOOGLE_DOMAIN. This file is the
// actual enforcement point — the `hd` hint on the Google consent screen
// (api/auth/login.js) is just a UX nicety, not a guarantee by itself.
//
// EMERGENCY OFF SWITCH: if this ever locks everyone out (misconfigured env
// vars, etc.), delete or rename this file and redeploy. The app falls back
// to fully open access immediately — no other change needed.
import { verifyToken, SESSION_COOKIE } from './lib/session.js';

export const config = {
  // Everything except /api/auth/* (the login/callback/logout routes must
  // stay reachable to unauthenticated visitors, or nobody could ever sign
  // in). This covers the static app shell, every other /api route, and all
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
  const domain = process.env.ALLOWED_GOOGLE_DOMAIN;

  if (secret && domain) {
    const cookie = getCookie(request, SESSION_COOKIE);
    const session = await verifyToken(cookie, secret);
    if (session && session.domain && session.domain.toLowerCase() === domain.toLowerCase()) {
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
