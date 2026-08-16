-- allowed_emails — the sign-in allowlist, managed from inside the app
-- (the "Manage Access" panel, admins only) instead of the
-- ALLOWED_EMAILS / ADMIN_EMAILS environment variables.
--
-- Run this ONCE against your database (Vercel dashboard > Storage > your
-- DB > Query, or `psql "$POSTGRES_URL" -f sql/allowed_emails.sql` after
-- `vercel env pull .env.local`) — same way you ran sql/schema.sql.

CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  added_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed yourself as the first admin. This step is REQUIRED — until this
-- row exists, nobody (including you) can sign in, because middleware.js
-- checks this table instead of an env var now. Edit the address below
-- before running if needed.
INSERT INTO allowed_emails (email, is_admin, added_by)
VALUES ('sebastien.bouthillette@spatialisos.com', true, 'seed')
ON CONFLICT (email) DO UPDATE SET is_admin = true;
