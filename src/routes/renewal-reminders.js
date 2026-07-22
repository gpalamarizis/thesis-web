// src/routes/renewal-reminders.js
// Cron endpoint that sends subscription renewal reminder emails.
//
// Endpoints:
//   GET/POST /api/cron/renewal-reminders
//     Header: Authorization: Bearer <CRON_SECRET>
//     Query:
//       ?days=30,7,0    (optional, default: '30,7,0')
//       ?dry_run=1      (optional, don't send, just report what would happen)
//
// Runs daily via cron-job.org. For each org whose subscription_ends_at
// falls exactly N days from today (in Europe/Athens tz), sends an email
// to the org's admin (role='admin' AND is_active), fallback to billing_email.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const MAIL_FROM = process.env.MAIL_FROM || 'gpal@oban.gr';

function authorize(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '');
  if (!provided || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '/' + mm + '/' + yyyy;
}

function urgencyPhrase(daysLeft) {
  if (daysLeft === 0) return 'σήμερα';
  if (daysLeft === 1) return 'αύριο';
  if (daysLeft <= 7) return 'σε ' + daysLeft + ' ημέρες';
  return 'σε ' + daysLeft + ' ημέρες';
}

function accentColor(daysLeft) {
  if (daysLeft === 0) return '#e53e3e'; // red
  if (daysLeft <= 7) return '#dd6b20';  // orange
  return '#3182ce';                     // blue
}

function buildReminderHtml(name, orgName, daysLeft, endsAt) {
  const dateStr = formatDate(new Date(endsAt));
  const urgency = urgencyPhrase(daysLeft);
  const color = accentColor(daysLeft);
  const year = new Date().getFullYear();

  return '<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Υπενθύμιση ανανέωσης</title></head>' +
    '<body style="margin:0;padding:0;background:#f7fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#2d3748;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7fafc;padding:40px 20px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden;">' +
    '<tr><td style="padding:32px 40px 24px;border-bottom:1px solid #edf2f7;">' +
    '<div style="font-size:24px;font-weight:700;color:#2b6cb0;">Thesis</div>' +
    '<div style="font-size:13px;color:#718096;margin-top:4px;">Νομικό λογισμικό δικηγορικών γραφείων</div>' +
    '</td></tr>' +
    '<tr><td style="padding:32px 40px;">' +
    '<h1 style="margin:0 0 16px;font-size:20px;color:' + color + ';">Υπενθύμιση ανανέωσης συνδρομής</h1>' +
    '<p style="margin:0 0 16px;line-height:1.6;">Γεια σας ' + escapeHtml(name) + ',</p>' +
    '<p style="margin:0 0 16px;line-height:1.6;">Η συνδρομή του γραφείου <strong>' + escapeHtml(orgName) + '</strong> λήγει <strong>' + urgency + '</strong> (' + dateStr + ').</p>' +
    '<p style="margin:0 0 16px;line-height:1.6;">Για να συνεχίσετε να έχετε πρόσβαση στην πλατφόρμα χωρίς διακοπή, επικοινωνήστε μαζί μας για ανανέωση.</p>' +
    '<p style="margin:0 0 8px;line-height:1.6;font-size:13px;color:#718096;">Αν έχετε ήδη ανανεώσει, αγνοήστε αυτό το μήνυμα.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:20px 40px;background:#f7fafc;border-top:1px solid #edf2f7;font-size:12px;color:#a0aec0;text-align:center;">' +
    '© ' + year + ' Thesis. Αυτοματοποιημένο μήνυμα.' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildReminderText(name, orgName, daysLeft, endsAt) {
  const dateStr = formatDate(new Date(endsAt));
  const urgency = urgencyPhrase(daysLeft);
  return 'Γεια σας ' + name + ',\n\n' +
    'Η συνδρομή του γραφείου ' + orgName + ' λήγει ' + urgency + ' (' + dateStr + ').\n\n' +
    'Για να συνεχίσετε να έχετε πρόσβαση στην πλατφόρμα χωρίς διακοπή, επικοινωνήστε μαζί μας για ανανέωση.\n\n' +
    'Αν έχετε ήδη ανανεώσει, αγνοήστε αυτό το μήνυμα.\n\n—\nThesis';
}

async function sendReminderEmail(toEmail, toName, orgName, daysLeft, endsAt) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY not configured');

  const subject = daysLeft === 0
    ? 'Λήξη συνδρομής σήμερα - ' + orgName
    : 'Υπενθύμιση ανανέωσης συνδρομής (' + daysLeft + ' ημέρες) - ' + orgName;

  const body = {
    personalizations: [{ to: [{ email: toEmail, name: toName || undefined }] }],
    from: { email: MAIL_FROM, name: 'Thesis' },
    subject,
    content: [
      { type: 'text/plain', value: buildReminderText(toName || 'χρήστη', orgName, daysLeft, endsAt) },
      { type: 'text/html',  value: buildReminderHtml(toName || 'χρήστη', orgName, daysLeft, endsAt) },
    ],
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('SendGrid ' + res.status + ': ' + errBody);
  }
}

async function handleRenewalReminders(req, res) {
  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
  const daysParam = req.query.days || '30,7,0';
  const daysList = daysParam.split(',')
    .map(s => parseInt(String(s).trim(), 10))
    .filter(n => !isNaN(n) && n >= 0 && n <= 365);

  if (daysList.length === 0) {
    return res.status(400).json({ error: 'Invalid days parameter' });
  }

  const results = { checked_days: daysList, dry_run: dryRun, reminders: [] };

  try {
    for (const days of daysList) {
      const orgsQ = await pool.query(
        "SELECT o.id, o.name, o.billing_email, o.subscription_ends_at " +
        "  FROM organizations o " +
        " WHERE o.suspended = FALSE " +
        "   AND o.subscription_ends_at IS NOT NULL " +
        "   AND DATE(o.subscription_ends_at AT TIME ZONE 'Europe/Athens') = " +
        "       DATE(NOW() AT TIME ZONE 'Europe/Athens') + $1::int",
        [days]
      );

      for (const org of orgsQ.rows) {
        const adminQ = await pool.query(
          "SELECT email, first_name, last_name " +
          "  FROM users " +
          " WHERE organization_id = $1 AND role = 'admin' AND is_active = TRUE " +
          " ORDER BY id ASC LIMIT 1",
          [org.id]
        );

        let toEmail, toName;
        if (adminQ.rows.length > 0) {
          toEmail = adminQ.rows[0].email;
          toName = [adminQ.rows[0].first_name, adminQ.rows[0].last_name].filter(Boolean).join(' ');
        } else if (org.billing_email) {
          toEmail = org.billing_email;
          toName = '';
        } else {
          results.reminders.push({ org_id: org.id, org_name: org.name, days_left: days, status: 'skipped_no_recipient' });
          continue;
        }

        if (dryRun) {
          results.reminders.push({ org_id: org.id, org_name: org.name, to: toEmail, days_left: days, status: 'would_send' });
        } else {
          try {
            await sendReminderEmail(toEmail, toName, org.name, days, org.subscription_ends_at);
            results.reminders.push({ org_id: org.id, org_name: org.name, to: toEmail, days_left: days, status: 'sent' });
          } catch (emailErr) {
            console.error('[renewal-reminders] send failed for org ' + org.id + ':', emailErr.message);
            results.reminders.push({ org_id: org.id, org_name: org.name, to: toEmail, days_left: days, status: 'send_failed', error: emailErr.message });
          }
        }
      }
    }

    console.log('[renewal-reminders] processed', results.reminders.length, 'reminders, dry_run=' + dryRun);
    res.json(results);
  } catch (err) {
    console.error('[renewal-reminders] error:', err);
    res.status(500).json({ error: err.message });
  }
}

router.get('/renewal-reminders', authorize, handleRenewalReminders);
router.post('/renewal-reminders', authorize, handleRenewalReminders);

module.exports = router;
