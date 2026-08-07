-- Warehouse Builder — Vercel Postgres schema
-- Run this once against your database (Vercel dashboard > Storage > your DB > Query,
-- or `psql "$POSTGRES_URL" -f sql/schema.sql` after `vercel env pull .env.local`).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

CREATE TABLE IF NOT EXISTS warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Entire project payload: { version, warehouse, zones, bayTemplates, racks }
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Speeds up "most recently edited" listing in the warehouse switcher.
CREATE INDEX IF NOT EXISTS idx_warehouses_updated_at ON warehouses (updated_at DESC);
