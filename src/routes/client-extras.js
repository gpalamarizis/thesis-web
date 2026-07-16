// src/routes/client-extras.js
// Additive schema μόνο — δεν κάνει κανένα endpoint mount.
// Καλείται ρητά κατά τη startup ώστε να προστεθούν columns σε ypotheseis / fysika_prosopa /
// nomika_prosopa χωρίς full migration script.
//
// Το ίδιο module εξάγει και τη λίστα των νέων fields για να τα χρησιμοποιήσουν τα routes
// cases / fysika / nomika στη sanitization τους.

const { pool } = require('../db');

let ensured = false;
async function ensureColumns() {
  if (ensured) return;
  await pool.query(`
    -- Δικαστικές υποθέσεις — γενικός/ειδικός αριθμός κατάθεσης + κωδικός εισαγωγικού
    ALTER TABLE ypotheseis ADD COLUMN IF NOT EXISTS gak                    VARCHAR(80);
    ALTER TABLE ypotheseis ADD COLUMN IF NOT EXISTS eak                    VARCHAR(80);
    ALTER TABLE ypotheseis ADD COLUMN IF NOT EXISTS arithmos_eisagogikou   VARCHAR(120);
    CREATE INDEX IF NOT EXISTS idx_ypotheseis_gak ON ypotheseis(organization_id, gak);
    CREATE INDEX IF NOT EXISTS idx_ypotheseis_eak ON ypotheseis(organization_id, eak);

    -- Φυσικά πρόσωπα
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS date_thanaton                DATE;
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS forologikos_katoikos         VARCHAR(20) DEFAULT 'EL';  -- 'EL' | 'FOR'
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS taxis_username               VARCHAR(120);
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS taxis_password               TEXT;                       -- encrypted
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS ypoxreous_forologikis_dilosis BOOLEAN DEFAULT FALSE;
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS idioktitis_akinitou          BOOLEAN DEFAULT FALSE;
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS kaek                         TEXT;                       -- κωδικοί ΚΑΕΚ (comma-separated)
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS dei_username                 VARCHAR(120);
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS dei_password                 TEXT;                       -- encrypted
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS ama_akinitou                 TEXT;                       -- Α.Μ.Α. ακινήτου/ων
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS idioktitis_ix                BOOLEAN DEFAULT FALSE;
    ALTER TABLE fysika_prosopa ADD COLUMN IF NOT EXISTS pinakides_ix                 TEXT;                       -- πινακίδες (comma-separated)

    -- Νομικά πρόσωπα
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS taxis_username         VARCHAR(120);
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS taxis_password         TEXT;                             -- encrypted
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS gemi_username          VARCHAR(120);
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS gemi_password          TEXT;                             -- encrypted
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS idioktitis_akinitou    BOOLEAN DEFAULT FALSE;
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS kaek                   TEXT;
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS dei_username           VARCHAR(120);
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS dei_password           TEXT;                             -- encrypted
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS ama_akinitou           TEXT;
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS idioktitis_ix          BOOLEAN DEFAULT FALSE;
    ALTER TABLE nomika_prosopa ADD COLUMN IF NOT EXISTS pinakides_ix           TEXT;
  `);
  ensured = true;
}

// Field lists για use στα routes (μη ευαίσθητα)
const CASES_EXTRA_FIELDS = ['gak', 'eak', 'arithmos_eisagogikou'];

const FYSIKA_EXTRA_FIELDS = [
  'date_thanaton', 'forologikos_katoikos',
  'taxis_username', 'taxis_password',
  'ypoxreous_forologikis_dilosis',
  'idioktitis_akinitou', 'kaek', 'dei_username', 'dei_password', 'ama_akinitou',
  'idioktitis_ix', 'pinakides_ix',
];

const NOMIKA_EXTRA_FIELDS = [
  'taxis_username', 'taxis_password',
  'gemi_username', 'gemi_password',
  'idioktitis_akinitou', 'kaek', 'dei_username', 'dei_password', 'ama_akinitou',
  'idioktitis_ix', 'pinakides_ix',
];

module.exports = {
  ensureColumns,
  CASES_EXTRA_FIELDS,
  FYSIKA_EXTRA_FIELDS,
  NOMIKA_EXTRA_FIELDS,
};
