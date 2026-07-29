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

// ================ HEALTH (διάγνωση ρυθμίσεων) ================
// Μόνο για platform admin — δείχνει ΑΝ λείπει μεταβλητή, ΟΧΙ τις τιμές τους.
router.get('/subscriptions/health', requireAuth, async (req, res) => {
  if (!req.user.is_platform_admin) return res.status(403).json({ error: 'platform admin only' });
  try {
    const cfg = viva.checkConfig();
    let tokenOk = false, tokenErr = null;
    if (cfg.ok) {
      try { await viva.getAccessToken(); tokenOk = true; }
      catch (e) { tokenErr = e.message; }
    }
    let webhookKeyOk = false, webhookErr = null;
    if (cfg.ok) {
      try { const k = await viva.getWebhookVerificationKey(); webhookKeyOk = !!k; }
      catch (e) { webhookErr = e.message; }
    }
    res.json({
      env: cfg.env,
      config_complete: cfg.ok,
      missing_vars: cfg.missing,
      oauth_token: tokenOk ? 'OK' : `ΑΠΕΤΥΧΕ: ${tokenErr}`,
      webhook_key: webhookKeyOk ? 'OK' : `ΑΠΕΤΥΧΕ: ${webhookErr}`,
      webhook_url: 'https://api.thesislegal.gr/api/viva/webhook',
      urls: cfg.urls,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    if (tx.statusId !== 'F') {
      return res.status(400).json({ error: 'Transaction not final', status: tx.statusId });
    }

    const oc = String(tx.orderCode || order_code || '');
    if (!oc) return res.status(400).json({ error: 'order code missing' });

    // ΑΣΦΑΛΕΙΑ: η συνδρομή πρέπει να ανήκει στον ΔΙΚΟ ΤΟΥ οργανισμό.
    // Χωρίς αυτόν τον έλεγχο, κάποιος θα μπορούσε να στείλει το transaction_id
    // άλλου γραφείου και να ενεργοποιήσει τη δική του συνδρομή με ξένη πληρωμή.
    const own = await pool.query(
      `SELECT organization_id FROM subscriptions WHERE viva_order_code = $1 LIMIT 1`, [oc]);
    if (own.rows.length === 0) {
      return res.status(404).json({ error: 'Δεν βρέθηκε αντίστοιχη συνδρομή' });
    }
    if (Number(own.rows[0].organization_id) !== Number(orgId)) {
      console.warn(`[verify] ΑΠΟΠΕΙΡΑ ΔΙΑΣΤΑΥΡΩΣΗΣ: χρήστης org=${orgId} ζήτησε order=${oc} που ανήκει σε org=${own.rows[0].organization_id}`);
      return res.status(403).json({ error: 'Η πληρωμή δεν ανήκει σε αυτό το γραφείο' });
    }

    await activateSubscription({
      order_code: oc,
      transaction_id,
      reported_amount: parseVivaAmount(tx.amount),
      source: 'verify',
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
  const body = req.body || {};
  const eventType = body.EventTypeId;
  const evt = body.EventData || {};
  const orderCode = evt.OrderCode != null ? String(evt.OrderCode) : null;

  console.log(`[viva webhook] EventTypeId=${eventType} Order=${orderCode} Status=${evt.StatusId} Amount=${evt.Amount}`);

  try {
    await ensureSchema();

    // 1796 = Transaction Payment Created (επιτυχής πληρωμή)
    // 1798 = Transaction Failed
    if (eventType !== 1796) {
      // Δεν μας αφορά — 200 ώστε να μη ξαναστείλει
      return res.json({ ok: true, ignored: `EventTypeId ${eventType}` });
    }
    if (evt.StatusId !== 'F') {
      return res.json({ ok: true, ignored: `StatusId ${evt.StatusId}` });
    }
    if (!orderCode) {
      return res.json({ ok: true, ignored: 'no OrderCode' });
    }

    const sR = await pool.query(
      `SELECT aa FROM subscriptions WHERE viva_order_code = $1 LIMIT 1`, [orderCode]);

    if (sR.rows.length === 0) {
      // ΜΟΝΙΜΟ πρόβλημα — δεν έχει νόημα retry. Καταγράφουμε και απαντάμε 200.
      console.warn(`[viva webhook] ΔΕΝ ΒΡΕΘΗΚΕ συνδρομή για order=${orderCode}. ` +
                   `Πιθανή πληρωμή εκτός Thesis ή χειροκίνητη — έλεγξέ το.`);
      return res.json({ ok: true, warning: 'no matching subscription' });
    }

    await activateSubscription({
      order_code: orderCode,
      transaction_id: String(evt.TransactionId || ''),
      // Το webhook δίνει ΔΕΚΑΔΙΚΑ ΕΥΡΩ (π.χ. 100.50), όχι λεπτά
      reported_amount: parseVivaAmount(evt.Amount),
      source: 'webhook',
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[viva webhook POST]', err);
    // ΠΡΟΣΩΡΙΝΟ σφάλμα (π.χ. βάση κάτω) -> 500 ώστε το Viva να ΞΑΝΑΠΡΟΣΠΑΘΗΣΕΙ.
    // Το Viva κάνει 24 προσπάθειες, μία ανά ώρα. Αν απαντούσαμε 200,
    // η πληρωμή θα χανόταν σιωπηλά.
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ================ helpers ================

/**
 * Το Viva επιστρέφει ποσά διαφορετικά ανά endpoint:
 *   - webhook (EventData.Amount)      -> ΔΕΚΑΔΙΚΑ ΕΥΡΩ, π.χ. 100.50
 *   - checkout/v2/transactions.amount -> επίσης δεκαδικά ευρώ
 * Επιστρέφουμε πάντα αριθμό σε ευρώ, ή null αν λείπει.
 */
function parseVivaAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ενεργοποίηση συνδρομής.
 *
 * ΣΗΜΑΝΤΙΚΟ: ο οργανισμός προκύπτει ΑΠΟ ΤΗ ΣΥΝΔΡΟΜΗ, ποτέ από παράμετρο.
 * Έτσι δεν γίνεται να ενεργοποιηθεί λάθος γραφείο.
 *
 * Το ποσό που χρεώνεται είναι πάντα το ΑΠΟΘΗΚΕΥΜΕΝΟ (amount_gross της
 * συνδρομής). Το reported_amount από το Viva χρησιμοποιείται ΜΟΝΟ για έλεγχο.
 */
async function activateSubscription({ order_code, transaction_id, reported_amount, source }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Υπάρχει ο πίνακας partners; (μπορεί να μην έχει δημιουργηθεί ακόμα)
    const hasPartners = (await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_schema='public' AND table_name='partners'`)).rows[0].n > 0;

    const sql = hasPartners
      ? `SELECT s.*, p.commission_rate AS partner_commission_rate
           FROM subscriptions s
           LEFT JOIN partners p ON p.aa = s.partner_id
          WHERE s.viva_order_code = $1
          FOR UPDATE OF s
          LIMIT 1`
      : `SELECT s.*, NULL::numeric AS partner_commission_rate
           FROM subscriptions s
          WHERE s.viva_order_code = $1
          FOR UPDATE
          LIMIT 1`;

    const sR = await client.query(sql, [order_code]);
    if (sR.rows.length === 0) throw new Error(`Δεν βρέθηκε συνδρομή για order ${order_code}`);
    const sub = sR.rows[0];
    const orgId = sub.organization_id;

    // Ήδη ενεργή -> τίποτα (idempotent, το Viva μπορεί να στείλει 2 φορές)
    if (sub.status === 'active') {
      await client.query('COMMIT');
      console.log(`[activate] order=${order_code} ήδη ενεργή, παραλείπεται (${source})`);
      return { alreadyActive: true, organization_id: orgId };
    }

    // ΕΛΕΓΧΟΣ ΠΟΣΟΥ — δεν μπλοκάρει, αλλά καταγράφεται έντονα ώστε να το δεις.
    const expected = Number(sub.amount_gross);
    if (reported_amount != null && Number.isFinite(expected)) {
      const diff = Math.abs(reported_amount - expected);
      if (diff > 0.01) {
        console.error(
          `[activate] ΔΙΑΦΟΡΑ ΠΟΣΟΥ order=${order_code}: ` +
          `αναμενόμενο ${expected.toFixed(2)} EUR, πληρώθηκε ${reported_amount.toFixed(2)} EUR ` +
          `(διαφορά ${diff.toFixed(2)}) — ΕΛΕΓΞΕ ΤΟ ΧΕΙΡΟΚΙΝΗΤΑ`
        );
      }
    }

    // Προμήθεια συνεργάτη
    let commissionRate = null;
    let commissionAmount = null;
    if (sub.partner_id && sub.partner_commission_rate != null) {
      commissionRate = Number(sub.partner_commission_rate);
      commissionAmount = Math.round(expected * commissionRate) / 100;
    }

    await client.query(`
      UPDATE subscriptions
         SET status = 'active',
             viva_transaction_id = $1,
             commission_rate = $2,
             commission_amount = $3,
             notes = COALESCE(notes, '') || $4
       WHERE aa = $5
    `, [transaction_id, commissionRate, commissionAmount,
        ` | ενεργοποιήθηκε ${new Date().toISOString()} (${source})`, sub.aa]);

    // Αν ανανεώνει ΠΡΙΝ λήξει, ο υπόλοιπος χρόνος ΔΕΝ χάνεται —
    // η νέα περίοδος ξεκινά από τη λήξη της τρέχουσας.
    const orgR = await client.query(
      `SELECT subscription_ends_at FROM organizations WHERE id = $1`, [orgId]);
    const currentEnd = orgR.rows[0]?.subscription_ends_at;
    const startsFrom = (currentEnd && new Date(currentEnd) > new Date())
      ? new Date(currentEnd)
      : new Date();
    const newEnd = new Date(startsFrom);
    newEnd.setFullYear(newEnd.getFullYear() + 1);

    await client.query(
      `UPDATE subscriptions SET period_start = $1, period_end = $2 WHERE aa = $3`,
      [startsFrom, newEnd, sub.aa]);

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
    `, [sub.plan_code, sub.plan_type, sub.max_users, sub.storage_quota_mb, newEnd, orgId]);

    // Expire any older active subscriptions
    await client.query(`
      UPDATE subscriptions
         SET status = 'expired'
       WHERE organization_id = $1 AND aa <> $2 AND status = 'active'
    `, [orgId, sub.aa]);

    await client.query('COMMIT');
    console.log(`[activate] ✓ org=${orgId} plan=${sub.plan_code} ` +
                `ends=${newEnd.toISOString().slice(0,10)} order=${order_code} (${source})`);
    return { activated: true, organization_id: orgId, period_end: newEnd };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
