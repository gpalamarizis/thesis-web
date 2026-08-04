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

// Email service — αμυντικά, ώστε αν λείπει να μη σκάει όλο το route
let emailSvc = null;
try { emailSvc = require('../services/email'); } catch (_) { /* χωρίς email */ }
async function tryEmail(fn, args) {
  if (!emailSvc || typeof emailSvc[fn] !== 'function') return false;
  try { await emailSvc[fn](args); return true; }
  catch (e) { console.error(`[email ${fn}]`, e.message); return false; }
}

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

    -- Πληρωμή με τραπεζικό έμβασμα
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(40);
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS bank_matched_by   VARCHAR(20);
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS bank_tx_id        VARCHAR(80);
    CREATE INDEX IF NOT EXISTS idx_subs_payref ON subscriptions(payment_reference);

    -- Ημερολόγιο ΟΛΩΝ των εισερχομένων στον λογαριασμό Viva.
    -- Κρατάμε και όσα ΔΕΝ ταιριάξαμε, ώστε να μη χαθεί ποτέ κατάθεση.
    CREATE TABLE IF NOT EXISTS bank_incoming (
      aa             BIGSERIAL PRIMARY KEY,
      wallet_tx_id   VARCHAR(80) UNIQUE,
      amount         NUMERIC(12,2),
      currency       VARCHAR(5),
      description    TEXT,
      matched_sub_id BIGINT,
      status         VARCHAR(20) DEFAULT 'unmatched',
      raw            JSONB,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bank_incoming_status ON bank_incoming(status, created_at DESC);
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
      // Χρήσιμο όταν ο λογαριασμός Viva είναι κοινός με άλλο προϊόν:
      // το webhook θα δέχεται ΜΟΝΟ πληρωμές αυτού του source.
      payment_source: process.env.VIVA_SOURCE_CODE || '(ΔΕΝ ΕΧΕΙ ΟΡΙΣΤΕΙ)',
      urls: cfg.urls,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================ ΥΠΟΛΟΓΙΣΜΟΣ ΤΙΜΗΣ ================
/**
 * Τιμολόγηση ΑΝΑ ΧΡΗΣΤΗ, με ΦΠΑ πάνω από την τιμή.
 *   3 χρήστες × 180 € = 540 € καθαρά + 24% ΦΠΑ = 669,60 €
 *
 * Επιστρέφει { users, perUser, net, vat, gross, vatRate }
 * ή { error } αν ο αριθμός χρηστών δεν επιτρέπεται.
 */
function ypologismos(plan, requestedUsers) {
  const perUser = Number(plan.price_per_user_year ?? plan.price_year);
  if (!Number.isFinite(perUser) || perUser <= 0) {
    return { error: 'Το πλάνο δεν έχει έγκυρη τιμή' };
  }

  const min = Number(plan.min_users || 1);
  const max = Number(plan.max_users_allowed || plan.max_users || min);
  const users = parseInt(requestedUsers, 10) || min;

  if (users < min) {
    return { error: `Το πλάνο ${plan.name} ξεκινά από ${min} ${min === 1 ? 'χρήστη' : 'χρήστες'}` };
  }
  if (users > max) {
    return { error: `Το πλάνο ${plan.name} καλύπτει έως ${max} χρήστες. Επικοινωνήστε μαζί μας για περισσότερους.` };
  }

  const vatRate = Number(plan.vat_rate ?? 24);
  const net = Math.round(perUser * users * 100) / 100;
  const vat = Math.round(net * vatRate) / 100;
  const gross = Math.round((net + vat) * 100) / 100;

  return { users, perUser, net, vat, gross, vatRate };
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
  const { plan_code, users } = req.body || {};
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

    // Υπολογισμός με βάση τον αριθμό χρηστών + ΦΠΑ
    const calc = ypologismos(plan, users);
    if (calc.error) return res.status(400).json({ error: calc.error });

    // Δεν επιτρέπουμε λιγότερους χρήστες από όσους έχει ήδη ενεργούς
    const activeUsers = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE organization_id = $1 AND is_active = TRUE`,
      [orgId])).rows[0].c;
    if (calc.users < activeUsers) {
      return res.status(400).json({
        error: `Έχετε ${activeUsers} ενεργούς χρήστες. Δεν μπορείτε να αγοράσετε άδειες για λιγότερους.`,
      });
    }

    const oR = await pool.query(`SELECT id, name, billing_email, referred_by_partner_id FROM organizations WHERE id = $1`, [orgId]);
    const org = oR.rows[0];
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Internal orderId (unique reference)
    const orderId = `THESIS-${orgId}-${plan.code}-${Date.now()}`;

    const { orderCode } = await viva.createPaymentOrder({
      amount: calc.gross,                     // ΜΕ ΦΠΑ — αυτό χρεώνεται
      customerEmail: org.billing_email || u.email,
      customerName: `${u.first_name || ''} ${u.last_name || ''}`.trim() || org.name,
      orderId,
      description: `${plan.name} ${calc.users} ${calc.users === 1 ? 'χρήστης' : 'χρήστες'} — ${org.name}`,
    });

    // Store a pending subscription (status='pending') που θα γίνει 'active' μετά το webhook
    await pool.query(`
      INSERT INTO subscriptions (organization_id, plan_code, plan_type, max_users, storage_quota_mb,
                                 amount_gross, amount_net, vat_amount, users_purchased,
                                 currency, period_start, period_end,
                                 status, viva_order_code, partner_id, commission_rate, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), NOW() + INTERVAL '1 year',
              'pending', $11, $12, NULL, $13)
    `, [
      orgId, plan.code, plan.plan_type, calc.users, plan.storage_quota_mb,
      calc.gross, calc.net, calc.vat, calc.users,
      plan.currency || 'EUR',
      String(orderCode), org.referred_by_partner_id,
      `orderId: ${orderId} | ${calc.users} χρήστες × ${calc.perUser}€ = ${calc.net}€ + ΦΠΑ ${calc.vat}€`
    ]);

    res.json({
      order_code: orderCode,
      checkout_url: viva.getCheckoutUrl(orderCode),
      plan_name: plan.name,
      users: calc.users,
      price_per_user: calc.perUser,
      amount_net: calc.net,
      vat_rate: calc.vatRate,
      vat_amount: calc.vat,
      amount: calc.gross,          // αυτό χρεώνεται
    });
  } catch (err) {
    console.error('[subscriptions/checkout]', err);
    res.status(500).json({ error: err.message });
  }
});

// ================ ΠΛΗΡΩΜΗ ΜΕ ΤΡΑΠΕΖΙΚΟ ΕΜΒΑΣΜΑ ================
// Ο πελάτης δηλώνει ότι θα πληρώσει με έμβασμα.
// Παίρνει IBAN + ΜΟΝΑΔΙΚΗ αιτιολογία που πρέπει να γράψει στην κατάθεση.
// Όταν φτάσουν τα χρήματα, το webhook 2054 της Viva το πιάνει και
// ενεργοποιεί αυτόματα (ή σε ειδοποιεί για χειροκίνητο έλεγχο).

function makeReference(orgId) {
  // Χωρίς 0/O/1/I για να μη μπερδεύεται ο πελάτης όταν το γράφει
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 4; i++) r += A[Math.floor(Math.random() * A.length)];
  return `THESIS-${orgId}-${r}`;
}

router.post('/subscriptions/bank-transfer', requireAuth, async (req, res) => {
  await ensureSchema();
  const orgId = req.user.organization_id;
  const { plan_code, users } = req.body || {};
  if (!plan_code) return res.status(400).json({ error: 'plan_code required' });

  try {
    const uR = await pool.query(
      `SELECT role, email, first_name, last_name FROM users WHERE id = $1`,
      [req.user.id]);
    const u = uR.rows[0];
    if (!u || (u.role !== 'admin' && u.role !== 'owner')) {
      return res.status(403).json({ error: 'Μόνο ο υπεύθυνος του γραφείου μπορεί να αγοράσει' });
    }

    const pR = await pool.query(
      `SELECT * FROM subscription_plans WHERE code = $1 AND active = TRUE`, [plan_code]);
    if (pR.rows.length === 0) return res.status(404).json({ error: 'Το πλάνο δεν βρέθηκε' });
    const plan = pR.rows[0];

    const oR = await pool.query(
      `SELECT id, name, billing_email, referred_by_partner_id FROM organizations WHERE id = $1`, [orgId]);
    const org = oR.rows[0];
    if (!org) return res.status(404).json({ error: 'Το γραφείο δεν βρέθηκε' });

    const calc = ypologismos(plan, users);
    if (calc.error) return res.status(400).json({ error: calc.error });

    const activeUsers = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE organization_id = $1 AND is_active = TRUE`,
      [orgId])).rows[0].c;
    if (calc.users < activeUsers) {
      return res.status(400).json({
        error: `Έχετε ${activeUsers} ενεργούς χρήστες. Δεν μπορείτε να αγοράσετε άδειες για λιγότερους.`,
      });
    }

    const amount = calc.gross;   // ΜΕ ΦΠΑ
    const reference = makeReference(orgId);

    await pool.query(`
      INSERT INTO subscriptions (organization_id, plan_code, plan_type, max_users, storage_quota_mb,
                                 amount_gross, amount_net, vat_amount, users_purchased,
                                 currency, period_start, period_end,
                                 status, payment_method, payment_reference, partner_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), NOW() + INTERVAL '1 year',
              'pending', 'bank_transfer', $11, $12, $13)
    `, [orgId, plan.code, plan.plan_type, calc.users, plan.storage_quota_mb,
        calc.gross, calc.net, calc.vat, calc.users,
        plan.currency || 'EUR', reference, org.referred_by_partner_id,
        `Αναμονή εμβάσματος ${reference} — ${calc.users} χρήστες × ${calc.perUser}€ + ΦΠΑ`]);

    const iban = process.env.BANK_IBAN || '';
    const beneficiary = process.env.BANK_BENEFICIARY || 'OB.AN IKE';
    const bankName = process.env.BANK_NAME || '';

    // Ειδοποίηση στον πελάτη
    const to = org.billing_email || u.email;
    if (to && emailSvc) {
      await tryEmail('send', {
        to,
        subject: `Στοιχεία πληρωμής συνδρομής Thesis — ${reference}`,
        html: `
          <p>Γεια σας${u.first_name ? ' ' + u.first_name : ''},</p>
          <p>Για την ενεργοποίηση της συνδρομής <strong>${plan.name}</strong>
             παρακαλούμε καταθέστε το ποσό στον παρακάτω λογαριασμό:</p>
          <table cellpadding="6" style="border-collapse:collapse">
            <tr><td><strong>Δικαιούχος</strong></td><td>${beneficiary}</td></tr>
            ${bankName ? `<tr><td><strong>Τράπεζα</strong></td><td>${bankName}</td></tr>` : ''}
            <tr><td><strong>IBAN</strong></td><td><code>${iban}</code></td></tr>
            <tr><td><strong>Πλάνο</strong></td><td>${plan.name} — ${calc.users} ${calc.users === 1 ? 'χρήστης' : 'χρήστες'}</td></tr>
            <tr><td>Καθαρή αξία</td><td>${calc.net.toFixed(2)} EUR (${calc.users} × ${calc.perUser.toFixed(2)} EUR)</td></tr>
            <tr><td>ΦΠΑ ${calc.vatRate}%</td><td>${calc.vat.toFixed(2)} EUR</td></tr>
            <tr><td><strong>Πληρωτέο ποσό</strong></td><td><strong style="font-size:17px">${calc.gross.toFixed(2)} EUR</strong></td></tr>
            <tr><td><strong>Αιτιολογία</strong></td>
                <td><strong style="font-size:18px">${reference}</strong></td></tr>
          </table>
          <p style="background:#FEF3C7;padding:12px;border-radius:6px">
            <strong>Σημαντικό:</strong> γράψτε την αιτιολογία
            <strong>${reference}</strong> στην κατάθεση, ώστε να ενεργοποιηθεί
            αυτόματα η συνδρομή σας.
          </p>
          <p>Μόλις εμφανιστούν τα χρήματα, η συνδρομή ενεργοποιείται και θα λάβετε επιβεβαίωση.</p>
        `,
      });
    }

    // Ειδοποίηση σε εσένα
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await tryEmail('send', {
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `[Thesis] Αναμονή εμβάσματος — ${org.name}`,
        html: `<p><strong>${org.name}</strong> επέλεξε πληρωμή με έμβασμα.</p>
               <p>Πλάνο: ${plan.name}<br>Ποσό: ${amount.toFixed(2)} EUR<br>
                  Αιτιολογία: <strong>${reference}</strong></p>`,
      });
    }

    res.json({
      payment_method: 'bank_transfer',
      reference,
      plan_name: plan.name,
      users: calc.users,
      price_per_user: calc.perUser,
      amount_net: calc.net,
      vat_rate: calc.vatRate,
      vat_amount: calc.vat,
      amount: calc.gross,
      iban,
      beneficiary,
      bank_name: bankName,
      message: 'Σας στείλαμε email με τα στοιχεία πληρωμής.',
    });
  } catch (err) {
    console.error('[subscriptions/bank-transfer]', err);
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

// ============ PLATFORM ADMIN: εκκρεμείς & αταίριαστες καταθέσεις ============

// Τι περιμένει πληρωμή
router.get('/subscriptions/pending', requireAuth, async (req, res) => {
  if (!req.user.is_platform_admin) return res.status(403).json({ error: 'platform admin only' });
  await ensureSchema();
  try {
    const r = await pool.query(`
      SELECT s.aa, s.organization_id, o.name AS org_name, s.plan_code,
             s.amount_gross, s.payment_method, s.payment_reference,
             s.created_at
        FROM subscriptions s
        LEFT JOIN organizations o ON o.id = s.organization_id
       WHERE s.status = 'pending'
       ORDER BY s.created_at DESC LIMIT 2000`);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Καταθέσεις που ΔΕΝ ταίριαξαν αυτόματα
router.get('/subscriptions/unmatched-transfers', requireAuth, async (req, res) => {
  if (!req.user.is_platform_admin) return res.status(403).json({ error: 'platform admin only' });
  await ensureSchema();
  try {
    const r = await pool.query(`
      SELECT aa, wallet_tx_id, amount, currency, description, status, created_at
        FROM bank_incoming
       WHERE status IN ('unmatched', 'amount_mismatch')
       ORDER BY created_at DESC LIMIT 2000`);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Χειροκίνητη ενεργοποίηση — όταν η κατάθεση ήρθε χωρίς σωστή αιτιολογία
router.post('/subscriptions/:id/activate-manual', requireAuth, async (req, res) => {
  if (!req.user.is_platform_admin) return res.status(403).json({ error: 'platform admin only' });
  await ensureSchema();
  const subId = parseInt(req.params.id, 10);
  const { bank_incoming_id, note } = req.body || {};
  try {
    const result = await activateSubscription({
      order_code: null,
      subscription_id: subId,
      transaction_id: `MANUAL-${req.user.id}-${Date.now()}`,
      reported_amount: null,
      source: `χειροκίνητα από ${req.user.email || req.user.id}${note ? ' — ' + note : ''}`,
    });
    if (bank_incoming_id) {
      await pool.query(
        `UPDATE bank_incoming SET status = 'matched', matched_sub_id = $1 WHERE aa = $2`,
        [subId, bank_incoming_id]);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[activate-manual]', err);
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

    // 2054 = Account Transaction Created — ΕΙΣΕΡΧΟΜΕΝΟ ΣΤΟΝ ΛΟΓΑΡΙΑΣΜΟ
    // Εδώ πιάνουμε τα τραπεζικά εμβάσματα.
    if (eventType === 2054) {
      return handleAccountTransaction(evt, res);
    }

    // 1796 = Transaction Payment Created (επιτυχής πληρωμή με κάρτα/IRIS)
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

    // ΦΙΛΤΡΟ PAYMENT SOURCE
    // Ο λογαριασμός Viva είναι ΚΟΙΝΟΣ με το GlobiPet (ίδια εταιρεία).
    // Τα webhooks καταχωρούνται ανά ΛΟΓΑΡΙΑΣΜΟ, όχι ανά source — άρα εδώ
    // φτάνουν ΚΑΙ οι πληρωμές του GlobiPet. Τις αγνοούμε ρητά.
    const mySource = String(process.env.VIVA_SOURCE_CODE || '').trim();
    const evtSource = String(evt.SourceCode || '').trim();
    if (mySource && evtSource && evtSource !== mySource) {
      console.log(`[viva webhook] Αγνοείται — source ${evtSource} (Thesis = ${mySource})`);
      return res.json({ ok: true, ignored: `other payment source ${evtSource}` });
    }
    if (!mySource) {
      console.warn('[viva webhook] ΠΡΟΣΟΧΗ: λείπει VIVA_SOURCE_CODE — δεν γίνεται φιλτράρισμα source');
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

// ================ ΕΙΣΕΡΧΟΜΕΝΑ ΤΡΑΠΕΖΙΚΑ (webhook 2054) ================

/**
 * Το Viva στέλνει EventTypeId 2054 για ΚΑΘΕ κίνηση στον λογαριασμό.
 * Μας ενδιαφέρουν μόνο τα ΕΙΣΕΡΧΟΜΕΝΑ (Amount > 0).
 *
 * Ψάχνουμε στο Description την αιτιολογία μας (THESIS-<org>-<4 chars>).
 * Αν βρεθεί ΚΑΙ το ποσό ταιριάζει -> αυτόματη ενεργοποίηση.
 * Αλλιώς -> καταγράφεται ως 'unmatched' και ειδοποιείσαι για χειροκίνητο έλεγχο.
 *
 * ΤΙΠΟΤΑ ΔΕΝ ΧΑΝΕΤΑΙ: κάθε εισερχόμενο μπαίνει στον πίνακα bank_incoming.
 */
async function handleAccountTransaction(evt, res) {
  const amount = Number(evt.Amount || 0);
  const txId = String(evt.WalletTransactionId || '');
  const desc = String(evt.Description || '');

  // Μόνο εισερχόμενα, ολοκληρωμένα
  if (amount <= 0) return res.json({ ok: true, ignored: 'εξερχόμενο' });
  if (evt.StatusId && evt.StatusId !== 'F') {
    return res.json({ ok: true, ignored: `StatusId ${evt.StatusId}` });
  }
  if (!txId) return res.json({ ok: true, ignored: 'χωρίς WalletTransactionId' });

  // Καταγραφή (idempotent — ίδιο txId δεν ξαναμπαίνει)
  const ins = await pool.query(`
    INSERT INTO bank_incoming (wallet_tx_id, amount, currency, description, raw)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (wallet_tx_id) DO NOTHING
    RETURNING aa`,
    [txId, amount, evt.CurrencyCode === '978' ? 'EUR' : String(evt.CurrencyCode || ''),
     desc, JSON.stringify(evt)]);

  if (ins.rowCount === 0) {
    return res.json({ ok: true, ignored: 'ήδη καταγεγραμμένο' });
  }

  // Αναζήτηση αιτιολογίας: THESIS-<ψηφία>-<4 χαρακτήρες>
  // Κανονικοποίηση: κεφαλαία, χωρίς κενά/παύλες (οι τράπεζες τα αλλοιώνουν)
  const norm = desc.toUpperCase().replace(/[\s\-_.]/g, '');
  const m = norm.match(/THESIS(\d+)([A-Z0-9]{4})/);

  let matched = null;
  if (m) {
    const ref = `THESIS-${m[1]}-${m[2]}`;
    const r = await pool.query(
      `SELECT * FROM subscriptions
        WHERE payment_reference = $1 AND status = 'pending'
        LIMIT 1`, [ref]);
    if (r.rows.length) matched = r.rows[0];
  }

  // Εφεδρικά: μοναδικό pending με ΑΚΡΙΒΩΣ αυτό το ποσό τις τελευταίες 60 ημέρες
  if (!matched) {
    const r = await pool.query(`
      SELECT * FROM subscriptions
       WHERE status = 'pending' AND payment_method = 'bank_transfer'
         AND created_at > NOW() - INTERVAL '60 days'
         AND ABS(amount_gross - $1) < 0.01`, [amount]);
    if (r.rows.length === 1) matched = r.rows[0];
  }

  if (!matched) {
    console.warn(`[bank] ΑΤΑΙΡΙΑΣΤΗ ΚΑΤΑΘΕΣΗ ${amount} EUR — "${desc}"`);
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await tryEmail('send', {
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `[Thesis] Κατάθεση ${amount.toFixed(2)} EUR χωρίς αντιστοίχιση`,
        html: `<p>Ήρθε κατάθεση που ΔΕΝ ταίριαξε αυτόματα.</p>
               <p>Ποσό: <strong>${amount.toFixed(2)} EUR</strong><br>
                  Αιτιολογία: <em>${desc || '(κενή)'}</em></p>
               <p>Δες τις εκκρεμείς στο Platform Admin και ενεργοποίησε χειροκίνητα.</p>`,
      });
    }
    return res.json({ ok: true, matched: false });
  }

  // Έλεγχος ποσού
  const expected = Number(matched.amount_gross);
  if (Math.abs(amount - expected) > 0.01) {
    console.error(`[bank] ΔΙΑΦΟΡΑ ΠΟΣΟΥ ref=${matched.payment_reference}: ` +
                  `αναμενόμενο ${expected}, ήρθε ${amount}`);
    await pool.query(
      `UPDATE bank_incoming SET status = 'amount_mismatch', matched_sub_id = $1
        WHERE wallet_tx_id = $2`, [matched.aa, txId]);
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await tryEmail('send', {
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `[Thesis] Διαφορά ποσού — ${matched.payment_reference}`,
        html: `<p>Αναμενόμενο: <strong>${expected.toFixed(2)} EUR</strong><br>
                  Ήρθε: <strong>${amount.toFixed(2)} EUR</strong></p>
               <p>Αιτιολογία: ${matched.payment_reference}</p>
               <p>Δεν ενεργοποιήθηκε αυτόματα — έλεγξέ το.</p>`,
      });
    }
    return res.json({ ok: true, matched: true, activated: false, reason: 'amount mismatch' });
  }

  // Ενεργοποίηση
  await pool.query(
    `UPDATE subscriptions SET bank_matched_by = $1, bank_tx_id = $2 WHERE aa = $3`,
    [m ? 'reference' : 'amount', txId, matched.aa]);

  const result = await activateSubscription({
    order_code: null,
    subscription_id: matched.aa,
    transaction_id: txId,
    reported_amount: amount,
    source: 'bank_transfer',
  });

  await pool.query(
    `UPDATE bank_incoming SET status = 'matched', matched_sub_id = $1 WHERE wallet_tx_id = $2`,
    [matched.aa, txId]);

  // Ειδοποιήσεις
  const oR = await pool.query(
    `SELECT name, billing_email FROM organizations WHERE id = $1`, [matched.organization_id]);
  const org = oR.rows[0] || {};
  if (org.billing_email) {
    await tryEmail('sendSubscriptionActivated', {
      to: org.billing_email,
      firstName: '',
      planName: matched.plan_code,
      amount,
      periodEnd: result?.period_end,
    });
  }
  if (process.env.ADMIN_NOTIFY_EMAIL) {
    await tryEmail('send', {
      to: process.env.ADMIN_NOTIFY_EMAIL,
      subject: `[Thesis] ✓ Ενεργοποιήθηκε — ${org.name || matched.organization_id}`,
      html: `<p>Κατάθεση <strong>${amount.toFixed(2)} EUR</strong> ταίριαξε
                (${m ? 'με αιτιολογία' : 'με ποσό'}) και η συνδρομή ενεργοποιήθηκε.</p>
             <p>Γραφείο: ${org.name}<br>Πλάνο: ${matched.plan_code}<br>
                Αιτιολογία: ${matched.payment_reference}</p>`,
    });
  }

  console.log(`[bank] ✓ ${amount} EUR -> org=${matched.organization_id} ref=${matched.payment_reference}`);
  return res.json({ ok: true, matched: true, activated: true });
}

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
async function activateSubscription({ order_code, subscription_id, transaction_id, reported_amount, source }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Υπάρχει ο πίνακας partners; (μπορεί να μην έχει δημιουργηθεί ακόμα)
    const hasPartners = (await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_schema='public' AND table_name='partners'`)).rows[0].n > 0;

    // Εντοπισμός είτε με order_code (κάρτα/IRIS) είτε με aa (έμβασμα)
    const byId = subscription_id != null;
    const where = byId ? 's.aa = $1' : 's.viva_order_code = $1';
    const key = byId ? subscription_id : order_code;
    if (key == null) throw new Error('Χρειάζεται order_code ή subscription_id');

    const sql = hasPartners
      ? `SELECT s.*, p.commission_rate AS partner_commission_rate
           FROM subscriptions s
           LEFT JOIN partners p ON p.aa = s.partner_id
          WHERE ${where}
          FOR UPDATE OF s
          LIMIT 1`
      : `SELECT s.*, NULL::numeric AS partner_commission_rate
           FROM subscriptions s
          WHERE ${where}
          FOR UPDATE
          LIMIT 1`;

    const sR = await client.query(sql, [key]);
    if (sR.rows.length === 0) throw new Error(`Δεν βρέθηκε συνδρομή (${byId ? 'aa=' : 'order='}${key})`);
    const sub = sR.rows[0];
    const orgId = sub.organization_id;

    // Ήδη ενεργή -> τίποτα (idempotent, το Viva μπορεί να στείλει 2 φορές)
    if (sub.status === 'active') {
      await client.query('COMMIT');
      console.log(`[activate] ${byId ? 'aa='+subscription_id : 'order='+order_code} ήδη ενεργή (${source})`);
      return { alreadyActive: true, organization_id: orgId };
    }

    // ΕΛΕΓΧΟΣ ΠΟΣΟΥ — δεν μπλοκάρει, αλλά καταγράφεται έντονα ώστε να το δεις.
    const expected = Number(sub.amount_gross);
    if (reported_amount != null && Number.isFinite(expected)) {
      const diff = Math.abs(reported_amount - expected);
      if (diff > 0.01) {
        console.error(
          `[activate] ΔΙΑΦΟΡΑ ΠΟΣΟΥ ${byId ? 'aa='+subscription_id : 'order='+order_code}: ` +
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
                `ends=${newEnd.toISOString().slice(0,10)} (${source})`);
    return { activated: true, organization_id: orgId, period_end: newEnd };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
