// src/middleware/accessControl.js
// Access control helpers για case visibility, finance access, seat limits, subscription enforcement.
//
// buildCaseVisibilityFilter(user) returns { where: string, params: any[] }
// που προστίθεται στο WHERE των cases queries.
//
// Rules:
//   - Owner (role='admin'|'owner') βλέπει όλες τις υποθέσεις του org
//   - Σε 'shared' visibility_mode: όλοι βλέπουν όλα (εκτός denylist - TODO)
//   - Σε 'private' visibility_mode: μόνο υποθέσεις όπου
//        (a) είναι στους χειριστές (xeiristes_dikigoroi), Ή
//        (b) υπάρχει στον case_user_access allowlist (granted by owner)

const { pool } = require('../db');

let schemaEnsured = false;
async function ensureAccessSchema() {
  if (schemaEnsured) return;
  await pool.query(`
    -- Users: can_view_finance για γραμματείς/associates που επιλέγει ο owner
    ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_finance BOOLEAN DEFAULT FALSE;

    -- Case-level allowlist (για partnership_private mode)
    CREATE TABLE IF NOT EXISTS case_user_access (
      aa           BIGSERIAL PRIMARY KEY,
      ypothesi_id  BIGINT NOT NULL,
      user_id      BIGINT NOT NULL,
      can_view     BOOLEAN DEFAULT TRUE,
      can_edit     BOOLEAN DEFAULT TRUE,
      granted_by   BIGINT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (ypothesi_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_access_ypothesi ON case_user_access(ypothesi_id);
    CREATE INDEX IF NOT EXISTS idx_case_access_user     ON case_user_access(user_id);
  `);
  schemaEnsured = true;
}

/**
 * Load full user context: role, org visibility_mode, can_view_finance
 */
async function loadUserContext(userId) {
  await ensureAccessSchema();
  const r = await pool.query(`
    SELECT u.id, u.organization_id, u.role, u.can_view_finance, u.is_platform_admin,
           o.visibility_mode, o.subscription_status, o.suspended, o.max_users
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
     WHERE u.id = $1`, [userId]);
  return r.rows[0] || null;
}

function isOwner(ctx) {
  return ctx && (ctx.role === 'admin' || ctx.role === 'owner');
}

/**
 * Case visibility WHERE clause fragment.
 * Χρήση:
 *   const vis = await buildCaseVisibilityFilter(user);
 *   pool.query(`SELECT * FROM ypotheseis WHERE organization_id=$1 ${vis.and}`, [...args, ...vis.params]);
 *
 * Returns { and: string, params: any[] }
 *   - and: παίρνει AND ... μπροστά αν χρειάζεται filtering, αλλιώς κενό
 *   - params: επιπλέον parameters
 *
 * Ο caller πρέπει να δώσει nextParamIndex για να αποφύγει σύγκρουση $N.
 */
async function buildCaseVisibilityFilter(user, nextParamIndex = 2) {
  const ctx = await loadUserContext(user.sub || user.id);
  if (!ctx) return { and: ' AND FALSE', params: [] };

  if (isOwner(ctx)) return { and: '', params: [] };
  if (ctx.visibility_mode === 'shared') return { and: '', params: [] };

  // Private mode: μόνο εγγραφές στο allowlist (owner δίνει explicit access)
  const p = nextParamIndex;
  return {
    and: ` AND y.aa IN (SELECT ypothesi_id FROM case_user_access WHERE user_id = $${p} AND can_view = TRUE)`,
    params: [ctx.id],
  };
}

/**
 * Middleware: block if organization subscription is expired or suspended.
 * Επιτρέπει pass αν trial ή active.
 */
async function requireActiveSubscription(req, res, next) {
  try {
    const ctx = await loadUserContext(req.user.sub || req.user.id);
    if (!ctx) return res.status(401).json({ error: 'User not found' });
    if (ctx.is_platform_admin) return next(); // platform admins bypass
    if (ctx.suspended) return res.status(402).json({ error: 'Organization suspended' });
    if (ctx.subscription_status === 'expired' || ctx.subscription_status === 'cancelled') {
      return res.status(402).json({ error: 'Subscription expired', code: 'SUBSCRIPTION_EXPIRED' });
    }
    req.userCtx = ctx;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Middleware: allow finance endpoints only to owner OR users with can_view_finance=TRUE.
 */
async function requireFinanceAccess(req, res, next) {
  try {
    const ctx = req.userCtx || await loadUserContext(req.user.sub || req.user.id);
    if (!ctx) return res.status(401).json({ error: 'User not found' });
    if (isOwner(ctx) || ctx.can_view_finance) {
      req.userCtx = ctx;
      return next();
    }
    return res.status(403).json({ error: 'Δεν έχεις δικαίωμα πρόσβασης στα οικονομικά' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Check if adding one more user would exceed max_users.
 * Χρήση πριν από invite/create user.
 */
async function checkSeatLimit(orgId) {
  const r = await pool.query(`
    SELECT o.max_users, (SELECT COUNT(*)::int FROM users WHERE organization_id = $1 AND is_active = TRUE) AS active_count
      FROM organizations o WHERE o.id = $1`, [orgId]);
  const row = r.rows[0];
  if (!row) throw new Error('Organization not found');
  if (row.max_users && row.active_count >= row.max_users) {
    const err = new Error(`Έχεις φτάσει το όριο χρηστών (${row.max_users}). Αναβάθμισε το πλάνο.`);
    err.code = 'SEAT_LIMIT_REACHED';
    throw err;
  }
  return { max_users: row.max_users, active_count: row.active_count };
}

async function requireOwner(req, res, next) {
  try {
    const ctx = req.userCtx || await loadUserContext(req.user.sub || req.user.id);
    if (!ctx) return res.status(401).json({ error: 'User not found' });
    if (!isOwner(ctx)) return res.status(403).json({ error: 'Απαιτείται δικαίωμα διαχειριστή' });
    req.userCtx = ctx;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  ensureAccessSchema,
  loadUserContext,
  isOwner,
  buildCaseVisibilityFilter,
  requireActiveSubscription,
  requireFinanceAccess,
  requireOwner,
  checkSeatLimit,
};
