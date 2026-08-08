// api/auth/callback.js — Google redirects here after sign-in. Exchanges the
// authorization code for tokens, verifies the ID token server-side (via
// Google's tokeninfo endpoint, which validates the signature/expiry/audience
// for us — avoids implementing JWKS/RS256 verification from scratch), checks
// the account's Workspace domain against ALLOWED_GOOGLE_DOMAIN, and only
// then issues the session cookie that middleware.js actually checks on
// every subsequent request.
import { signToken, verifyToken, SESSION_COOKIE, SESSION_MAX_AGE } from '../../lib/session.js';

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function denyPage(res, status, message) {
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
    <h2>Sign-in failed</h2>
    <p>${message}</p>
    <p><a href="/api/auth/login">Try again</a></p>
  </body></html>`);
}

export default async function handler(req, res) {
  const { code, state, error } = req.query;
  if (error) {
    denyPage(res, 403, `Sign-in was cancelled or denied by Google: ${escapeHtml(String(error))}`);
    return;
  }

  const secret = process.env.SESSION_SECRET;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const domain = process.env.ALLOWED_GOOGLE_DOMAIN;
  if (!secret || !clientId || !clientSecret || !domain) {
    denyPage(res, 500, 'Google sign-in is not fully configured on the server. Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_GOOGLE_DOMAIN, and SESSION_SECRET in the Vercel project settings.');
    return;
  }

  const stateBody = await verifyToken(typeof state === 'string' ? state : null, secret);
  if (!stateBody) {
    denyPage(res, 400, 'This sign-in link expired or was tampered with. Go back and try again.');
    return;
  }
  if (!code || typeof code !== 'string') {
    denyPage(res, 400, 'Google did not return an authorization code.');
    return;
  }

  const redirectUri = `${baseUrl(req)}/api/auth/callback`;
  let tokenJson;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    if (!tokenRes.ok) {
      denyPage(res, 502, 'Google rejected the sign-in request (the authorization code may have expired). Try again.');
      return;
    }
    tokenJson = await tokenRes.json();
  } catch (e) {
    denyPage(res, 502, 'Could not reach Google to complete sign-in. Try again.');
    return;
  }

  const idToken = tokenJson.id_token;
  if (!idToken) {
    denyPage(res, 502, 'Google did not return an ID token.');
    return;
  }

  let claims;
  try {
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!infoRes.ok) {
      denyPage(res, 502, 'Could not verify the Google sign-in token.');
      return;
    }
    claims = await infoRes.json();
  } catch (e) {
    denyPage(res, 502, 'Could not verify the Google sign-in token.');
    return;
  }

  const emailOk = !!claims.email && claims.email_verified === 'true';
  const claimDomain = (claims.hd || (claims.email || '').split('@')[1] || '').toLowerCase();
  const audOk = claims.aud === clientId;
  const domainOk = claimDomain === domain.toLowerCase();

  if (!emailOk || !audOk || !domainOk) {
    denyPage(
      res, 403,
      `Access is restricted to <strong>@${escapeHtml(domain)}</strong> Google Workspace accounts. ` +
      `You signed in as <strong>${escapeHtml(claims.email || 'an unknown account')}</strong>, which isn't on that domain. ` +
      `Sign out of that Google account or choose a different one.`
    );
    return;
  }

  const sessionToken = await signToken({ email: claims.email, domain: claimDomain }, secret, SESSION_MAX_AGE);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${sessionToken}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
  );

  const next = typeof stateBody.next === 'string' && stateBody.next.startsWith('/') && !stateBody.next.startsWith('//')
    ? stateBody.next
    : '/';
  res.writeHead(302, { Location: next });
  res.end();
}
