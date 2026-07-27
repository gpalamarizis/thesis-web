// Add to your existing cron routes file (or create src/routes/cron-subscriptions.js)
// Mount example: app.use('/api/cron', cronRouter);
//
// Schedule this at cron-job.org to run DAILY at 09:00 UTC:
//   URL: https://api.thesislegal.gr/api/cron/subscription-reminders
//   Method: POST
//   Header: X-Cron-Secret: <your CRON_SECRET env var value>

import express from 'express';
import { pool } from '../db.js';
import { sendEmail } from '../services/email.js';  // adjust import to your existing email service

const router = express.Router();

// Trigger reminders for orgs whose subscription expires in 30/15/7/1 days
router.post('/subscription-reminders', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Find orgs at reminder milestones
    const { rows: orgs } = await pool.query(`
      SELECT
        o.id, o.name, o.subscription_ends_at, o.billing_email,
        (o.subscription_ends_at::date - CURRENT_DATE) AS days_left
      FROM organizations o
      WHERE o.subscription_status = 'active'
        AND o.suspended = false
        AND o.subscription_ends_at IS NOT NULL
        AND (o.subscription_ends_at::date - CURRENT_DATE) IN (30, 15, 7, 3, 1, 0, -1, -7)
      ORDER BY o.id
    `);

    const results = [];
    for (const org of orgs) {
      const to = org.billing_email;
      if (!to) {
        // Fallback: send to org admin's email
        const { rows: [admin] } = await pool.query(
          `SELECT email FROM users WHERE organization_id = $1 AND role = 'admin' AND is_active = true ORDER BY id LIMIT 1`,
          [org.id]
        );
        if (!admin) {
          results.push({ org_id: org.id, sent: false, reason: 'no billing_email or admin' });
          continue;
        }
        org.billing_email = admin.email;
      }

      const daysLeft = org.days_left;
      let subject, body;

      if (daysLeft > 0) {
        subject = `Η συνδρομή σας στο Thesis λήγει σε ${daysLeft} ημέρες`;
        body = `
Αγαπητοί συνεργάτες του ${org.name},

Σας ενημερώνουμε ότι η ετήσια συνδρομή σας στο σύστημα Thesis λήγει σε ${daysLeft} ημέρες,
στις ${new Date(org.subscription_ends_at).toLocaleDateString('el-GR')}.

Για να συνεχίσετε αδιάκοπα τη χρήση:
- Ανανέωση online: https://app.thesislegal.gr/subscription/renew
- Πληρωμή στην τράπεζα (θα λάβετε στοιχεία με τιμολόγιο)

Για οποιαδήποτε ερώτηση επικοινωνήστε στο info@obangroup.gr

Με εκτίμηση,
OB.AN IKE - Thesis
        `.trim();
      } else if (daysLeft === 0) {
        subject = `Η συνδρομή σας στο Thesis λήγει σήμερα`;
        body = `Αγαπητοί συνεργάτες του ${org.name},\n\nΗ ετήσια συνδρομή σας λήγει σήμερα. Παρακαλούμε ανανεώστε άμεσα.\n\nOB.AN IKE - Thesis`;
      } else {
        subject = `Ληγμένη συνδρομή Thesis - Αμεση ανανέωση απαιτείται`;
        body = `Η συνδρομή σας έχει λήξει εδώ και ${Math.abs(daysLeft)} ημέρες. Η πρόσβαση θα ανασταλεί σύντομα.`;
      }

      try {
        await sendEmail({ to: org.billing_email, subject, text: body });
        results.push({ org_id: org.id, sent: true, days_left: daysLeft });
      } catch (err) {
        results.push({ org_id: org.id, sent: false, error: err.message });
      }
    }

    res.json({ processed: orgs.length, results });
  } catch (err) {
    console.error('[cron subscription-reminders]', err);
    res.status(500).json({ error: err.message });
  }
});

// Auto-suspend expired subscriptions (grace period 7 days)
router.post('/subscription-suspend-expired', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await pool.query(`
      UPDATE organizations
      SET suspended = true,
          suspended_reason = 'Subscription expired > 7 days',
          subscription_status = 'suspended'
      WHERE subscription_status = 'active'
        AND suspended = false
        AND subscription_ends_at IS NOT NULL
        AND (subscription_ends_at::date - CURRENT_DATE) < -7
      RETURNING id, name, subscription_ends_at
    `);
    res.json({ suspended: rows.length, orgs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
