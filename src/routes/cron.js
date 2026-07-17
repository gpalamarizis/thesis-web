// src/routes/cron.js
// Cron endpoints — καλούνται καθημερινά από Railway cron (ή external scheduler).
// Απαιτούν X-CRON-KEY header για ασφάλεια (env: CRON_SECRET).
//
// POST /api/cron/trial-reminders    → sends emails 7 και 3 μέρες πριν το trial λήξει
// POST /api/cron/execute-deletions  → εκτελεί pending GDPR deletions που έχουν φτάσει scheduled_at
// POST /api/cron/expire-subscriptions → κλείνει subscriptions που λήγουν

const express = require('express');
const { pool } = require('../db');
const email = require('../services/email');

const router = express.Router();

// Auth middleware για cron
router.use((req, res, next) => {
  const key = req.headers['x-cron-key'];
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  if (key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Invalid cron key' });
  }
  next();
});

// ==================== TRIAL REMINDERS ====================
router.post('/trial-reminders', async (req, res) => {
  try {
    // Users whose trial ends in 7 days (owner of org)
    const r = await pool.query(`
      SELECT u.email, u.first_name, o.name AS org_name,
             DATE_PART('day', o.trial_ends_at - NOW())::int AS days_left
        FROM organizations o
        JOIN users u ON u.organization_id = o.id AND u.role IN ('admin', 'owner') AND u.is_active = TRUE
       WHERE o.subscription_status = 'trial'
         AND o.trial_ends_at IS NOT NULL
         AND (
           DATE_PART('day', o.trial_ends_at - NOW())::int = 7 OR
           DATE_PART('day', o.trial_ends_at - NOW())::int = 3 OR
           DATE_PART('day', o.trial_ends_at - NOW())::int = 1
         )
    `);
    const sent = [];
    const failed = [];
    for (const row of r.rows) {
      try {
        await email.sendTrialEnding({ to: row.email, firstName: row.first_name, daysLeft: row.days_left });
        sent.push({ email: row.email, days_left: row.days_left });
      } catch (e) {
        failed.push({ email: row.email, error: e.message });
      }
    }
    res.json({ sent: sent.length, failed: failed.length, details: { sent, failed } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EXECUTE PENDING DELETIONS ====================
router.post('/execute-deletions', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM gdpr_deletion_requests
       WHERE status = 'pending' AND scheduled_at <= NOW()
    `);
    const executed = [];
    for (const req of r.rows) {
      try {
        // Hard delete of organization cascades to all related data
        await pool.query(`DELETE FROM organizations WHERE id = $1`, [req.organization_id]);
        await pool.query(`
          UPDATE gdpr_deletion_requests SET status = 'executed', executed_at = NOW() WHERE aa = $1
        `, [req.aa]);
        executed.push(req.organization_id);
      } catch (e) {
        console.error(`[cron delete] failed for org ${req.organization_id}:`, e.message);
      }
    }
    res.json({ executed: executed.length, organization_ids: executed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EXPIRE SUBSCRIPTIONS ====================
router.post('/expire-subscriptions', async (req, res) => {
  try {
    // Trial expired → set to 'expired'
    const trialR = await pool.query(`
      UPDATE organizations
         SET subscription_status = 'expired'
       WHERE subscription_status = 'trial'
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < NOW()
       RETURNING id, name
    `);

    // Paid subscription expired
    const paidR = await pool.query(`
      UPDATE organizations
         SET subscription_status = 'expired'
       WHERE subscription_status = 'active'
         AND subscription_ends_at IS NOT NULL
         AND subscription_ends_at < NOW()
       RETURNING id, name
    `);

    // Mark active subs as expired too
    await pool.query(`
      UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND period_end < NOW()
    `);

    res.json({
      trials_expired: trialR.rows.length,
      subscriptions_expired: paidR.rows.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
