// lib/mailer.js — sends the sign-in verification code by email, via Google
// Workspace SMTP (smtp.gmail.com) using an app password rather than a
// third-party transactional-email provider — see SETUP_EMAIL_AUTH.md for
// why (mainly: spatialisos.com's mail is already on Workspace, so SPF/DKIM
// for outbound mail can piggyback on that instead of standing up and
// verifying a whole new sending domain with a separate provider).
//
// Needs two env vars set in Vercel (see SETUP_EMAIL_AUTH.md step 1e):
//   GMAIL_USER          the Workspace mailbox to send from, e.g.
//                        verify@spatialisos.com
//   GMAIL_APP_PASSWORD  a 16-character app password for that mailbox
//                        (Google Account > Security > 2-Step Verification
//                        > App passwords — requires 2-Step Verification to
//                        be turned on for the sending account first)
import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD are not set — see SETUP_EMAIL_AUTH.md');
  }
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return transporter;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// No external image (logo) in this email on purpose — an <img> pointing at
// the app's own domain would break if that domain isn't the one someone
// eventually deploys to, and most email clients block remote images by
// default anyway until the recipient clicks "show images." Plain, clean
// HTML with the brand color as text renders correctly everywhere with zero
// dependency on the app's deployed URL.
function codeEmailHtml(code) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f1ea;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ea;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:420px;background:#ffffff;border-radius:14px;padding:32px 28px;">
        <tr><td align="center" style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#C97E0D;font-weight:700;padding-bottom:8px;">Spatialis OS</td></tr>
        <tr><td align="center" style="font-size:20px;color:#1a1a18;font-weight:700;padding-bottom:16px;">Your sign-in code</td></tr>
        <tr><td align="center" style="font-size:36px;letter-spacing:0.15em;font-weight:700;color:#1a1a18;background:#f5f1ea;border-radius:8px;padding:14px 0;">${escapeHtml(code)}</td></tr>
        <tr><td align="center" style="font-size:13px;color:#5f5e5a;padding-top:16px;">Enter this code on the sign-in page to continue. It expires in 10 minutes.</td></tr>
        <tr><td align="center" style="font-size:12px;color:#8a8983;padding-top:20px;">Didn't request this? You can safely ignore this email — nobody can access anything without this code.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function sendVerificationCode(email, code) {
  const fromName = process.env.GMAIL_FROM_NAME || 'Spatialis OS';
  await getTransporter().sendMail({
    from: `"${fromName}" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `${code} is your Spatialis OS sign-in code`,
    text: `Your Spatialis OS sign-in code is ${code}. It expires in 10 minutes.\n\nDidn't request this? You can safely ignore this email.`,
    html: codeEmailHtml(code),
  });
}
