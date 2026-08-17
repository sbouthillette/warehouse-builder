-- login_events — one row per successful sign-in, backing the admin-only
-- "Visitor Log" panel (js/main.js) that answers "who from my invite list
-- has actually shown up and signed in?"
--
-- Run this ONCE against your database (Vercel dashboard > Storage > your
-- DB > Query, or `psql "$POSTGRES_URL" -f sql/login_events.sql` after
-- `vercel env pull .env.local`) — same way you ran sql/schema.sql and
-- sql/allowed_emails.sql.

CREATE TABLE IF NOT EXISTS login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  ip TEXT
);

-- Speeds up the per-email aggregation the "Visitor Log" panel runs
-- (count/first/last per email, joined against allowed_emails).
CREATE INDEX IF NOT EXISTS idx_login_events_email ON login_events (email);
CREATE INDEX IF NOT EXISTS idx_login_events_logged_in_at ON login_events (logged_in_at DESC);
