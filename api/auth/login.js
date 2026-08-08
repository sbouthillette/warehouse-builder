// api/auth/login.js — starts the Google sign-in flow. The `hd` param is
// only a UX hint that pre-filters which accounts Google's chooser shows —
// it is NOT itself a security boundary (a user could still pick a non-
// Workspace account if they typed the URL directly). The real check
// happens server-side in api/auth/callback.js, which re-verifies the
// signed-in account's domain against ALLOWED_GOOGLE_DOMAIN before ever
// issuing a session cookie.
import { signToken } from '../../lib/session.js';

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const domain = process.env.ALLOWED_GOOGLE_DOMAIN;
  const secret = process.env.SESSION_SECRET;
  if (!clientId || !domain || !secret) {
    res.status(500).send(
      'Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID, ALLOWED_GOOGLE_DOMAIN, ' +
      'and SESSION_SECRET in the Vercel project\'s Environment Variables, then redeploy.'
    );
    return;
  }

  const rawNext = typeof req.query.next === 'string' ? req.query.next : '/';
  // Only ever accept a same-site path — never let this become an open
  // redirect to an attacker-controlled URL.
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  // `state` is a short-lived signed token (not a bare random string) so it
  // doubles as CSRF protection *and* a tamper-proof carrier for `next`,
  // without needing a second cookie round trip.
  const state = await signToken({ next }, secret, 600); // 10 minutes to complete sign-in

  const redirectUri = `${baseUrl(req)}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    hd: domain,
    prompt: 'select_account',
    state
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}
