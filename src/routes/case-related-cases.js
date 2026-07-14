// Related cases pivot: υπόθεση ↔ υπόθεση (many-to-many, symmetric)
//
// Auto-creates table on first request.
//
// Endpoints:
//   GET    /api/case-related-cases?ypothesi_id=X  →  list related to case X
//   POST   /api/case-related-cases                →  { ypothesi_id, related_ypothesi_id, notes }
//   DELETE /api/case-related-cases/:id            →  remove relation

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_related_cases (
      aa                  BIGSERIAL PRIMARY KEY,
      ypothesi_id         BIGINT NOT NULL,
      related_ypothesi_id BIGINT NOT NULL,
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      CHECK (ypothesi_id <> related_ypothesi_id),
      UNIQUE (ypothesi_id, related_ypothesi_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crc_ypothesi ON case_related_cases (ypothesi_id);
    CREATE INDEX IF NOT EXISTS idx_crc_related  ON case_related_cases (related_ypothesi_id);
  `);
  tableEnsured = true;
}

// GET /api/case-related-cases?ypothesi_id=X
// Returns rows where either side of the pair matches the case (symmetric view)
router.get('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const ypId = req.query.ypothesi_id;
  if (!ypId) return res.status(400).json({ error: 'ypothesi_id required' });
  try {
    const r = await pool.query(
      `SELECT crc.aa,
              crc.ypothesi_id,
              crc.related_ypothesi_id,
              crc.notes,
              crc.created_at,
              CASE
                WHEN crc.ypothesi_id = $2 THEN crc.related_ypothesi_id
                ELSE crc.ypothesi_id
              END AS other_case_id,
              CASE
                WHEN crc.ypothesi_id = $2 THEN yr.xeirokinito_id
                ELSE ym.xeirokinito_id
              END AS other_xeirokinito_id,
              CASE
                WHEN crc.ypothesi_id = $2 THEN yr.perilipsi
                ELSE ym.perilipsi
              END AS other_perilipsi,
              CASE
                WHEN crc.ypothesi_id = $2 THEN yr.date_eisagogis
                ELSE ym.date_eisagogis
              END AS other_date_eisagogis,
              CASE
                WHEN crc.ypothesi_id = $2 THEN yr.ekkremis
                ELSE ym.ekkremis
              END AS other_ekkremis
         FROM case_related_cases crc
         JOIN ypotheseis ym ON ym.aa = crc.ypothesi_id
         JOIN ypotheseis yr ON yr.aa = crc.related_ypothesi_id
        WHERE ym.organization_id = $1
          AND yr.organization_id = $1
          AND (crc.ypothesi_id = $2 OR crc.related_ypothesi_id = $2)
        ORDER BY crc.created_at DESC`,
      [orgId, parseInt(ypId, 10)]
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[case-related-cases list]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/case-related-cases
router.post('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const { ypothesi_id, related_ypothesi_id, notes } = req.body || {};
  if (!ypothesi_id || !related_ypothesi_id) {
    return res.status(400).json({ error: 'ypothesi_id and related_ypothesi_id required' });
  }
  const a = parseInt(ypothesi_id, 10);
  const b = parseInt(related_ypothesi_id, 10);
  if (a === b) return res.status(400).json({ error: 'Δεν μπορείτε να συνδέσετε υπόθεση με τον εαυτό της' });

  try {
    // Verify both cases belong to org
    const check = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ypotheseis WHERE aa IN ($1, $2) AND organization_id = $3`,
      [a, b, orgId]
    );
    if (check.rows[0].c !== 2) return res.status(404).json({ error: 'Cases not found' });

    // Normalize order (smaller id first) to avoid duplicates
    const [x, y] = a < b ? [a, b] : [b, a];
    const r = await pool.query(
      `INSERT INTO case_related_cases (ypothesi_id, related_ypothesi_id, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (ypothesi_id, related_ypothesi_id) DO UPDATE SET notes = EXCLUDED.notes
       RETURNING *`,
      [x, y, notes || null]
    );
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    console.error('[case-related-cases create]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/case-related-cases/:id
router.delete('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const own = await pool.query(
      `SELECT crc.aa FROM case_related_cases crc
         JOIN ypotheseis ym ON ym.aa = crc.ypothesi_id
        WHERE crc.aa = $1 AND ym.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM case_related_cases WHERE aa = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error('[case-related-cases delete]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
