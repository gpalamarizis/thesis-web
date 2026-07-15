// src/routes/organization-settings.js
// Organization-level settings (issuer data for invoicing, defaults, etc.)
//
// Endpoints:
//   GET  /api/organization/settings          → { data: {...} }
//   PUT  /api/organization/settings          → update fields (upsert)
//
// Auto-creates the table on first request.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_settings (
      organization_id     BIGINT PRIMARY KEY,
      -- Issuer data (for invoices)
      afm                 VARCHAR(20),
      doy                 VARCHAR(120),
      eponymia            VARCHAR(255),
      diakritikos_titlos  VARCHAR(255),
      odos                VARCHAR(255),
      arithmos            VARCHAR(20),
      tk                  VARCHAR(20),
      poli                VARCHAR(120),
      xora                VARCHAR(120) DEFAULT 'ΕΛΛΑΔΑ',
      kad                 VARCHAR(20),
      kad_perigrafi       VARCHAR(255),
      gemi                VARCHAR(50),
      tilefono            VARCHAR(50),
      email               VARCHAR(255),
      web_site            VARCHAR(255),
      iban                VARCHAR(50),
      trapeza             VARCHAR(120),
      -- Invoicing defaults
      default_vat_rate    NUMERIC(5,2) DEFAULT 24.00,
      default_withhold    BOOLEAN      DEFAULT TRUE,   -- 20% παρακράτηση φόρου
      default_stamp       BOOLEAN      DEFAULT FALSE,  -- χαρτόσημο
      default_tn          BOOLEAN      DEFAULT FALSE,  -- Ταμείο Νομικών
      logo_url            TEXT,
      -- myDATA (populated later)
      mydata_user_id      VARCHAR(120),
      mydata_subscription_key TEXT,
      mydata_environment  VARCHAR(20) DEFAULT 'dev',   -- dev | prod
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  tableEnsured = true;
}

router.get('/settings', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(
      `SELECT * FROM organization_settings WHERE organization_id = $1`,
      [orgId]
    );
    if (r.rows.length === 0) {
      // Return empty defaults so frontend can render form
      return res.json({ data: {
        organization_id: orgId,
        xora: 'ΕΛΛΑΔΑ',
        default_vat_rate: 24.00,
        default_withhold: true,
        default_stamp: false,
        default_tn: false,
        mydata_environment: 'dev',
      }});
    }
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[org-settings get]', err);
    res.status(500).json({ error: err.message });
  }
});

const ALLOWED_FIELDS = [
  'afm','doy','eponymia','diakritikos_titlos','odos','arithmos','tk','poli','xora',
  'kad','kad_perigrafi','gemi','tilefono','email','web_site','iban','trapeza',
  'default_vat_rate','default_withhold','default_stamp','default_tn','logo_url',
  'mydata_user_id','mydata_subscription_key','mydata_environment',
];

router.put('/settings', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const b = req.body || {};

  // Only admins can update settings
  if (req.user.role && !['admin','owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Μόνο διαχειριστές μπορούν να επεξεργαστούν τα στοιχεία γραφείου.' });
  }

  const fields = [];
  const values = [];
  for (const f of ALLOWED_FIELDS) {
    if (b[f] !== undefined) {
      fields.push(f);
      values.push(b[f] === '' ? null : b[f]);
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  const insertCols = ['organization_id', ...fields].join(', ');
  const insertVals = [orgId, ...values];
  const insertPh   = insertVals.map((_, i) => `$${i + 1}`).join(', ');
  const updatePart = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');

  try {
    const r = await pool.query(
      `INSERT INTO organization_settings (${insertCols})
       VALUES (${insertPh})
       ON CONFLICT (organization_id) DO UPDATE SET ${updatePart}, updated_at = NOW()
       RETURNING *`,
      insertVals
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[org-settings put]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
