// src/routes/invoice-series.js
// Invoice numbering series (π.χ. "Α", "Β", "ΑΠΥ")
//
// Endpoints:
//   GET    /api/invoice-series
//   POST   /api/invoice-series
//   PUT    /api/invoice-series/:id
//   DELETE /api/invoice-series/:id

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_series (
      aa                BIGSERIAL PRIMARY KEY,
      organization_id   BIGINT NOT NULL,
      name              VARCHAR(50) NOT NULL,
      description       TEXT,
      type              VARCHAR(30) NOT NULL DEFAULT 'invoice',  -- invoice | receipt | credit_note | debit_note
      next_number       BIGINT NOT NULL DEFAULT 1,
      active            BOOLEAN DEFAULT TRUE,
      is_default        BOOLEAN DEFAULT FALSE,
      -- myDATA-specific (used when submitting to AADE)
      mydata_series     VARCHAR(50),
      mydata_invoice_type VARCHAR(20),   -- π.χ. "2.1" (ΑΠΥ), "1.1" (Τιμολόγιο), etc.
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (organization_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_series_org ON invoice_series (organization_id);
  `);
  tableEnsured = true;
}

router.get('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(
      `SELECT * FROM invoice_series WHERE organization_id = $1 ORDER BY name`,
      [orgId]
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[invoice-series list]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  try {
    // If setting is_default, unset others
    if (b.is_default) {
      await pool.query(
        `UPDATE invoice_series SET is_default = FALSE WHERE organization_id = $1`,
        [orgId]
      );
    }
    const r = await pool.query(
      `INSERT INTO invoice_series
         (organization_id, name, description, type, next_number, active, is_default, mydata_series, mydata_invoice_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        orgId,
        b.name,
        b.description || null,
        b.type || 'invoice',
        b.next_number ? parseInt(b.next_number, 10) : 1,
        b.active !== false,
        !!b.is_default,
        b.mydata_series || null,
        b.mydata_invoice_type || null,
      ]
    );
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    console.error('[invoice-series create]', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const b = req.body || {};
  const own = await pool.query(
    `SELECT aa FROM invoice_series WHERE aa = $1 AND organization_id = $2`,
    [req.params.id, orgId]
  );
  if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });

  const fields = [];
  const values = [];
  let i = 1;
  const allowed = ['name','description','type','next_number','active','is_default','mydata_series','mydata_invoice_type'];
  for (const f of allowed) {
    if (b[f] !== undefined) {
      fields.push(`${f} = $${i++}`);
      values.push(b[f] === '' ? null : b[f]);
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No changes' });

  try {
    if (b.is_default) {
      await pool.query(
        `UPDATE invoice_series SET is_default = FALSE WHERE organization_id = $1 AND aa <> $2`,
        [orgId, req.params.id]
      );
    }
    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE invoice_series SET ${fields.join(', ')} WHERE aa = $${i} RETURNING *`,
      values
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[invoice-series update]', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    // Check if series has any invoices
    const inUse = await pool.query(
      `SELECT COUNT(*)::int AS c FROM invoices WHERE series_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [{ c: 0 }] }));
    if (inUse.rows[0].c > 0) {
      return res.status(400).json({ error: 'Η σειρά έχει τιμολόγια — δεν διαγράφεται. Απενεργοποίησέ την.' });
    }
    const r = await pool.query(
      `DELETE FROM invoice_series WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    console.error('[invoice-series delete]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
