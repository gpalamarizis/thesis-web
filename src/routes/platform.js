// src/routes/platform.js
// Platform-level administration: για co-admins (Γιώργος + συνεργάτες)
// που διαχειρίζονται όλα τα organizations, τα subscriptions, τους partners
// και τα commissions.
//
// Access control: μόνο users με is_platform_admin = TRUE.
// Δεν έχει σχέση με το organization role (owner/lawyer/secretary).
//
// Auto-creates required tables + columns on first request (idempotent).

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;

  // 1. Extend users με is_platform_admin
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_users_platform_admin ON users(is_platform_admin) WHERE is_platform_admin = TRUE;
  `);

  // 2. Extend organizations με subscription + referral tracking
  await pool.query(`
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_type            VARCHAR(30)  DEFAULT 'solo';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_code            VARCHAR(50);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS visibility_mode      VARCHAR(20)  DEFAULT 'shared';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS max_users            INTEGER      DEFAULT 1;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS storage_quota_mb     INTEGER      DEFAULT 5120;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_status  VARCHAR(20)  DEFAULT 'trial';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at        TIMESTAMPTZ;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS referred_by_partner_id BIGINT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended            BOOLEAN      DEFAULT FALSE;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_reason     TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS notes                TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email        VARCHAR(200);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_afm          VARCHAR(30);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_phone        VARCHAR(50);
  `);

  // Set default trial_ends_at = created_at + 30 days for existing orgs
  await pool.query(`
    UPDATE organizations
       SET trial_ends_at = created_at + INTERVAL '30 days'
     WHERE trial_ends_at IS NULL;
  `);

  // 3. Partners (referral) πίνακας
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partners (
      aa                    BIGSERIAL PRIMARY KEY,
      code                  VARCHAR(50) UNIQUE NOT NULL,       -- ο referral code
      full_name             VARCHAR(200) NOT NULL,
      email                 VARCHAR(200),
      phone                 VARCHAR(50),
      afm                   VARCHAR(30),
      commission_rate       NUMERIC(5,2) NOT NULL DEFAULT 10.00, -- π.χ. 10.00 = 10%
      iban                  VARCHAR(40),
      notes                 TEXT,
      active                BOOLEAN DEFAULT TRUE,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      created_by            BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_partners_code ON partners(code);
  `);

  // 4. Subscriptions history (payments)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      aa                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      plan_code            VARCHAR(50) NOT NULL,
      plan_type            VARCHAR(30) NOT NULL,               -- solo | partnership_shared | ...
      max_users            INTEGER NOT NULL,
      storage_quota_mb     INTEGER NOT NULL,
      amount_gross         NUMERIC(10,2) NOT NULL,             -- τιμή που πληρώθηκε
      currency             VARCHAR(3) DEFAULT 'EUR',
      period_start         TIMESTAMPTZ NOT NULL,
      period_end           TIMESTAMPTZ NOT NULL,
      status               VARCHAR(20) DEFAULT 'active',       -- active | expired | refunded | cancelled
      payment_method       VARCHAR(30) DEFAULT 'viva',
      viva_order_code      VARCHAR(80),
      viva_transaction_id  VARCHAR(80),
      partner_id           BIGINT,                              -- για attribution/commission
      commission_rate      NUMERIC(5,2),                        -- snapshot της τιμής commission
      commission_amount    NUMERIC(10,2),                       -- υπολογισμένο ποσό commission
      commission_paid      BOOLEAN DEFAULT FALSE,
      commission_paid_at   TIMESTAMPTZ,
      notes                TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_subs_org        ON subscriptions(organization_id);
    CREATE INDEX IF NOT EXISTS idx_subs_partner    ON subscriptions(partner_id);
    CREATE INDEX IF NOT EXISTS idx_subs_status     ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS idx_subs_period_end ON subscriptions(period_end);
  `);

  // 5. Plans catalog (ο super-admin μπορεί να ρυθμίσει τιμές μελλοντικά)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      aa                BIGSERIAL PRIMARY KEY,
      code              VARCHAR(50) UNIQUE NOT NULL,
      name              VARCHAR(120) NOT NULL,
      plan_type         VARCHAR(30) NOT NULL,
      max_users         INTEGER NOT NULL,
      storage_quota_mb  INTEGER NOT NULL,
      price_year        NUMERIC(10,2) NOT NULL,
      currency          VARCHAR(3) DEFAULT 'EUR',
      description       TEXT,
      active            BOOLEAN DEFAULT TRUE,
      sort_order        INTEGER DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed default plans αν είναι κενό. Οι τιμές είναι placeholders — τις αλλάζει ο super-admin.
  const planCount = await pool.query(`SELECT COUNT(*)::int AS c FROM subscription_plans`);
  if (planCount.rows[0].c === 0) {
    await pool.query(`
      INSERT INTO subscription_plans (code, name, plan_type, max_users, storage_quota_mb, price_year, sort_order) VALUES
        ('solo',            'Μεμονωμένος δικηγόρος',   'solo',                 1,   5120,   0.00, 10),
        ('partner_basic',   'Partnership Basic',        'partnership_shared',   5,  20480,   0.00, 20),
        ('partner_pro',     'Partnership Pro',          'partnership_shared',  15,  51200,   0.00, 30),
        ('partner_private', 'Partnership Private',      'partnership_private', 15,  51200,   0.00, 40),
        ('firm_small',      'Δικηγορική Εταιρεία S',    'law_firm',            25, 102400,   0.00, 50),
        ('firm_medium',     'Δικηγορική Εταιρεία M',    'law_firm',            50, 204800,   0.00, 60);
    `);
  }

  // 6. Activity log (audit trail)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_activity_log (
      aa               BIGSERIAL PRIMARY KEY,
      admin_user_id    BIGINT NOT NULL,
      admin_email      VARCHAR(200),
      action           VARCHAR(80) NOT NULL,        -- e.g. 'extend_trial', 'suspend_org', 'create_partner'
      target_type      VARCHAR(30),                  -- 'organization' | 'partner' | 'subscription'
      target_id        BIGINT,
      details          JSONB,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_platform_log_target ON platform_activity_log(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_platform_log_time   ON platform_activity_log(created_at DESC);
  `);

  schemaEnsured = true;
}

// ---- Middleware: platform admin only ----
async function requirePlatformAdmin(req, res, next) {
  await ensureSchema();
  try {
    const r = await pool.query(
      `SELECT is_platform_admin FROM users WHERE id = $1`,
      [req.user.sub || req.user.id]
    );
    if (r.rows.length === 0 || !r.rows[0].is_platform_admin) {
      return res.status(403).json({ error: 'Platform admin required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function logAction(userId, email, action, targetType, targetId, details) {
  try {
    await pool.query(
      `INSERT INTO platform_activity_log (admin_user_id, admin_email, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, email, action, targetType, targetId, JSON.stringify(details || {})]
    );
  } catch (e) {
    console.error('[platform log]', e.message);
  }
}

router.use(requirePlatformAdmin);

// ========== DASHBOARD STATS ==========
router.get('/stats', async (req, res) => {
  try {
    const [orgs, users, subs, partners, mrr] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int                                                              AS total,
          COUNT(*) FILTER (WHERE subscription_status = 'active')::int               AS active,
          COUNT(*) FILTER (WHERE subscription_status = 'trial')::int                AS trial,
          COUNT(*) FILTER (WHERE subscription_status = 'expired')::int              AS expired,
          COUNT(*) FILTER (WHERE suspended = TRUE)::int                             AS suspended,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int      AS new_last_30d
        FROM organizations`),
      pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE is_active = TRUE`),
      pool.query(`
        SELECT
          COUNT(*)::int                                                                    AS total,
          COALESCE(SUM(amount_gross), 0)::float                                            AS revenue_total,
          COALESCE(SUM(amount_gross) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::float AS revenue_last_30d,
          COALESCE(SUM(commission_amount) FILTER (WHERE commission_paid = FALSE), 0)::float AS commissions_owed
        FROM subscriptions
        WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM partners WHERE active = TRUE`),
      pool.query(`
        SELECT COALESCE(SUM(amount_gross / 12), 0)::float AS mrr
        FROM subscriptions
        WHERE status = 'active' AND period_end > NOW()`),
    ]);

    res.json({
      organizations: orgs.rows[0],
      users: users.rows[0].c,
      subscriptions: subs.rows[0],
      partners_active: partners.rows[0].c,
      mrr: mrr.rows[0].mrr,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ORGANIZATIONS ==========
router.get('/organizations', async (req, res) => {
  const { q, status, plan_type, suspended, partner_id, sort = 'created_at', order = 'desc' } = req.query;
  const filters = [];
  const params = [];
  let i = 1;

  if (q) {
    filters.push(`(o.name ILIKE $${i} OR o.slug ILIKE $${i} OR o.billing_email ILIKE $${i})`);
    params.push(`%${q}%`); i++;
  }
  if (status) { filters.push(`o.subscription_status = $${i}`); params.push(status); i++; }
  if (plan_type) { filters.push(`o.plan_type = $${i}`); params.push(plan_type); i++; }
  if (suspended !== undefined) { filters.push(`o.suspended = $${i}`); params.push(suspended === 'true'); i++; }
  if (partner_id) { filters.push(`o.referred_by_partner_id = $${i}`); params.push(parseInt(partner_id, 10)); i++; }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const validSort = ['created_at', 'name', 'subscription_status', 'trial_ends_at', 'subscription_ends_at'].includes(sort) ? sort : 'created_at';
  const validOrder = order === 'asc' ? 'ASC' : 'DESC';

  try {
    const r = await pool.query(`
      SELECT
        o.*,
        p.full_name AS partner_name,
        p.code      AS partner_code,
        (SELECT COUNT(*)::int FROM users u WHERE u.organization_id = o.id AND u.is_active = TRUE) AS active_users,
        (SELECT COUNT(*)::int FROM ypotheseis y WHERE y.organization_id = o.id) AS total_cases,
        (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM case_documents cd WHERE cd.organization_id = o.id) AS storage_bytes_used,
        (SELECT COALESCE(SUM(amount_gross), 0)::float FROM subscriptions s WHERE s.organization_id = o.id AND s.status = 'active') AS revenue_ytd
      FROM organizations o
      LEFT JOIN partners p ON p.aa = o.referred_by_partner_id
      ${where}
      ORDER BY o.${validSort} ${validOrder}
      LIMIT 200
    `, params);

    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/organizations/:id', async (req, res) => {
  try {
    const orgId = parseInt(req.params.id, 10);
    const [org, users, subs, activity] = await Promise.all([
      pool.query(`
        SELECT o.*, p.full_name AS partner_name, p.code AS partner_code, p.commission_rate AS partner_commission_rate
          FROM organizations o
          LEFT JOIN partners p ON p.aa = o.referred_by_partner_id
         WHERE o.id = $1`, [orgId]),
      pool.query(`SELECT id, email, first_name, last_name, role, is_active, created_at FROM users WHERE organization_id = $1 ORDER BY created_at ASC`, [orgId]),
      pool.query(`SELECT * FROM subscriptions WHERE organization_id = $1 ORDER BY period_start DESC LIMIT 50`, [orgId]),
      pool.query(`SELECT * FROM platform_activity_log WHERE target_type = 'organization' AND target_id = $1 ORDER BY created_at DESC LIMIT 50`, [orgId]),
    ]);

    if (org.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });

    res.json({
      organization: org.rows[0],
      users: users.rows,
      subscriptions: subs.rows,
      activity_log: activity.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/organizations/:id', async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['plan_type', 'plan_code', 'visibility_mode', 'max_users', 'storage_quota_mb',
                   'subscription_status', 'trial_ends_at', 'subscription_ends_at',
                   'referred_by_partner_id', 'suspended', 'suspended_reason', 'notes',
                   'billing_email', 'billing_afm', 'billing_phone', 'name'];
  const sets = [];
  const params = [];
  let i = 1;
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`${k} = $${i}`); params.push(b[k]); i++; }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(orgId);

  try {
    const r = await pool.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await logAction(req.user.sub || req.user.id, req.user.email, 'update_organization', 'organization', orgId, b);
    res.json({ data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick actions
router.post('/organizations/:id/extend-trial', async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  const days = parseInt(req.body.days || 30, 10);
  try {
    const r = await pool.query(`
      UPDATE organizations
         SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + INTERVAL '1 day' * $1,
             subscription_status = CASE WHEN subscription_status = 'expired' THEN 'trial' ELSE subscription_status END
       WHERE id = $2 RETURNING trial_ends_at`, [days, orgId]);
    await logAction(req.user.sub || req.user.id, req.user.email, 'extend_trial', 'organization', orgId, { days });
    res.json({ data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/organizations/:id/suspend', async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  try {
    await pool.query(`UPDATE organizations SET suspended = TRUE, suspended_reason = $1 WHERE id = $2`, [req.body.reason || 'admin action', orgId]);
    await logAction(req.user.sub || req.user.id, req.user.email, 'suspend_org', 'organization', orgId, { reason: req.body.reason });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/organizations/:id/unsuspend', async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  try {
    await pool.query(`UPDATE organizations SET suspended = FALSE, suspended_reason = NULL WHERE id = $1`, [orgId]);
    await logAction(req.user.sub || req.user.id, req.user.email, 'unsuspend_org', 'organization', orgId, {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PARTNERS ==========
router.get('/partners', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*,
        (SELECT COUNT(*)::int FROM organizations o WHERE o.referred_by_partner_id = p.aa) AS org_count,
        (SELECT COALESCE(SUM(commission_amount), 0)::float FROM subscriptions s WHERE s.partner_id = p.aa) AS commission_total,
        (SELECT COALESCE(SUM(commission_amount) FILTER (WHERE commission_paid = FALSE), 0)::float FROM subscriptions s WHERE s.partner_id = p.aa) AS commission_owed
      FROM partners p
      ORDER BY p.active DESC, p.full_name ASC
    `);
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/partners', async (req, res) => {
  const b = req.body || {};
  if (!b.full_name || !b.code) return res.status(400).json({ error: 'code + full_name required' });
  try {
    const r = await pool.query(`
      INSERT INTO partners (code, full_name, email, phone, afm, commission_rate, iban, notes, active, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [b.code, b.full_name, b.email || null, b.phone || null, b.afm || null,
       b.commission_rate ?? 10, b.iban || null, b.notes || null, b.active !== false,
       req.user.sub || req.user.id]);
    await logAction(req.user.sub || req.user.id, req.user.email, 'create_partner', 'partner', r.rows[0].aa, { code: b.code });
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Code already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/partners/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['full_name', 'email', 'phone', 'afm', 'commission_rate', 'iban', 'notes', 'active'];
  const sets = []; const params = []; let i = 1;
  for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k} = $${i}`); params.push(b[k]); i++; }
  if (!sets.length) return res.status(400).json({ error: 'No fields' });
  params.push(id);
  try {
    const r = await pool.query(`UPDATE partners SET ${sets.join(', ')} WHERE aa = $${i} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    await logAction(req.user.sub || req.user.id, req.user.email, 'update_partner', 'partner', id, b);
    res.json({ data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SUBSCRIPTIONS ==========
router.get('/subscriptions', async (req, res) => {
  const { organization_id, partner_id, status, from, to } = req.query;
  const filters = [];
  const params = [];
  let i = 1;
  if (organization_id) { filters.push(`s.organization_id = $${i}`); params.push(parseInt(organization_id, 10)); i++; }
  if (partner_id) { filters.push(`s.partner_id = $${i}`); params.push(parseInt(partner_id, 10)); i++; }
  if (status) { filters.push(`s.status = $${i}`); params.push(status); i++; }
  if (from) { filters.push(`s.created_at >= $${i}`); params.push(from); i++; }
  if (to) { filters.push(`s.created_at <= $${i}`); params.push(to); i++; }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const r = await pool.query(`
      SELECT s.*, o.name AS organization_name, p.full_name AS partner_name
        FROM subscriptions s
        LEFT JOIN organizations o ON o.id = s.organization_id
        LEFT JOIN partners p ON p.aa = s.partner_id
        ${where}
        ORDER BY s.created_at DESC
        LIMIT 500
    `, params);
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subscriptions/:id/mark-commission-paid', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await pool.query(`UPDATE subscriptions SET commission_paid = TRUE, commission_paid_at = NOW() WHERE aa = $1`, [id]);
    await logAction(req.user.sub || req.user.id, req.user.email, 'mark_commission_paid', 'subscription', id, {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PLANS CATALOG ==========
router.get('/plans', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM subscription_plans ORDER BY sort_order, name`);
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/plans/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['name', 'plan_type', 'max_users', 'storage_quota_mb', 'price_year', 'description', 'active', 'sort_order'];
  const sets = []; const params = []; let i = 1;
  for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k} = $${i}`); params.push(b[k]); i++; }
  if (!sets.length) return res.status(400).json({ error: 'No fields' });
  params.push(id);
  try {
    const r = await pool.query(`UPDATE subscription_plans SET ${sets.join(', ')} WHERE aa = $${i} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    await logAction(req.user.sub || req.user.id, req.user.email, 'update_plan', 'plan', id, b);
    res.json({ data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ACTIVITY LOG ==========
router.get('/activity', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || 100, 10), 500);
  try {
    const r = await pool.query(`SELECT * FROM platform_activity_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CO-ADMINS (users με is_platform_admin) ==========
router.get('/admins', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.created_at,
             o.name AS organization_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.is_platform_admin = TRUE
       ORDER BY u.created_at ASC`);
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admins/grant', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const r = await pool.query(`UPDATE users SET is_platform_admin = TRUE WHERE email = $1 RETURNING id, email, first_name, last_name`, [email]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    await logAction(req.user.sub || req.user.id, req.user.email, 'grant_platform_admin', 'user', r.rows[0].id, { email });
    res.json({ data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admins/revoke', async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    await pool.query(`UPDATE users SET is_platform_admin = FALSE WHERE id = $1`, [parseInt(user_id, 10)]);
    await logAction(req.user.sub || req.user.id, req.user.email, 'revoke_platform_admin', 'user', user_id, {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EXTENDED: Create/Delete orgs + full user management
// Added 2026-07-24
// ============================================================

// POST /api/platform/organizations
// Create a new organization + first admin user (offline signup)
router.post('/organizations', async (req, res) => {
  const {
    name, slug, plan_type = 'enterprise',
    admin_email, admin_password, admin_first_name = 'Admin', admin_last_name = '',
    subscription_start,        // ISO date, defaults to now
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
    await logAction(req.user.sub || req.user.id, req.user.email, 'create_organization', 'organization', org.id, { name, slug });
    res.status(201).json({ data: { organization: org, admin_user: userResult.rows[0] } });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[platform/orgs create]', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Slug or email already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/platform/organizations/:id/extend
// Extend subscription by N years (default 1)
router.post('/organizations/:id/extend', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { years = 1 } = req.body || {};
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
    await logAction(req.user.sub || req.user.id, req.user.email, 'extend_subscription', 'organization', id, { years });
    res.json({ data: org });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/platform/organizations/:id
// HARD delete - requires confirmation token in body
router.delete('/organizations/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { confirm } = req.body || {};
  if (confirm !== `DELETE-${id}`) {
    return res.status(400).json({
      error: `Body must include { "confirm": "DELETE-${id}" }`
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM users WHERE organization_id = $1`, [id]);
    const { rowCount } = await client.query(`DELETE FROM organizations WHERE id = $1`, [id]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    await client.query('COMMIT');
    await logAction(req.user.sub || req.user.id, req.user.email, 'delete_organization', 'organization', id, {});
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[platform/orgs delete]', err);
    res.status(500).json({
      error: err.message + ' (Org has references. Suspend instead.)'
    });
  } finally {
    client.release();
  }
});

// GET /api/platform/organizations/:id/users
router.get('/organizations/:id/users', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await pool.query(`
      SELECT id, email, first_name, last_name, role, is_active,
             is_platform_admin, can_view_finance, created_at
      FROM users WHERE organization_id = $1
      ORDER BY is_platform_admin DESC, id
    `, [id]);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/platform/organizations/:id/users
router.post('/organizations/:id/users', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const {
    email, password, first_name, last_name,
    role = 'lawyer', is_active = true, can_view_finance = false
  } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await pool.query(`
      INSERT INTO users (
        organization_id, email, password_hash, first_name, last_name,
        role, is_active, can_view_finance
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, email, first_name, last_name, role, is_active
    `, [id, email, hash, first_name, last_name, role, is_active, can_view_finance]);
    await logAction(req.user.sub || req.user.id, req.user.email, 'create_user', 'user', user.id, { org_id: id, email });
    res.status(201).json({ data: user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/platform/users/:id
router.patch('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowedFields = ['email', 'first_name', 'last_name', 'role', 'is_active', 'can_view_finance'];
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
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, email, role, is_active`,
      values
    );
    if (!user) return res.status(404).json({ error: 'Not found' });
    await logAction(req.user.sub || req.user.id, req.user.email, 'update_user', 'user', id, req.body);
    res.json({ data: user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/platform/users/:id
router.delete('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const currentUserId = req.user.sub || req.user.id;
  if (String(id) === String(currentUserId)) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  try {
    const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    await logAction(currentUserId, req.user.email, 'delete_user', 'user', id, {});
    res.json({ deleted: true });
  } catch (err) {
    try {
      await pool.query(
        `UPDATE users SET is_active = false, email = 'deleted-' || id || '@thesis.local' WHERE id = $1`,
        [id]
      );
      await logAction(currentUserId, req.user.email, 'deactivate_user', 'user', id, { reason: 'FK conflict' });
      res.json({ deactivated: true, reason: 'has references, deactivated instead' });
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});

module.exports = router;
