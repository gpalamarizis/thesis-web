// src/routes/subscriptions.js
// Χειρίζεται τη ροή αγοράς / ανανέωσης συνδρομής μέσω Viva Payments.
//
// Endpoints:
//   GET  /api/subscriptions/plans            → catalog πλάνων για επιλογή
//   GET  /api/subscriptions/current          → τρέχουσα συνδρομή του org
//   POST /api/subscriptions/checkout         → δημιουργεί Viva order, επιστρέφει checkout URL
//   POST /api/subscriptions/verify           → verify μετά return από Viva (fallback αν webhook αργεί)
//   GET  /api/viva/webhook                   → verification key (public, no auth)
//   POST /api/viva/webhook                   → transaction event (public, no auth)

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const viva = require('../services/viva');

const router = express.Router();

// ---------- ensure schema (idempotent) ----------
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN DEFAULT FALSE;
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
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email        VARCHAR(200);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_afm          VARCHAR(30);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_phone        VARCHAR(50);

    CREATE TABLE IF NOT EXISTS subscription_plans (
      aa BIGSERIAL PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(120) NOT NULL,
      plan_type VARCHAR(30) NOT NULL,
      max_users INTEGER NOT NULL,
      storage_quota_mb INTEGER NOT NULL,
      price_year NUMERIC(10,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'EUR',
      description TEXT,
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      aa                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      plan_code            VARCHAR(50) NOT NULL,
      plan_type            VARCHAR(30) NOT NULL,
      max_users            INTEGER NOT NULL,
      storage_quota_mb     INTEGER NOT NULL,
      amount_gross         NUMERIC(10,2) NOT NULL,
      currency             VARCHAR(3) DEFAULT 'EUR',
      period_start         TIMESTAMPTZ NOT NULL,
      period_end           TIMESTAMPTZ NOT NULL,
      status               VARCHAR(20) DEFAULT 'active',
      payment_method       VARCHAR(30) DEFAULT 'viva',
      viva_order_code      VARCHAR(80),
      viva_transaction_id  VARCHAR(80),
      partner_id           BIGINT,
      commission_rate      NUMERIC(5,2),
      commission_amount    NUMERIC(10,2),
      commission_paid      BOOLEAN DEFAULT FALSE,
      commission_paid_at   TIMESTAMPTZ,
      notes                TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_subs_org_status ON subscriptions(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_subs_viva_order ON subscriptions(viva_order_code);
  `);
  schemaEnsured = true;
}

// ================ PLANS ================
router.get('/subscriptions/plans', requireAuth, async (req, res) => {
  await ensureSchema();
  try {
    const r = await pool.query(`SELECT * FROM subscription_plans WHERE active = TRUE ORDER BY sort_order, price_year`);
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================ CURRENT ================
router.get('/subscriptions/current', requireAuth, async (req, res) => {
  await ensureSchema();
  const orgId = req.user.organization_id;
  try {
    const [org, sub, storage] = await Promise.all([
      pool.query(`SELECT id, name, plan_type, plan_code, max_users, storage_quota_mb, subscription_status, trial_ends_at, subscription_ends_at, suspended, billing_email, billing_afm, billing_phone FROM organizations WHERE id = $1`, [orgId]),
      pool.query(`SELECT * FROM subscriptions WHERE organization_id = $1 AND status = 'active' AND period_end > NOW() ORDER BY period_end DESC LIMIT 1`, [orgId]),
      pool.query(`SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes_used FROM case_documents WHERE organization_id = $1`, [orgId]),
    ]);
    const [users] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE organization_id = $1 AND is_active = TRUE`, [orgId]),
    ]);
    res.json({
      organization: org.rows[0],
      subscription: sub.rows[0] || null,
      usage: {
        active_users: users.rows[0].c,
        storage_bytes_used: Number(storage.rows[0].bytes_used || 0),
        storage_quota_mb: org.rows[0].storage_quota_mb,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================ CHECKOUT ================
router.post('/subscriptions/checkout', requireAuth, async (req, res) => {
  await ensureSchema();
  const orgId = req.user.organization_id;
  const { plan_code } = req.body || {};
  if (!plan_code) return res.status(400).json({ error: 'plan_code required' });

  try {
    // Owner-only
    const uR = await pool.query(`SELECT role, email, first_name, last_name FROM users WHERE id = $1`, [req.user.sub || req.user.id]);
    const u = uR.rows[0];
    if (!u || (u.role !== 'admin' && u.role !== 'owner')) {
      return res.status(403).json({ error: 'Only organization owner can purchase' });
    }

    const pR = await pool.query(`SELECT * FROM subscription_plans WHERE code = $1 AND active = TRUE`, [plan_code]);
    if (pR.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
    const plan = pR.rows[0];

    if (Number(plan.price_year) <= 0) return res.status(400).json({ error: 'Plan has zero price - contact admin' });

    const oR = await pool.query(`SELECT id, name, billing_email, referred_by_partner_id FROM organizations WHERE id = $1`, [orgId]);
    const org = oR.rows[0];
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Internal orderId (unique reference)
    const orderId = `THESIS-${orgId}-${plan.code}-${Date.now()}`;

    const { orderCode } = await viva.createPaymentOrder({
      amount: Number(plan.price_year),
      customerEmail: org.billing_email || u.email,
      customerName: `${u.first_name || ''} ${u.last_name || ''}`.trim() || org.name,
      orderId,
      description: `${plan.name} — ${org.name}`,
    });

    // Store a pending subscription (status='pending') που θα γίνει 'active' μετά το webhook
    await pool.query(`
      INSERT INTO subscriptions (organization_id, plan_code, plan_type, max_users, storage_quota_mb,
                                 amount_gross, currency, period_start, period_end,
                                 status, viva_order_code, partner_id, commission_rate, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7, NOW(), NOW() + INTERVAL '1 year',
              'pending', $8, $9, NULL, $10)
    `, [
      orgId, plan.code, plan.plan_type, plan.max_users, plan.storage_quota_mb,
      plan.price_year, plan.currency || 'EUR',
      String(orderCode), org.referred_by_partner_id,
      `orderId: ${orderId}`
    ]);

    res.json({
      order_code: orderCode,
      checkout_url: viva.getCheckoutUrl(orderCode),
      amount: Number(plan.price_year),
      plan_name: plan.name,
    });
  } catch (err) {
    console.error('[subscriptions/checkout]', err);
    res.status(500).json({ error: err.message });
  }
});

// ================ VERIFY (fallback από success page) ================
router.post('/subscriptions/verify', requireAuth, async (req, res) => {
  await ensureSchema();
  const orgId = req.user.organization_id;
  const { transaction_id, order_code } = req.body || {};
  if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });

  try {
    const tx = await viva.verifyTransaction(transaction_id);
    // tx: { statusId, amount, orderCode, merchantTrns, ... }
    // Successful transaction: statusId === 'F' (final) και amount > 0
    if (tx.statusId !== 'F') {
      return res.status(400).json({ error: 'Transaction not final', status: tx.statusId });
    }
    await activateSubscription(orgId, {
      order_code: String(tx.orderCode || order_code),
      transaction_id,
      amount: Number(tx.amount || 0) / 100,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[subscriptions/verify]', err);
    res.status(500).json({ error: err.message });
  }
});

// ================ WEBHOOK ================
// Viva calls GET first for verification key, then POST for events.
router.get('/viva/webhook', async (req, res) => {
  try {
    const key = await viva.getWebhookVerificationKey();
    res.json({ Key: key });
  } catch (err) {
    console.error('[viva webhook GET]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/viva/webhook', async (req, res) => {
  await ensureSchema();
  const body = req.body || {};
  try {
    // Transaction Payment Created event
    const eventType = body.EventTypeId;
    const evt = body.EventData || {};
    // 1796 = Transaction Payment Created
    if (eventType === 1796 && evt.StatusId === 'F') {
      const orderCode = String(evt.OrderCode);
      const transactionId = String(evt.TransactionId);
      const amount = Number(evt.Amount || 0);   // ήδη σε EUR από webhook (όχι cents)

      // Find pending subscription by order_code
      const sR = await pool.query(`SELECT * FROM subscriptions WHERE viva_order_code = $1 LIMIT 1`, [orderCode]);
      if (sR.rows.length > 0) {
        await activateSubscription(sR.rows[0].organization_id, {
          order_code: orderCode,
          transaction_id: transactionId,
          amount,
        });
      } else {
        console.warn('[viva webhook] no matching subscription for order', orderCode);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[viva webhook POST]', err);
    // Δεν επιστρέφουμε 500 για να μη κάνει retry συνέχεια το Viva
    res.json({ ok: false, error: err.message });
  }
});

// ================ helpers ================
async function activateSubscription(orgId, { order_code, transaction_id, amount }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load subscription + partner info
    const sR = await client.query(`SELECT s.*, p.commission_rate AS partner_commission_rate
                                     FROM subscriptions s
                                     LEFT JOIN partners p ON p.aa = s.partner_id
                                     WHERE s.viva_order_code = $1
                                     LIMIT 1`, [order_code]);
    if (sR.rows.length === 0) throw new Error('No pending subscription found');
    const sub = sR.rows[0];

    // Prevent double activation
    if (sub.status === 'active') {
      await client.query('COMMIT');
      return;
    }

    // Commission calculation
    let commissionRate = null;
    let commissionAmount = null;
    if (sub.partner_id && sub.partner_commission_rate != null) {
      commissionRate = Number(sub.partner_commission_rate);
      commissionAmount = Math.round(amount * commissionRate) / 100;
    }

    await client.query(`
      UPDATE subscriptions
         SET status = 'active',
             viva_transaction_id = $1,
             amount_gross = $2,
             commission_rate = $3,
             commission_amount = $4
       WHERE aa = $5
    `, [transaction_id, amount, commissionRate, commissionAmount, sub.aa]);

    // Update organization
    await client.query(`
      UPDATE organizations
         SET plan_code = $1,
             plan_type = $2,
             max_users = $3,
             storage_quota_mb = $4,
             subscription_status = 'active',
             subscription_ends_at = $5,
             suspended = FALSE,
             suspended_reason = NULL
       WHERE id = $6
    `, [sub.plan_code, sub.plan_type, sub.max_users, sub.storage_quota_mb, sub.period_end, orgId]);

    // Expire any older active subscriptions
    await client.query(`
      UPDATE subscriptions
         SET status = 'expired'
       WHERE organization_id = $1 AND aa <> $2 AND status = 'active'
    `, [orgId, sub.aa]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
