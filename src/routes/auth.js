const express = require('express');
const bcrypt  = require('bcryptjs');
const { pool } = require('../db');
const emailSvc = require('../services/email');
const { signToken, requireAuth } = require('../middleware/auth');
const { seedNewOrganization } = require('../seed/seedOrg');

const router = express.Router();

// POST /api/auth/register
// Δημιουργεί οργάνωση (γραφείο) + admin user + κάνει auto-seed λιστών & δικαστηρίων.
router.post('/register', async (req, res) => {
  const { organizationName, email, password, firstName, lastName,
          plan_type, visibility_mode, billing_afm, billing_email, billing_phone } = req.body || {};

  if (!organizationName || !email || !password) {
    return res.status(400).json({ error: 'organizationName, email, password required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'password must be ≥ 8 chars' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slug = String(organizationName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    // Default seats per plan type
    const maxUsersByPlan = { solo: 1, partnership_shared: 5, partnership_private: 5, law_firm: 25 };
    const maxUsers = maxUsersByPlan[plan_type] || 1;
    const storageByPlan = { solo: 5120, partnership_shared: 20480, partnership_private: 20480, law_firm: 51200 };
    const storageMb = storageByPlan[plan_type] || 5120;

    const org = await client.query(
      `INSERT INTO organizations (name, slug, plan_type, visibility_mode, max_users, storage_quota_mb,
                                  subscription_status, trial_ends_at,
                                  billing_afm, billing_email, billing_phone)
       VALUES ($1, $2, $3, $4, $5, $6, 'trial', NOW() + INTERVAL '30 days', $7, $8, $9)
       RETURNING *`,
      [organizationName, slug || null,
       plan_type || 'solo',
       visibility_mode || 'shared',
       maxUsers, storageMb,
       billing_afm || null, billing_email || email, billing_phone || null]
    );
    const orgId = org.rows[0].id;

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await client.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')
       RETURNING id, organization_id, email, first_name, last_name, role`,
      [orgId, String(email).toLowerCase(), passwordHash, firstName || null, lastName || null]
    );

    // Auto-seed δικαστηρίων + λιστών για αυτή τη νέα οργάνωση
    await seedNewOrganization(client, orgId);

    await client.query('COMMIT');

    // Fire welcome email (non-blocking)
    emailSvc.sendWelcome({
      to: email,
      firstName: firstName,
      organizationName: organizationName,
    }).then(r => {
      console.log('[auth] welcome email:', r);
    }).catch(err => {
      console.error('[auth] welcome email failed:', err.message);
    });

    const token = signToken(user.rows[0]);
    res.status(201).json({ token, user: user.rows[0], organization: org.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[auth/register]', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Registration failed', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });

  try {
    const r = await pool.query(
      `SELECT u.*, o.name AS organization_name
         FROM users u
         JOIN organizations o ON o.id = u.organization_id
        WHERE u.email = $1 AND u.is_active = TRUE
        LIMIT 1`,
      [String(email).toLowerCase()]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        organization_id: user.organization_id,
        organization_name: user.organization_name,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        is_platform_admin: user.is_platform_admin || false,
      },
    });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role,
              u.organization_id, o.name AS organization_name,
              COALESCE(u.is_platform_admin, FALSE) AS is_platform_admin,
              COALESCE(u.can_view_finance, FALSE) AS can_view_finance,
              o.visibility_mode, o.plan_type, o.subscription_status, o.trial_ends_at, o.subscription_ends_at,
              o.suspended
         FROM users u
         JOIN organizations o ON o.id = u.organization_id
        WHERE u.id = $1`,
      [req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
