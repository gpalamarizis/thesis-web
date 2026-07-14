// Case ↔ Σχετικά πρόσωπα (many-to-many με eidos_sxesis)
//
// Auto-creates table on first request (idempotent).
//
// Endpoints:
//   GET    /api/case-related-persons?ypothesi_id=X
//   POST   /api/case-related-persons     { ypothesi_id, sxetiko_prosopo_id, eidos_sxesis_id }
//   PUT    /api/case-related-persons/:id { eidos_sxesis_id }
//   DELETE /api/case-related-persons/:id

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_related_persons (
      aa                  BIGSERIAL PRIMARY KEY,
      ypothesi_id         BIGINT NOT NULL,
      sxetiko_prosopo_id  BIGINT NOT NULL,
      eidos_sxesis_id     BIGINT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (ypothesi_id, sxetiko_prosopo_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crp_ypothesi ON case_related_persons (ypothesi_id);
  `);
  tableEnsured = true;
}

// GET /api/case-related-persons?ypothesi_id=X
router.get('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const ypId = req.query.ypothesi_id;
  if (!ypId) return res.status(400).json({ error: 'ypothesi_id required' });
  try {
    const r = await pool.query(
      `SELECT crp.aa, crp.ypothesi_id, crp.sxetiko_prosopo_id, crp.eidos_sxesis_id, crp.created_at,
              sp.eponymo   AS sxetikos_eponymo,
              sp.onoma     AS sxetikos_onoma,
              sp.eponymia  AS sxetikos_eponymia,
              es.name      AS eidos_sxesis_name
         FROM case_related_persons crp
         JOIN ypotheseis y  ON y.aa = crp.ypothesi_id
         LEFT JOIN sxetika_prosopa sp ON sp.aa = crp.sxetiko_prosopo_id
         LEFT JOIN eidos_sxesis    es ON es.aa = crp.eidos_sxesis_id
        WHERE y.organization_id = $1 AND crp.ypothesi_id = $2
        ORDER BY crp.created_at ASC`,
      [orgId, parseInt(ypId, 10)]
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[case-related-persons list]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/case-related-persons
router.post('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const { ypothesi_id, sxetiko_prosopo_id, eidos_sxesis_id } = req.body || {};
  if (!ypothesi_id || !sxetiko_prosopo_id) {
    return res.status(400).json({ error: 'ypothesi_id and sxetiko_prosopo_id required' });
  }
  try {
    // Verify case belongs to org
    const check = await pool.query(
      'SELECT aa FROM ypotheseis WHERE aa = $1 AND organization_id = $2',
      [parseInt(ypothesi_id, 10), orgId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

    const r = await pool.query(
      `INSERT INTO case_related_persons (ypothesi_id, sxetiko_prosopo_id, eidos_sxesis_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (ypothesi_id, sxetiko_prosopo_id) DO UPDATE SET eidos_sxesis_id = EXCLUDED.eidos_sxesis_id
       RETURNING *`,
      [
        parseInt(ypothesi_id, 10),
        parseInt(sxetiko_prosopo_id, 10),
        eidos_sxesis_id ? parseInt(eidos_sxesis_id, 10) : null,
      ]
    );
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    console.error('[case-related-persons create]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/case-related-persons/:id
router.put('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const own = await pool.query(
      `SELECT crp.aa FROM case_related_persons crp
         JOIN ypotheseis y ON y.aa = crp.ypothesi_id
        WHERE crp.aa = $1 AND y.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const eid = req.body?.eidos_sxesis_id;
    const r = await pool.query(
      `UPDATE case_related_persons SET eidos_sxesis_id = $1 WHERE aa = $2 RETURNING *`,
      [eid ? parseInt(eid, 10) : null, req.params.id]
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[case-related-persons update]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/case-related-persons/:id
router.delete('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const own = await pool.query(
      `SELECT crp.aa FROM case_related_persons crp
         JOIN ypotheseis y ON y.aa = crp.ypothesi_id
        WHERE crp.aa = $1 AND y.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM case_related_persons WHERE aa = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error('[case-related-persons delete]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
