// src/routes/case-access.js
// CRUD για case_user_access allowlist. Μόνο owner μπορεί να το διαχειρίζεται.
//
// GET  /api/cases/:caseId/access       - list users who have explicit access
// POST /api/cases/:caseId/access       - grant access to a user
// DELETE /api/cases/:caseId/access/:userId - revoke

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireOwner, ensureAccessSchema } = require('../middleware/accessControl');

const router = express.Router();
router.use(requireAuth);

router.get('/:caseId/access', async (req, res) => {
  await ensureAccessSchema();
  const caseId = parseInt(req.params.caseId, 10);
  const orgId = req.user.organization_id;
  try {
    // Verify case belongs to org
    const y = await pool.query(`SELECT aa FROM ypotheseis WHERE aa = $1 AND organization_id = $2`, [caseId, orgId]);
    if (!y.rows.length) return res.status(404).json({ error: 'Case not found' });

    // List explicit allowlist entries + list org users for the picker
    const [allowlist, users] = await Promise.all([
      pool.query(`
        SELECT cua.*, u.email, u.first_name, u.last_name, u.role,
               gb.email AS granted_by_email
          FROM case_user_access cua
          JOIN users u ON u.id = cua.user_id
          LEFT JOIN users gb ON gb.id = cua.granted_by
         WHERE cua.ypothesi_id = $1
         ORDER BY cua.created_at DESC`, [caseId]),
      pool.query(`SELECT id, email, first_name, last_name, role FROM users WHERE organization_id = $1 AND is_active = TRUE ORDER BY first_name, last_name`, [orgId]),
    ]);

    res.json({ allowlist: allowlist.rows, org_users: users.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:caseId/access', requireOwner, async (req, res) => {
  await ensureAccessSchema();
  const caseId = parseInt(req.params.caseId, 10);
  const { user_id, can_edit } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const orgId = req.user.organization_id;

  try {
    // Verify both case and user belong to org
    const [y, u] = await Promise.all([
      pool.query(`SELECT aa FROM ypotheseis WHERE aa = $1 AND organization_id = $2`, [caseId, orgId]),
      pool.query(`SELECT id FROM users WHERE id = $1 AND organization_id = $2`, [user_id, orgId]),
    ]);
    if (!y.rows.length) return res.status(404).json({ error: 'Case not found' });
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });

    await pool.query(`
      INSERT INTO case_user_access (ypothesi_id, user_id, can_view, can_edit, granted_by)
      VALUES ($1, $2, TRUE, $3, $4)
      ON CONFLICT (ypothesi_id, user_id) DO UPDATE SET can_edit = EXCLUDED.can_edit
    `, [caseId, user_id, can_edit !== false, req.user.sub || req.user.id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:caseId/access/:userId', requireOwner, async (req, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const userId = parseInt(req.params.userId, 10);
  const orgId = req.user.organization_id;
  try {
    const y = await pool.query(`SELECT aa FROM ypotheseis WHERE aa = $1 AND organization_id = $2`, [caseId, orgId]);
    if (!y.rows.length) return res.status(404).json({ error: 'Case not found' });

    await pool.query(`DELETE FROM case_user_access WHERE ypothesi_id = $1 AND user_id = $2`, [caseId, userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
