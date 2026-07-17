// src/routes/users-admin.js
// Team management endpoints για τον owner του γραφείου.
//
// GET  /api/users-admin           - list all users of the org (extended)
// POST /api/users-admin           - create new user (with password) - seat-limited
// PUT  /api/users-admin/:id       - update user (role, can_view_finance, is_active, name)
// POST /api/users-admin/:id/reset-password - reset password
// DELETE /api/users-admin/:id     - soft delete (is_active = false)

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireOwner, checkSeatLimit, ensureAccessSchema } = require('../middleware/accessControl');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

router.get('/', async (req, res) => {
  await ensureAccessSchema();
  const orgId = req.user.organization_id;
  try {
    const [users, org] = await Promise.all([
      pool.query(`
        SELECT id, email, first_name, last_name, role, is_active,
               COALESCE(can_view_finance, FALSE) AS can_view_finance,
               created_at
          FROM users
         WHERE organization_id = $1
         ORDER BY is_active DESC, first_name, last_name`, [orgId]),
      pool.query(`SELECT max_users, plan_type FROM organizations WHERE id = $1`, [orgId]),
    ]);
    const active_count = users.rows.filter(u => u.is_active).length;
    res.json({
      data: users.rows,
      seat_info: {
        active_count,
        max_users: org.rows[0]?.max_users || 1,
        plan_type: org.rows[0]?.plan_type,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const { email, password, first_name, last_name, role, can_view_finance } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password must be ≥ 8 chars' });

  try {
    await checkSeatLimit(orgId);
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(`
      INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, can_view_finance, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
      RETURNING id, email, first_name, last_name, role, can_view_finance, is_active
    `, [orgId, String(email).toLowerCase(), hash, first_name || null, last_name || null,
        role || 'lawyer', can_view_finance === true]);
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    if (err.code === 'SEAT_LIMIT_REACHED') return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  const uid = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['first_name', 'last_name', 'role', 'can_view_finance', 'is_active'];
  const sets = []; const params = []; let i = 1;
  for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k} = $${i}`); params.push(b[k]); i++; }
  if (!sets.length) return res.status(400).json({ error: 'No fields' });
  params.push(uid, orgId);

  try {
    // Seat limit check if reactivating
    if (b.is_active === true) {
      const currR = await pool.query(`SELECT is_active FROM users WHERE id = $1 AND organization_id = $2`, [uid, orgId]);
      if (currR.rows[0] && !currR.rows[0].is_active) {
        await checkSeatLimit(orgId);
      }
    }

    const r = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1}
       RETURNING id, email, first_name, last_name, role, can_view_finance, is_active`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ data: r.rows[0] });
  } catch (err) {
    if (err.code === 'SEAT_LIMIT_REACHED') return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  const orgId = req.user.organization_id;
  const uid = parseInt(req.params.id, 10);
  const { password } = req.body || {};
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'password must be ≥ 8 chars' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 AND organization_id = $3 RETURNING id`,
      [hash, uid, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  const uid = parseInt(req.params.id, 10);
  try {
    await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1 AND organization_id = $2`, [uid, orgId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
