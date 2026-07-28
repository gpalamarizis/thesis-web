const express = require('express');
const crypto  = require('crypto');
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
         LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE LOWER(u.email) = $1 AND u.is_active = TRUE
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
         LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.id = $1`,
      [req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PASSWORD RESET
// Χρησιμοποιεί τις υπάρχουσες στήλες users.password_reset_token και
// users.password_reset_expires_at. Καμία migration δεν χρειάζεται.
// ---------------------------------------------------------------------------

// Πάντα ίδια απάντηση, ώστε να μην αποκαλύπτεται ποια emails είναι εγγεγραμμένα
const RESET_GENERIC = { message: 'Αν το email αντιστοιχεί σε λογαριασμό, στάλθηκε σύνδεσμος επαναφοράς.' };

// POST /api/auth/forgot-password  { email }
router.post('/forgot-password', async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const r = await pool.query(
      `SELECT id, email, first_name, is_active FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );

    // Ίδια απάντηση είτε υπάρχει είτε όχι
    if (r.rows.length === 0 || r.rows[0].is_active === false) {
      return res.json(RESET_GENERIC);
    }
    const user = r.rows[0];

    // Token: 32 τυχαία bytes. Αποθηκεύουμε το SHA-256 hash, όχι το ίδιο το token.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 60 λεπτά

    await pool.query(
      `UPDATE users SET password_reset_token = $1, password_reset_expires_at = $2, updated_at = now()
       WHERE id = $3`,
      [tokenHash, expires, user.id]
    );

    const frontend = (process.env.FRONTEND_URL || 'https://app.thesislegal.gr').replace(/\/$/, '');
    const resetUrl = `${frontend}/reset-password?token=${rawToken}`;

    try {
      await emailSvc.sendPasswordReset({ to: user.email, firstName: user.first_name, resetUrl });
    } catch (mailErr) {
      console.error('[forgot-password] email failed:', mailErr.message);
      // Δεν αποκαλύπτουμε το σφάλμα στον χρήστη
    }

    return res.json(RESET_GENERIC);
  } catch (err) {
    console.error('[forgot-password]', err.message);
    return res.status(500).json({ error: 'server error' });
  }
});

// GET /api/auth/reset-password/:token  -> { valid: bool }
router.get('/reset-password/:token', async (req, res) => {
  const raw = req.params.token || '';
  if (!raw) return res.json({ valid: false });
  try {
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const r = await pool.query(
      `SELECT id FROM users
        WHERE password_reset_token = $1 AND password_reset_expires_at > now()
        LIMIT 1`,
      [tokenHash]
    );
    return res.json({ valid: r.rows.length > 0 });
  } catch (err) {
    console.error('[reset-password check]', err.message);
    return res.json({ valid: false });
  }
});

// POST /api/auth/reset-password  { token, new_password }
router.post('/reset-password', async (req, res) => {
  const raw = (req.body && req.body.token || '').trim();
  const newPassword = (req.body && req.body.new_password) || '';
  if (!raw || !newPassword) return res.status(400).json({ error: 'token + new_password required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες' });

  try {
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const r = await pool.query(
      `SELECT id FROM users
        WHERE password_reset_token = $1 AND password_reset_expires_at > now()
        LIMIT 1`,
      [tokenHash]
    );
    if (r.rows.length === 0) {
      return res.status(400).json({ error: 'Ο σύνδεσμος έχει λήξει ή είναι μη έγκυρος.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              password_reset_token = NULL,
              password_reset_expires_at = NULL,
              updated_at = now()
        WHERE id = $2`,
      [passwordHash, r.rows[0].id]
    );

    return res.json({ message: 'Ο κωδικός ενημερώθηκε. Μπορείτε να συνδεθείτε.' });
  } catch (err) {
    console.error('[reset-password]', err.message);
    return res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
