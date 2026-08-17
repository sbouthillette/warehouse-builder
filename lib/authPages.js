// lib/authPages.js — shared HTML for the sign-in flow (api/auth/login.js
// step 1: email -> code sent; api/auth/verify.js step 2: code -> signed
// in). Pulled out to one file so both routes render byte-identical cards
// instead of two copies of the same CSS drifting apart over time.
//
// Reuses the app's own stylesheet, fonts and logo (all served as static
// files, reachable from these API routes the same as from index.html)
// rather than duplicating the design system inline — only the
// page-specific layout (the centered card; there's no #app shell here to
// hang off of) lives in the local <style> blocks below.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only ever accept a same-site path for the post-login redirect — never let
// this become an open redirect to an attacker-controlled URL.
export function safeNext(raw) {
  const next = typeof raw === 'string' ? raw : '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HEAD = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#ffffff" />
<link rel="icon" href="/icons/icon-192.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Barlow+Semi+Condensed:wght@500&family=Barlow+Condensed:wght@700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/css/style.css" />`;

const CARD_STYLE = `
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: var(--sp-6); box-sizing: border-box; }
  .auth-card {
    width: 100%;
    max-width: 400px;
    text-align: center;
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid var(--glass-border-soft);
    border-radius: var(--radius-lg);
    padding: var(--sp-8) var(--sp-6);
    box-shadow: var(--glass-inset-highlight), var(--glass-shadow-lifted);
    box-sizing: border-box;
  }
  .auth-logo { width: 200px; max-width: 70%; height: auto; margin: 0 auto var(--sp-6); display: block; }
  .auth-card h1 {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    font-size: 26px;
    margin: 0 0 4px;
    color: var(--ink);
  }
  .auth-tagline { margin: 0 0 var(--sp-6); font-size: 14px; color: var(--ink-secondary); }
  .auth-card input[type=email], .auth-card input[type=text] {
    width: 100%;
    box-sizing: border-box;
    background: var(--glass-bg-strong);
    border: 1px solid var(--glass-border-soft);
    border-radius: var(--radius-sm);
    padding: 11px 14px;
    font-family: 'Barlow', sans-serif;
    font-size: 15px;
    color: var(--ink);
    margin: 0 0 var(--sp-3);
  }
  .auth-card input[type=text].auth-code-input {
    text-align: center;
    font-size: 26px;
    letter-spacing: 0.3em;
    font-weight: 700;
    padding-left: 0;
    padding-right: 0;
  }
  .auth-card input:focus {
    outline: none;
    border-color: var(--primary-2);
    box-shadow: 0 0 0 3px rgba(201, 126, 13, 0.18);
  }
  .auth-card button[type=submit] { width: 100%; }
  .auth-error {
    background: var(--status-danger-bg);
    color: var(--status-danger-text);
    border-radius: var(--radius-sm);
    padding: var(--sp-2) var(--sp-3);
    margin: 0 0 var(--sp-3);
    font-size: 13px;
    text-align: left;
  }
  .auth-hint {
    background: var(--glass-bg-tint);
    color: var(--ink-secondary);
    border-radius: var(--radius-sm);
    padding: var(--sp-2) var(--sp-3);
    margin: 0 0 var(--sp-3);
    font-size: 13px;
    text-align: left;
  }
  .auth-check { width: 56px; height: 56px; border-radius: 50%; background: var(--status-success-bg); color: var(--status-success-text); display: flex; align-items: center; justify-content: center; margin: 0 auto var(--sp-4); font-size: 28px; line-height: 1; }
  .auth-footnote { margin: var(--sp-6) 0 0; font-size: 12px; color: var(--ink-secondary); }
  .auth-footnote a { color: var(--ink-secondary); }
  a.btn { text-decoration: none; display: inline-block; }
`;

// Step 1: ask for an email address.
export function formPage({ next, error }) {
  return `<!DOCTYPE html><html lang="en"><head>${HEAD}
<title>Sign in — Dynamic Spatial Model Builder</title>
<style>${CARD_STYLE}</style>
</head><body>
  <div class="auth-card">
    <img class="auth-logo" src="/assets/logo/spatialis-horizontal-colour.png" alt="Spatialis OS" />
    <h1>Dynamic Spatial Model Builder</h1>
    <p class="auth-tagline">Spatialis OS · Explore a live digital twin of your warehouse</p>
    ${error ? `<div class="auth-error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/api/auth/login">
      <input type="email" name="email" placeholder="you@example.com" required autofocus />
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <button type="submit" class="btn btn-primary">Continue</button>
    </form>
    <p class="auth-footnote">Enter your email — we'll send you a one-time code to confirm it's you.</p>
  </div>
</body></html>`;
}

// Step 2: enter the code that was just emailed. `justSent: false` means we
// hit the resend cooldown and didn't actually send a new code — the copy
// adjusts to say so rather than implying a fresh one just went out.
export function codeFormPage({ email, next, error, justSent = true }) {
  return `<!DOCTYPE html><html lang="en"><head>${HEAD}
<title>Enter your code — Dynamic Spatial Model Builder</title>
<style>${CARD_STYLE}</style>
</head><body>
  <div class="auth-card">
    <img class="auth-logo" src="/assets/logo/spatialis-horizontal-colour.png" alt="Spatialis OS" />
    <h1>Check your email</h1>
    <p class="auth-tagline">${justSent
      ? `We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>.`
      : `We already sent a code to <strong>${escapeHtml(email)}</strong> — check your inbox (and spam folder).`}</p>
    ${error ? `<div class="auth-error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/api/auth/verify">
      <input type="text" class="auth-code-input" name="code" placeholder="000000" inputmode="numeric" pattern="[0-9]*" maxlength="6" required autofocus autocomplete="one-time-code" />
      <input type="hidden" name="email" value="${escapeHtml(email)}" />
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <button type="submit" class="btn btn-primary">Verify</button>
    </form>
    <p class="auth-footnote">Code expires in 10 minutes. <a href="/api/auth/login?next=${encodeURIComponent(next)}">Use a different email</a></p>
  </div>
</body></html>`;
}

// Shown for ~1.5s right after a successful code verification, before
// continuing on to the app. Signing in used to redirect straight to `next`
// with no feedback at all — the app can take a moment to load (3D scene,
// etc.), so a silent redirect read as "nothing happened," and people were
// re-submitting the form to see if it "worked." This page's whole job is
// to be an unmissable "yes, you're in" moment before handing off to the
// app. Auto-continues via <meta refresh> (no JS dependency) with a manual
// link as a fallback for anyone who doesn't want to wait.
export function successPage({ next, email, isNewGuest }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="1.5;url=${escapeHtml(next)}" />
<title>Signed in — Dynamic Spatial Model Builder</title>
<meta name="theme-color" content="#ffffff" />
<link rel="icon" href="/icons/icon-192.png" />
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Barlow+Semi+Condensed:wght@500&family=Barlow+Condensed:wght@700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/css/style.css" />
<style>${CARD_STYLE}</style>
</head><body>
  <div class="auth-card">
    <div class="auth-check">&#10003;</div>
    <h1>You're in</h1>
    <p class="auth-tagline">${isNewGuest ? `Guest access created for ${escapeHtml(email)}.` : `Signed in as ${escapeHtml(email)}.`}</p>
    <a class="btn btn-primary" href="${escapeHtml(next)}">Continue to app &rarr;</a>
    <p class="auth-footnote">Redirecting automatically&hellip;</p>
  </div>
</body></html>`;
}
