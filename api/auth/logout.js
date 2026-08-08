// api/auth/logout.js — clears the session cookie and sends the visitor back
// to Google sign-in. Plain GET link (see the Sign Out link in index.html)
// rather than a form/fetch call, since there's nothing sensitive about the
// action itself.
import { SESSION_COOKIE } from '../../lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  res.writeHead(302, { Location: '/api/auth/login' });
  res.end();
}
