// src/routes/court-sub-actions.js
// Sub-actions ("ενέργειες") for each court action (dikastiria_energeies).
//
// Also runs schema migrations on first request:
//   - Adds gemi column to nomika_prosopa
//   - Creates dikastiria_sub_energeies table
//   - Auto-updates ekkremis=false for actions whose date has passed
//
// Endpoints:
//   GET    /api/court-sub-actions?court_action_id=X
//   POST   /api/court-sub-actions
//   PUT    /api/court-sub-actions/:id
//   DELETE /api/court-sub-actions/:id

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let migrationsEnsured = false;
async function ensureSchema() {
  if (migrationsEnsured) return;
  try {
    // 1) Add gemi column to nomika_prosopa
    await pool.query(`
      ALTER TABLE nomika_prosopa
        ADD COLUMN IF NOT EXISTS gemi VARCHAR(50);
    `);

    // 2) Create dikastiria_sub_energeies table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dikastiria_sub_energeies (
        aa                     BIGSERIAL PRIMARY KEY,
        dikastiria_energeia_id BIGINT NOT NULL REFERENCES dikastiria_energeies(aa) ON DELETE CASCADE,
        perigrafi              TEXT,
        energeia_lookup_id     BIGINT,
        date                   DATE,
        dikigoros_id           BIGINT,
        date_apofasis          DATE,
        ekkremis               BOOLEAN DEFAULT TRUE,
        line_order             INT DEFAULT 0,
        created_at             TIMESTAMPTZ DEFAULT NOW(),
        updated_at             TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_dse_court_action ON dikastiria_sub_energeies (dikastiria_energeia_id);
      CREATE INDEX IF NOT EXISTS idx_dse_date         ON dikastiria_sub_energeies (date);
    `);

    migrationsEnsured = true;
    console.log('[court-sub-actions] Schema migrations completed');
  } catch (err) {
    console.error('[court-sub-actions ensureSchema]', err);
  }
}

// Auto-update: mark as non-ekkremis all sub-actions whose date has passed
async function autoUpdateEkkremis() {
  try {
    await pool.query(`
      UPDATE dikastiria_sub_energeies
         SET ekkremis = FALSE, updated_at = NOW()
       WHERE ekkremis = TRUE
         AND date IS NOT NULL
         AND date < CURRENT_DATE
    `);
  } catch (err) {
    console.error('[court-sub-actions auto-update]', err);
  }
}

// Verify court action belongs to user's organization
async function verifyCourtActionOwnership(courtActionId, orgId) {
  const r = await pool.query(
    `SELECT de.aa FROM dikastiria_energeies de
        JOIN ypotheseis y ON y.aa = de.ypothesi_id
       WHERE de.aa = $1 AND y.organization_id = $2`,
    [courtActionId, orgId]
  );
  return r.rows.length > 0;
}

router.get('/', async (req, res) => {
  await ensureSchema();
  await autoUpdateEkkremis();
  const orgId = req.user.organization_id;
  const courtActionId = req.query.court_action_id;
  if (!courtActionId) return res.status(400).json({ error: 'court_action_id required' });

  try {
    // Verify ownership via join
    const own = await verifyCourtActionOwnership(courtActionId, orgId);
    if (!own) return res.status(404).json({ error: 'Court action not found' });

    const r = await pool.query(
      `SELECT dse.*,
              el.name AS energeia_name,
              CONCAT_WS(' ', dg.eponymo, dg.onoma) AS dikigoros_name
         FROM dikastiria_sub_energeies dse
         LEFT JOIN dikastiria_exelixi_energeias el ON el.aa = dse.energeia_lookup_id
         LEFT JOIN dikigoroi_grafeiou dg ON dg.aa = dse.dikigoros_id
        WHERE dse.dikastiria_energeia_id = $1
        ORDER BY dse.line_order, dse.date NULLS LAST, dse.aa`,
      [courtActionId]
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[court-sub-actions list]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  await ensureSchema();
  const orgId = req.user.organization_id;
  const b = req.body || {};
  const courtActionId = b.court_action_id || b.dikastiria_energeia_id;
  if (!courtActionId) return res.status(400).json({ error: 'court_action_id required' });

  try {
    const own = await verifyCourtActionOwnership(courtActionId, orgId);
    if (!own) return res.status(404).json({ error: 'Court action not found' });

    const r = await pool.query(
      `INSERT INTO dikastiria_sub_energeies
         (dikastiria_energeia_id, perigrafi, energeia_lookup_id, date, dikigoros_id, date_apofasis, ekkremis, line_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        parseInt(courtActionId, 10),
        b.perigrafi || null,
        b.energeia_lookup_id ? parseInt(b.energeia_lookup_id, 10) : null,
        b.date || null,
        b.dikigoros_id ? parseInt(b.dikigoros_id, 10) : null,
        b.date_apofasis || null,
        b.ekkremis !== false,
        b.line_order != null ? parseInt(b.line_order, 10) : 0,
      ]
    );
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    console.error('[court-sub-actions create]', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  await ensureSchema();
  const orgId = req.user.organization_id;
  const b = req.body || {};

  try {
    // Verify ownership via double join
    const own = await pool.query(
      `SELECT dse.aa FROM dikastiria_sub_energeies dse
         JOIN dikastiria_energeies de ON de.aa = dse.dikastiria_energeia_id
         JOIN ypotheseis y ON y.aa = de.ypothesi_id
        WHERE dse.aa = $1 AND y.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const fields = [];
    const values = [];
    let i = 1;
    if (b.perigrafi          !== undefined) { fields.push(`perigrafi = $${i++}`);          values.push(b.perigrafi); }
    if (b.energeia_lookup_id !== undefined) { fields.push(`energeia_lookup_id = $${i++}`); values.push(b.energeia_lookup_id ? parseInt(b.energeia_lookup_id, 10) : null); }
    if (b.date               !== undefined) { fields.push(`date = $${i++}`);               values.push(b.date || null); }
    if (b.dikigoros_id       !== undefined) { fields.push(`dikigoros_id = $${i++}`);       values.push(b.dikigoros_id ? parseInt(b.dikigoros_id, 10) : null); }
    if (b.date_apofasis      !== undefined) { fields.push(`date_apofasis = $${i++}`);      values.push(b.date_apofasis || null); }
    if (b.ekkremis           !== undefined) { fields.push(`ekkremis = $${i++}`);           values.push(!!b.ekkremis); }
    if (b.line_order         !== undefined) { fields.push(`line_order = $${i++}`);         values.push(parseInt(b.line_order, 10) || 0); }
    if (fields.length === 0) return res.status(400).json({ error: 'No changes' });

    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE dikastiria_sub_energeies SET ${fields.join(', ')} WHERE aa = $${i} RETURNING *`,
      values
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[court-sub-actions update]', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  await ensureSchema();
  const orgId = req.user.organization_id;
  try {
    const own = await pool.query(
      `SELECT dse.aa FROM dikastiria_sub_energeies dse
         JOIN dikastiria_energeies de ON de.aa = dse.dikastiria_energeia_id
         JOIN ypotheseis y ON y.aa = de.ypothesi_id
        WHERE dse.aa = $1 AND y.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await pool.query(`DELETE FROM dikastiria_sub_energeies WHERE aa = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error('[court-sub-actions delete]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
