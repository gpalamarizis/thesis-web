// src/routes/gdpr.js
// GDPR compliance endpoints:
//   POST /api/gdpr/export      -> creates JSON export of all org data
//   POST /api/gdpr/delete      -> initiates account deletion (30-day grace)
//   GET  /api/gdpr/delete-status -> status of pending deletion
//   POST /api/gdpr/delete/cancel -> cancels pending deletion (within grace period)

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireOwner } = require('../middleware/accessControl');

const router = express.Router();
router.use(requireAuth);

async function ensureGdprSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gdpr_deletion_requests (
      aa              BIGSERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by    BIGINT NOT NULL,
      requested_at    TIMESTAMPTZ DEFAULT NOW(),
      scheduled_at    TIMESTAMPTZ NOT NULL,
      cancelled_at    TIMESTAMPTZ,
      executed_at     TIMESTAMPTZ,
      reason          TEXT,
      status          VARCHAR(20) DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_org ON gdpr_deletion_requests(organization_id, status);
  `);
}

// ==================== DATA EXPORT ====================
router.post('/export', requireOwner, async (req, res) => {
  const orgId = req.user.organization_id;
  try {
    const tables = [
      'organizations', 'users', 'ypotheseis', 'ypotheseis_onomasies',
      'fysika_prosopa', 'nomika_prosopa', 'antidikoi', 'sxetika_prosopa',
      'case_related_persons', 'dikigoroi_grafeiou', 'dikigoroi_antidikon',
      'xeiristes_dikigoroi', 'court_actions', 'court_sub_actions',
      'case_documents', 'finance_ores', 'finance_pagia_exoda_case',
      'finance_amoives_dikigoron', 'finance_exoda_exoterikou_synergati',
      'invoices', 'invoice_lines', 'invoice_series',
      'document_templates', 'phonebook_entries',
    ];

    const export_data = {
      _meta: {
        exported_at: new Date().toISOString(),
        organization_id: orgId,
        exported_by: req.user.email || req.user.sub,
        source: 'Thesis GDPR Export',
        schema_version: '1.0',
      },
    };

    for (const table of tables) {
      try {
        // Some tables don't have organization_id (child tables) - handle those separately
        const hasOrgCol = await pool.query(`
          SELECT 1 FROM information_schema.columns
           WHERE table_name = $1 AND column_name = 'organization_id' LIMIT 1
        `, [table]);
        if (hasOrgCol.rows.length > 0) {
          const r = await pool.query(`SELECT * FROM ${table} WHERE organization_id = $1`, [orgId]);
          // Redact password hashes
          const rows = r.rows.map(row => {
            const c = { ...row };
            if (c.password_hash) c.password_hash = '[REDACTED]';
            return c;
          });
          export_data[table] = rows;
        }
      } catch (e) {
        console.warn(`[gdpr export] skipping ${table}: ${e.message}`);
      }
    }

    // Log the export
    try {
      await pool.query(`
        INSERT INTO platform_activity_log (admin_user_id, admin_email, action, target_type, target_id, details)
        VALUES ($1, $2, 'gdpr_export', 'organization', $3, $4)
      `, [req.user.sub || req.user.id, req.user.email, orgId,
          JSON.stringify({ tables: tables.length })]);
    } catch { /* activity log optional */ }

    res.setHeader('Content-Disposition', `attachment; filename="thesis-data-export-${orgId}-${new Date().toISOString().slice(0,10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(export_data, null, 2));
  } catch (err) {
    console.error('[gdpr export]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== DELETION REQUEST ====================
router.post('/delete', requireOwner, async (req, res) => {
  await ensureGdprSchema();
  const orgId = req.user.organization_id;
  const { reason, confirm_email } = req.body || {};

  // Sanity check: must confirm own email
  if (confirm_email !== req.user.email) {
    return res.status(400).json({ error: 'Παρακαλώ επιβεβαιώστε δίνοντας το email σας' });
  }

  try {
    // Check if already pending
    const existing = await pool.query(`
      SELECT aa, scheduled_at FROM gdpr_deletion_requests
       WHERE organization_id = $1 AND status = 'pending'
       LIMIT 1`, [orgId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Υπάρχει ήδη εκκρεμές αίτημα διαγραφής',
        scheduled_at: existing.rows[0].scheduled_at,
      });
    }

    // Schedule 30 days from now
    const scheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const r = await pool.query(`
      INSERT INTO gdpr_deletion_requests (organization_id, requested_by, scheduled_at, reason)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [orgId, req.user.sub || req.user.id, scheduledAt, reason || null]);

    res.json({
      message: 'Το αίτημα καταχωρήθηκε. Έχετε 30 ημέρες περιθώριο για ακύρωση.',
      scheduled_at: scheduledAt,
      request_id: r.rows[0].aa,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/delete-status', async (req, res) => {
  await ensureGdprSchema();
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(`
      SELECT * FROM gdpr_deletion_requests
       WHERE organization_id = $1 AND status IN ('pending', 'executed')
       ORDER BY requested_at DESC LIMIT 1`, [orgId]);
    res.json({ data: r.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/delete/cancel', requireOwner, async (req, res) => {
  await ensureGdprSchema();
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(`
      UPDATE gdpr_deletion_requests
         SET status = 'cancelled', cancelled_at = NOW()
       WHERE organization_id = $1 AND status = 'pending'
       RETURNING *`, [orgId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Δεν βρέθηκε εκκρεμές αίτημα' });
    res.json({ ok: true, cancelled_at: r.rows[0].cancelled_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
