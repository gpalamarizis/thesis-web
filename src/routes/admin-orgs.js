// src/routes/admin-orgs.js
// Platform admin CRUD routes for organizations and users.
// Mount: app.use('/api/admin', adminOrgsRouter);

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateJWT } = require('../middleware/auth');
const { requirePlatformAdmin } = require('../middleware/platform-admin');
const { pool } = require('../db');

const router = express.Router();

// All routes require JWT + platform admin
router.use(authenticateJWT, requirePlatformAdmin);

// ---- ORGANIZATIONS ----

// GET /api/admin/organizations - list all
router.get('/organizations', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        o.id, o.slug, o.name, o.plan_type, o.subscription_status,
        o.trial_ends_at, o.subscription_ends_at, o.max_users, o.storage_quota_mb,
        o.billing_email, o.billing_afm, o.billing_phone, o.notes,
        o.suspended, o.suspended_reason, o.created_at,
        (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND is_active = true) AS active_users,
        (SELECT COUNT(*) FROM users WHERE organization_id = o.id) AS total_users,
        CASE
          WHEN o.subscription_ends_at IS NULL THEN NULL
          ELSE (o.subscription_ends_at::date - CURRENT_DATE)
        END AS days_until_expiry
      FROM organizations o
      ORDER BY o.id
    `);
    res.json(rows);
  } catch (err) {
    console.error('[admin/orgs list]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/organizations - create new org with admin user + 1yr subscription
router.post('/organizations', async (req, res) => {
  const {
    name, slug, plan_type = 'enterprise',
    admin_email, admin_password, admin_first_name = 'Admin', admin_last_name = '',
    subscription_start,   // ISO date, defaults to now
    subscription_years = 1,
    billing_email, billing_afm, billing_phone, notes,
    max_users = 20, storage_quota_mb = 50000
  } = req.body;

  if (!name || !slug || !admin_email || !admin_password) {
    return res.status(400).json({ error: 'Required: name, slug, admin_email, admin_password' });
  }
  if (admin_password.length < 8) {
    return res.status(400).json({ error: 'Password min 8 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const startDate = subscription_start ? new Date(subscription_start) : new Date();
    const endDate = new Date(startDate);
    endDate.setFullYear(endDate.getFullYear() + Number(subscription_years));

    const orgResult = await client.query(`
      INSERT INTO organizations (
        name, slug, plan_type, subscription_status,
        trial_ends_at, subscription_ends_at,
        max_users, storage_quota_mb,
        billing_email, billing_afm, billing_phone, notes
      ) VALUES ($1, $2, $3, 'active', NULL, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      name, slug, plan_type, endDate.toISOString(),
      max_users, storage_quota_mb,
      billing_email || null, billing_afm || null, billing_phone || null, notes || null
    ]);
    const org = orgResult.rows[0];

    const hash = await bcrypt.hash(admin_password, 10);
    const userResult = await client.query(`
      INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, is_active)
      VALUES ($1, $2, $3, $4, $5, 'admin', true)
      RETURNING id, email, first_name, last_name
    `, [org.id, admin_email, hash, admin_first_name, admin_last_name]);

    await client.query('COMMIT');
    res.status(201).json({ organization: org, admin_user: userResult.rows[0] });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/orgs create]', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Slug or email already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/admin/organizations/:id - detail with users
router.get('/organizations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: [org] } = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [id]);
    if (!org) return res.status(404).json({ error: 'Not found' });

    const { rows: users } = await pool.query(`
      SELECT id, email, first_name, last_name, role, is_active,
             is_platform_admin, can_view_finance, created_at
      FROM users WHERE organization_id = $1 ORDER BY is_platform_admin DESC, id
    `, [id]);

    res.json({ organization: org, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/organizations/:id - update fields
router.patch('/organizations/:id', async (req, res) => {
  const { id } = req.params;
  const allowedFields = [
    'name', 'slug', 'plan_type', 'subscription_status',
    'trial_ends_at', 'subscription_ends_at',
    'max_users', 'storage_quota_mb',
    'billing_email', 'billing_afm', 'billing_phone', 'notes',
    'suspended', 'suspended_reason'
  ];
  const sets = [], values = [];
  let idx = 1;
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(req.body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
  values.push(id);
  try {
    const { rows: [org] } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!org) return res.status(404).json({ error: 'Not found' });
    res.json(org);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/organizations/:id/extend - extend subscription by N years
router.post('/organizations/:id/extend', async (req, res) => {
  const { id } = req.params;
  const { years = 1 } = req.body;
  try {
    const { rows: [org] } = await pool.query(
      `UPDATE organizations
       SET subscription_ends_at = COALESCE(subscription_ends_at, NOW()) + (INTERVAL '1 year' * $1),
           subscription_status = 'active',
           suspended = false,
           suspended_reason = NULL
       WHERE id = $2
       RETURNING id, name, subscription_ends_at`,
      [years, id]
    );
    if (!org) return res.status(404).json({ error: 'Not found' });
    res.json(org);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/organizations/:id/suspend
router.post('/organizations/:id/suspend', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  try {
    const { rows: [org] } = await pool.query(
      `UPDATE organizations SET suspended = true, suspended_reason = $1,
       subscription_status = 'suspended' WHERE id = $2 RETURNING id, name, suspended`,
      [reason || null, id]
    );
    if (!org) return res.status(404).json({ error: 'Not found' });
    res.json(org);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/organizations/:id/unsuspend
router.post('/organizations/:id/unsuspend', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: [org] } = await pool.query(
      `UPDATE organizations SET suspended = false, suspended_reason = NULL,
       subscription_status = 'active' WHERE id = $1 RETURNING id, name, suspended`,
      [id]
    );
    if (!org) return res.status(404).json({ error: 'Not found' });
    res.json(org);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/organizations/:id - HARD DELETE, requires confirmation
router.delete('/organizations/:id', async (req, res) => {
  const { id } = req.params;
  const { confirm } = req.body;
  if (confirm !== `DELETE-${id}`) {
    return res.status(400).json({
      error: `Body must include { "confirm": "DELETE-${id}" }`,
      hint: 'This is a destructive operation. Set the exact confirmation token.'
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // v2: Οι περισσότεροι πίνακες έχουν FK organization_id ON DELETE CASCADE,
    // οπότε το DELETE FROM organizations τους σβήνει αυτόματα. ΟΜΩΣ 11 πίνακες
    // έχουν στήλη organization_id ΧΩΡΙΣ δηλωμένο FK — δεν σβήνονται με cascade
    // και θα άφηναν ορφανές γραμμές. Τους σβήνουμε ρητά πρώτα.
    //
    // Προϋπόθεση: το FK case_documents.uploaded_by -> users να είναι
    // ON DELETE SET NULL (migrate-fk-cascade), αλλιώς μπλοκάρει το cascade.

    const noCascadeTables = [
      'addresses',
      'phone_numbers',
      'case_suggestion_feedback',
      'document_templates',
      'energeies_loipes_dikigoroi',
      'finance_exoda_exoterikon_synergaton',
      'finance_pagia_exoda',
      'finance_pososta_dikigoron',
      'invoice_series',
      'invoices',              // invoice_lines φεύγει με cascade μέσω invoice_id
      'organization_settings',
    ];
    for (const t of noCascadeTables) {
      try {
        await client.query(`DELETE FROM ${t} WHERE organization_id = $1`, [id]);
      } catch (e) {
        // Αν κάποιος πίνακας δεν υπάρχει σε αυτό το περιβάλλον, προχώρα
        if (e.code !== '42P01') throw e; // 42P01 = undefined_table
      }
    }

    // Τώρα το organization: cascade σβήνει τους υπόλοιπους 39 πίνακες
    // (users, ypotheseis, case_documents, energeies, κ.λπ.) αυτόματα.
    const { rowCount } = await client.query(
      `DELETE FROM organizations WHERE id = $1`, [id]);

    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/orgs delete]', err);
    res.status(500).json({
      error: err.message,
      hint: 'Η διαγραφή απέτυχε. Βεβαιωθείτε ότι έτρεξε το migrate-fk-cascade (case_documents.uploaded_by -> SET NULL).'
    });
  } finally {
    client.release();
  }
});

// ---- USERS ----

// POST /api/admin/organizations/:id/users - add user to org
router.post('/organizations/:id/users', async (req, res) => {
  const { id } = req.params;
  const {
    email, password, first_name, last_name,
    role = 'lawyer', is_active = true,
    is_platform_admin = false, can_view_finance = false
  } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await pool.query(`
      INSERT INTO users (
        organization_id, email, password_hash, first_name, last_name,
        role, is_active, is_platform_admin, can_view_finance
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, email, first_name, last_name, role, is_active, is_platform_admin
    `, [id, email, hash, first_name, last_name, role, is_active, is_platform_admin, can_view_finance]);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id - update user (email/name/role/active/password)
router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const allowedFields = ['email', 'first_name', 'last_name', 'role', 'is_active', 'can_view_finance', 'is_platform_admin'];
  const sets = [], values = [];
  let idx = 1;
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(req.body[key]);
    }
  }
  if (req.body.password) {
    if (req.body.password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });
    const hash = await bcrypt.hash(req.body.password, 10);
    sets.push(`password_hash = $${idx++}`);
    values.push(hash);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  sets.push(`updated_at = NOW()`);
  values.push(id);
  try {
    const { rows: [user] } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, email, role, is_active, is_platform_admin`,
      values
    );
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id - hard delete or deactivate on FK conflict
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  if (String(id) === String(req.user.id)) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  try {
    const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    // FK conflict — soft delete
    try {
      await pool.query(
        `UPDATE users SET is_active = false, email = 'deleted-' || id || '@thesis.local'
         WHERE id = $1`,
        [id]
      );
      res.json({ deactivated: true, reason: 'has references, deactivated instead' });
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});

module.exports = router;
