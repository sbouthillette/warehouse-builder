// lib/loginCodes.js — generates and checks the one-time email verification
// codes used by the two-step sign-in flow (api/access/login.js sends one,
// api/access/verify.js checks it against the `login_codes` table — see
// sql/login_codes.sql). Web Crypto (crypto.subtle, crypto.getRandomValues)
// only, same as lib/session.js, so this works unmodified in either the
// Edge or Node runtime even though today only the Node auth routes use it.
//
// Codes are stored hashed (HMAC-SHA256 keyed with SESSION_SECRET, the same
// secret already used to sign session cookies — no new env var needed),
// not in plaintext, so a database read alone doesn't hand out a live code.

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000; // how long a sent code stays valid
export const MAX_ATTEMPTS = 5; // wrong guesses allowed before a code is dead
export const RESEND_COOLDOWN_MS = 30 * 1000; // min gap between codes sent to the same address

// Six random digits, zero-padded (e.g. "004821"). Uses getRandomValues
// rather than Math.random() so codes aren't predictable.
export function generateCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  // bytes[0] is 0..2^32-1; modulo 1e6 is very slightly biased toward lower
  // values (2^32 isn't a multiple of 1e6) but the skew is far too small
  // (< 0.00003%) to make any digit meaningfully guessable — fine for a
  // rate-limited, short-lived, attempt-capped code.
  return String(bytes[0] % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, '0');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Binds the hash to both the email and the code, so the same 6-digit code
// sent to two different addresses hashes differently (not that it matters
// much for a random code, but it's free and it's the same belt-and-braces
// pattern as lib/session.js).
export function hashCode(secret, email, code) {
  return hmac(secret, `${email}:${code}`);
}
