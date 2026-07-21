-- Add energeies_dikigoroi junction table
-- for many-to-many relationship: energeies ↔ dikigoroi_grafeiou
--
-- Note: This migration is idempotent (IF NOT EXISTS).
-- It was already executed manually in prod on 2026-07-21,
-- so on prod this will be a no-op (the tracking will record it as applied).

CREATE TABLE IF NOT EXISTS energeies_dikigoroi (
  aa                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  energeia_id           INTEGER NOT NULL REFERENCES energeies(aa) ON DELETE CASCADE,
  dikigoroi_grafeiou_id INTEGER NOT NULL REFERENCES dikigoroi_grafeiou(aa),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(energeia_id, dikigoroi_grafeiou_id)
);

CREATE INDEX IF NOT EXISTS idx_energeies_dikigoroi_energeia
  ON energeies_dikigoroi(energeia_id);

CREATE INDEX IF NOT EXISTS idx_energeies_dikigoroi_dik
  ON energeies_dikigoroi(dikigoroi_grafeiou_id);
