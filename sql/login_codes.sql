-- login_codes — one pending row per email address, holding the hashed
-- one-time verification code sent by api/access/login.js and checked by
-- api/access/verify.js. This is what stops a bot (or a stranger typing in
-- someone else's address) from getting a session just by knowing an
-- email — they also have to read the code out of that inbox.
--
-- Run this ONCE against your database (Vercel dashboard > Storage > your
-- DB > Query, or `psql "$POSTGRES_URL" -f sql/login_codes.sql` after
-- `vercel env pull .env.local`) — same way you ran sql/allowed_emails.sql
-- and sql/login_events.sql.

CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per email (not per attempt) is deliberate: requesting a new code
-- for the same address overwrites the old one via ON CONFLICT, so only the
-- most recently sent code is ever valid. Nothing here needs to be kept
-- around after it's used or expires — api/access/verify.js deletes the row
-- on a successful check, and an expired-but-never-deleted row is harmless
-- (it just always fails the expires_at check) and gets overwritten the
-- next time that address requests a code. If this table ever grows large
-- from abandoned attempts, it's safe to periodically
-- `DELETE FROM login_codes WHERE expires_at < now()`.
