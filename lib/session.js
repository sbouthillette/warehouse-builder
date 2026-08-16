// lib/session.js — signed, stateless tokens (HMAC-SHA256), zero dependencies.
// Shared by the Edge middleware (middleware.js) and the Node.js auth route
// (api/auth/login.js) — both runtimes expose Web Crypto (crypto.subtle,
// btoa, atob, TextEncoder/TextDecoder) globally, so this file works
// unmodified in either place. Used for the session cookie that proves a
// visitor signed in with an address on the ALLOWED_EMAILS list.

export const SESSION_COOKIE = 'sb_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 14; // 14 days, in seconds

function toBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  if (!secret) throw new Error('Missing SESSION_SECRET');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// Signs `payload` plus an expiry (`maxAgeSeconds` from now) into a compact
// `base64url(payload).base64url(signature)` token — same shape as a JWT in
// spirit, but intentionally minimal (no header, no alg negotiation) since
// both producer and consumer are this same file.
export async function signToken(payload, secret, maxAgeSeconds) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64Url(sig)}`;
}

// Verifies signature + expiry; returns the decoded payload object, or null
// if the token is missing, malformed, tampered with, or expired.
export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC', key, fromBase64Url(sigB64), new TextEncoder().encode(payloadB64)
    );
    if (!ok) return null;
    const body = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}
