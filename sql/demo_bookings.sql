-- demo_bookings — one row per completed Calendly booking made through the
-- "Schedule a Full Demo" button (js/main.js), backing a "Demos" column in
-- the admin-only Visitor Log panel (api/admin/login-history.js) so you can
-- see who from your invite list actually booked a demo, not just who
-- signed in.
--
-- A row here means Calendly's own popup told this page (via its
-- `calendly.event_scheduled` postMessage — see developer.calendly.com/
-- embed-api) that a booking really completed, captured by
-- api/record-demo-scheduled.js. It does NOT include the actual scheduled
-- appointment date/time — that would require Calendly's API and a
-- personal access token, which this project deliberately avoids (see
-- README.md, "Set up Schedule a Full Demo"). It also can't see bookings
-- made through the plain-navigation fallback in js/main.js (used if the
-- Calendly widget script didn't load) — that opens a real new tab with no
-- message-passing back to this page.
--
-- Run this ONCE against your database (Vercel dashboard > Storage > your
-- DB > Query, or `psql "$POSTGRES_URL" -f sql/demo_bookings.sql` after
-- `vercel env pull .env.local`) — same way you ran the other sql/*.sql
-- files.

CREATE TABLE IF NOT EXISTS demo_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_demo_bookings_email ON demo_bookings (email);
CREATE INDEX IF NOT EXISTS idx_demo_bookings_scheduled_at ON demo_bookings (scheduled_at DESC);
