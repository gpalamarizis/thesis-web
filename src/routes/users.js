// Users CRUD for the currently authenticated user's organization.
// - Multi-tenant: all queries scoped by req.user.organization_id
// - Password hashing via bcryptjs/bcrypt (whichever is installed)
// - Only admins can create/edit/delete other users
// - Non-admins can only edit their own profile (name, password)
// - Prevents self-deletion
// - Prevents deletion of the last active admin

const express = require('express');

// Support both bcrypt and bcryptjs — backend auth.js uses whichever is in package.json
let bcrypt;
try { bcrypt = require('bcryptjs'); }
catch { bcrypt = require('bcrypt'); }

const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Extract current user id from JWT payload (uses 'sub' claim per JWT standard,
// but falls back to 'id' in case the middleware exposes it differently).
const currentUserId = (req) => req.user.sub || req.user.id;
const isAdmin       = (req) => req.user.role === 'admin';

const SAFE_COLS = 'id, organization_id, email, first_name, last_name, role, is_active, created_at';

// ---------- GET /api/users ----------
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${SAFE_COLS}
         FROM users
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [req.user.organization_id]
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[users/list]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /api/users/:id ----------
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${SAFE_COLS}
         FROM users
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Ο χρήστης δεν βρέθηκε' });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[users/get]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- POST /api/users ----------
router.post('/', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Μόνο διαχειριστές μπορούν να δημιουργούν χρήστες' });
  }
  const { email, password, first_name, last_name, role } = req.body || {};
  if (!email || !password || !first_name || !last_name) {
    return res.status(400).json({ error: 'Λείπουν υποχρεωτικά πεδία (email, password, first_name, last_name)' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Ο κωδικός πρέπει να είναι τουλάχιστον 8 χαρακτήρες' });
  }
  const finalRole = ['admin', 'owner', 'lawyer', 'secretary', 'trainee'].includes(role) ? role : 'lawyer';
  try {
    // Email uniqueness — globally, since email is the login identifier
    const dup = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: 'Το email χρησιμοποιείται ήδη' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
       RETURNING ${SAFE_COLS}`,
      [req.user.organization_id, email, password_hash, first_name, last_name, finalRole]
    );
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    console.error('[users/create]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- PUT /api/users/:id ----------
router.put('/:id', async (req, res) => {
  const targetId = req.params.id;
  const isSelf = String(currentUserId(req)) === String(targetId);

  // Only admins can edit other users; non-admins can edit only themselves
  if (!isAdmin(req) && !isSelf) {
    return res.status(403).json({ error: 'Δεν έχετε δικαίωμα επεξεργασίας αυτού του χρήστη' });
  }

  const { email, password, first_name, last_name, role, is_active } = req.body || {};

  try {
    // Verify user exists in this org
    const existing = await pool.query(
      'SELECT id, role FROM users WHERE id = $1 AND organization_id = $2',
      [targetId, req.user.organization_id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Ο χρήστης δεν βρέθηκε' });

    const currentRole = existing.rows[0].role;

    // Build dynamic UPDATE
    const fields = [];
    const params = [];
    let i = 1;

    if (email !== undefined)      { fields.push(`email = $${i++}`);      params.push(email); }
    if (first_name !== undefined) { fields.push(`first_name = $${i++}`); params.push(first_name); }
    if (last_name !== undefined)  { fields.push(`last_name = $${i++}`);  params.push(last_name); }

    // Only admins can change role or is_active
    if (role !== undefined && isAdmin(req)) {
      const finalRole = ['admin', 'owner', 'lawyer', 'secretary', 'trainee'].includes(role) ? role : currentRole;
      // Safety: prevent demoting the last admin
      if (currentRole === 'admin' && finalRole !== 'admin') {
        const adminCount = await pool.query(
          `SELECT COUNT(*)::int AS c FROM users
            WHERE organization_id = $1 AND role = 'admin' AND is_active = TRUE`,
          [req.user.organization_id]
        );
        if (adminCount.rows[0].c <= 1) {
          return res.status(400).json({ error: 'Δεν μπορείτε να αλλάξετε τον ρόλο του μοναδικού διαχειριστή' });
        }
      }
      fields.push(`role = $${i++}`);
      params.push(finalRole);
    }

    if (is_active !== undefined && isAdmin(req)) {
      fields.push(`is_active = $${i++}`);
      params.push(!!is_active);
    }

    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Ο κωδικός πρέπει να είναι τουλάχιστον 8 χαρακτήρες' });
      }
      const hash = await bcrypt.hash(password, 10);
      fields.push(`password_hash = $${i++}`);
      params.push(hash);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Δεν υπάρχουν αλλαγές' });
    }
    fields.push(`updated_at = NOW()`);

    params.push(targetId);
    params.push(req.user.organization_id);

    const r = await pool.query(
      `UPDATE users SET ${fields.join(', ')}
        WHERE id = $${i++} AND organization_id = $${i++}
        RETURNING ${SAFE_COLS}`,
      params
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[users/update]', err);
    // Handle unique email constraint violation
    if (err.code === '23505') return res.status(400).json({ error: 'Το email χρησιμοποιείται ήδη' });
    res.status(500).json({ error: err.message });
  }
});

// ---------- DELETE /api/users/:id ----------
router.delete('/:id', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Μόνο διαχειριστές μπορούν να διαγράφουν χρήστες' });
  }
  const targetId = req.params.id;
  if (String(currentUserId(req)) === String(targetId)) {
    return res.status(400).json({ error: 'Δεν μπορείτε να διαγράψετε τον εαυτό σας' });
  }
  try {
    const target = await pool.query(
      'SELECT role FROM users WHERE id = $1 AND organization_id = $2',
      [targetId, req.user.organization_id]
    );
    if (target.rows.length === 0) return res.status(404).json({ error: 'Ο χρήστης δεν βρέθηκε' });

    // Prevent deletion of the last active admin
    if (target.rows[0].role === 'admin') {
      const adminCount = await pool.query(
        `SELECT COUNT(*)::int AS c FROM users
          WHERE organization_id = $1 AND role = 'admin' AND is_active = TRUE`,
        [req.user.organization_id]
      );
      if (adminCount.rows[0].c <= 1) {
        return res.status(400).json({ error: 'Δεν μπορείτε να διαγράψετε τον μοναδικό διαχειριστή' });
      }
    }

    await pool.query(
      'DELETE FROM users WHERE id = $1 AND organization_id = $2',
      [targetId, req.user.organization_id]
    );
    res.status(204).end();
  } catch (err) {
    console.error('[users/delete]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
