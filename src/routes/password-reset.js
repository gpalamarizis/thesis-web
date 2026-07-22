// src/routes/password-reset.js
// Password reset flow (forgot password / reset password)
//
// Endpoints:
//   POST /api/auth/forgot-password        { email }              -> 200 always (no user enumeration)
//   GET  /api/auth/reset-password/:token                          -> 200 { valid: true|false }
//   POST /api/auth/reset-password         { token, new_password } -> 200 { ok: true }
//
// Token: 64 hex chars (crypto.randomBytes(32)), TTL 60 minutes.
// Email: SendGrid HTTPS API (same pattern as email.js).
//
// Env vars required:
//   SENDGRID_API_KEY   - already set
//   MAIL_FROM          - defaults to 'gpal@oban.gr'
//   FRONTEND_URL       - defaults to 'https://thesis-frontend.gpal.workers.dev'

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db'); // adjust path if different

const router = express.Router();

const TOKEN_TTL_MINUTES = 60;
const MAIL_FROM = process.env.MAIL_FROM || 'gpal@oban.gr';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://thesis-frontend.gpal.workers.dev').replace(/\/$/, '');

// ---------- Helpers ----------

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 chars
}

async function sendResetEmail(toEmail, toName, resetUrl) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY not configured');

  const html = buildResetEmailHtml(toName || 'χρήστη', resetUrl);
  const text = buildResetEmailText(toName || 'χρήστη', resetUrl);

  const body = {
    personalizations: [{ to: [{ email: toEmail, name: toName || undefined }] }],
    from: { email: MAIL_FROM, name: 'Thesis' },
    subject: 'Επαναφορά κωδικού - Thesis',
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`SendGrid ${res.status}: ${errorBody}`);
  }
}

function buildResetEmailHtml(name, url) {
  return `<!doctype html>
<html lang="el">
<head><meta charset="utf-8"><title>Επαναφορά κωδικού</title></head>
<body style="margin:0;padding:0;background:#f7fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#2d3748;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7fafc;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden;">
        <tr><td style="padding:32px 40px 24px;border-bottom:1px solid #edf2f7;">
          <div style="font-size:24px;font-weight:700;color:#2b6cb0;">Thesis</div>
          <div style="font-size:13px;color:#718096;margin-top:4px;">Νομικό λογισμικό δικηγορικών γραφείων</div>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <h1 style="margin:0 0 16px;font-size:20px;color:#2d3748;">Αίτημα επαναφοράς κωδικού</h1>
          <p style="margin:0 0 16px;line-height:1.6;">Γεια σας ${escapeHtml(name)},</p>
          <p style="margin:0 0 16px;line-height:1.6;">Λάβαμε αίτημα επαναφοράς του κωδικού σας. Για να ορίσετε νέο κωδικό, πατήστε το παρακάτω κουμπί:</p>
          <p style="margin:24px 0;text-align:center;">
            <a href="${url}" style="display:inline-block;padding:12px 28px;background:#2b6cb0;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">Επαναφορά κωδικού</a>
          </p>
          <p style="margin:0 0 8px;line-height:1.6;font-size:13px;color:#718096;">Ή αντιγράψτε το ακόλουθο URL στο browser σας:</p>
          <p style="margin:0 0 24px;font-family:'Courier New',monospace;font-size:12px;word-break:break-all;background:#f7fafc;padding:12px;border-radius:4px;color:#4a5568;">${url}</p>
          <p style="margin:0 0 8px;line-height:1.6;font-size:13px;color:#718096;">Ο σύνδεσμος λήγει σε <strong>${TOKEN_TTL_MINUTES} λεπτά</strong>.</p>
          <p style="margin:0;line-height:1.6;font-size:13px;color:#718096;">Αν δεν ζητήσατε επαναφορά κωδικού, αγνοήστε αυτό το email — ο κωδικός σας παραμένει ασφαλής.</p>
        </td></tr>
        <tr><td style="padding:20px 40px;background:#f7fafc;border-top:1px solid #edf2f7;font-size:12px;color:#a0aec0;text-align:center;">
          © ${new Date().getFullYear()} Thesis. Αυτό είναι αυτοματοποιημένο μήνυμα — μην απαντήσετε.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildResetEmailText(name, url) {
  return `Γεια σας ${name},

Λάβαμε αίτημα επαναφοράς του κωδικού σας για το Thesis.

Για να ορίσετε νέο κωδικό, ανοίξτε τον παρακάτω σύνδεσμο:
${url}

Ο σύνδεσμος λήγει σε ${TOKEN_TTL_MINUTES} λεπτά.

Αν δεν ζητήσατε επαναφορά κωδικού, αγνοήστε αυτό το email.

—
Thesis
Αυτό είναι αυτοματοποιημένο μήνυμα.`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// ---------- Routes ----------

// POST /api/auth/forgot-password
// Always returns 200 to avoid user enumeration.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      // Still return 200 to avoid leaking whether input was well-formed
      return res.json({ ok: true });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const userQ = await pool.query(
      `SELECT id, email, TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))) AS display_name
         FROM users
        WHERE LOWER(email) = $1
        LIMIT 1`,
      [normalizedEmail]
    );

    if (userQ.rows.length > 0) {
      const user = userQ.rows[0];
      const token = generateToken();
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

      await pool.query(
        `UPDATE users
            SET password_reset_token = $1,
                password_reset_expires_at = $2
          WHERE id = $3`,
        [token, expiresAt, user.id]
      );

      const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`;

      // Send email — don't fail the request if email fails; log server-side.
      try {
        await sendResetEmail(user.email, user.display_name, resetUrl);
      } catch (emailErr) {
        console.error('[forgot-password] email send failed:', emailErr.message);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[forgot-password] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/reset-password/:token
// Verifies token validity without consuming it. Used by frontend to show form vs. error.
router.get('/reset-password/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || typeof token !== 'string' || token.length !== 64) {
      return res.json({ valid: false });
    }

    const q = await pool.query(
      `SELECT id
         FROM users
        WHERE password_reset_token = $1
          AND password_reset_expires_at > NOW()
        LIMIT 1`,
      [token]
    );

    return res.json({ valid: q.rows.length > 0 });
  } catch (err) {
    console.error('[verify-reset-token] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/reset-password
// Consumes the token, sets new password.
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token || typeof token !== 'string' || token.length !== 64) {
      return res.status(400).json({ error: 'Μη έγκυρο token.' });
    }
    if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.' });
    }

    const q = await pool.query(
      `SELECT id
         FROM users
        WHERE password_reset_token = $1
          AND password_reset_expires_at > NOW()
        LIMIT 1`,
      [token]
    );

    if (q.rows.length === 0) {
      return res.status(400).json({ error: 'Ο σύνδεσμος έχει λήξει ή είναι μη έγκυρος. Ζητήστε νέο σύνδεσμο επαναφοράς.' });
    }

    const userId = q.rows[0].id;
    const hash = await bcrypt.hash(new_password, 12);

    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              password_reset_token = NULL,
              password_reset_expires_at = NULL
        WHERE id = $2`,
      [hash, userId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[reset-password] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
