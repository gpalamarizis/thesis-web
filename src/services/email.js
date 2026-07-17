// src/services/email.js
// Email service using nodemailer with SMTP.
// Supports Gmail, SendGrid, Postmark, Resend, custom SMTP.
//
// Required env vars:
//   SMTP_HOST     e.g. smtp.gmail.com, smtp.sendgrid.net
//   SMTP_PORT     e.g. 587 (STARTTLS) or 465 (SSL)
//   SMTP_USER     e.g. apikey (SendGrid) or full email (Gmail)
//   SMTP_PASS     password / API key
//   SMTP_FROM     "Thesis <no-reply@thesis.gr>"
//   FRONTEND_URL  for links inside emails

let nodemailerLoaded = null;
function getTransporter() {
  if (!nodemailerLoaded) {
    try {
      nodemailerLoaded = require('nodemailer');
    } catch {
      throw new Error('nodemailer not installed. Run: npm install nodemailer');
    }
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP credentials missing (SMTP_HOST/USER/PASS)');
  }
  return nodemailerLoaded.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: SMTP_PORT === '465',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function baseTemplate(body) {
  const brand = process.env.SMTP_FROM_NAME || 'Thesis';
  return `<!DOCTYPE html>
<html lang="el"><head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background:#f7fafc; margin:0; padding:20px;">
  <table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px; margin:0 auto; background:#fff; border-radius:8px; overflow:hidden;">
    <tr><td style="background:#1F3864; padding:20px 24px;">
      <h1 style="color:#fff; margin:0; font-size:24px;">${brand}</h1>
    </td></tr>
    <tr><td style="padding:24px;">
      ${body}
    </td></tr>
    <tr><td style="background:#f7fafc; padding:16px 24px; border-top:1px solid #e2e8f0;">
      <p style="color:#718096; font-size:12px; margin:0; text-align:center;">
        Thesis — Σύστημα Διαχείρισης Δικηγορικού Γραφείου<br/>
        © OB.AN IKE. Αυτό είναι αυτόματο email, μην απαντήσετε.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

async function send({ to, subject, html, text }) {
  if (!process.env.SMTP_HOST) {
    console.warn('[email] SMTP not configured, skipping:', subject);
    return { skipped: true };
  }
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || 'Thesis <no-reply@thesis.gr>';
  const info = await transporter.sendMail({ from, to, subject, html: baseTemplate(html), text: text || html.replace(/<[^>]+>/g, '') });
  return { messageId: info.messageId };
}

// ---- Templates ----

async function sendWelcome({ to, firstName, organizationName }) {
  const url = process.env.FRONTEND_URL || 'https://thesis-frontend.gpal.workers.dev';
  return send({
    to,
    subject: 'Καλωσορίσατε στο Thesis',
    html: `
      <h2 style="color:#1F3864;">Γεια σας ${firstName || ''}!</h2>
      <p>Ευχαριστούμε που εγγραφήκατε στο <b>Thesis</b>. Ο λογαριασμός του γραφείου σας <b>${organizationName}</b> είναι έτοιμος.</p>
      <p>Έχετε <b>30 ημέρες δωρεάν δοκιμαστικής χρήσης</b> για να εξερευνήσετε όλες τις δυνατότητες.</p>
      <div style="margin:24px 0;">
        <a href="${url}/dashboard" style="background:#2E75B6; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Εκκίνηση</a>
      </div>
      <p><b>Βοηθητικά:</b></p>
      <ul>
        <li><a href="${url}/settings/templates">Ανεβάστε πρώτο υπόδειγμα Word</a></li>
        <li><a href="${url}/team">Καλέστε συνεργάτες</a></li>
        <li><a href="${url}/settings/organization">Ρυθμίστε myDATA για τιμολόγηση</a></li>
      </ul>
    `,
  });
}

async function sendTrialEnding({ to, firstName, daysLeft }) {
  const url = process.env.FRONTEND_URL || 'https://thesis-frontend.gpal.workers.dev';
  const urgent = daysLeft <= 3;
  return send({
    to,
    subject: urgent ? `Απομένουν ${daysLeft} ημέρες trial` : `Λήγει σε ${daysLeft} ημέρες η δοκιμαστική`,
    html: `
      <h2 style="color:${urgent ? '#e53e3e' : '#dd6b20'};">${urgent ? '⚠️ ' : ''}Λήγει σε ${daysLeft} ημέρες</h2>
      <p>Γεια σας ${firstName || ''},</p>
      <p>Η δωρεάν δοκιμαστική περίοδος του λογαριασμού σας λήγει σε <b>${daysLeft} ημέρες</b>.</p>
      <p>Για να συνεχίσετε να χρησιμοποιείτε το Thesis μετά τη λήξη, επιλέξτε πλάνο συνδρομής:</p>
      <div style="margin:24px 0;">
        <a href="${url}/settings/subscription" style="background:#2E75B6; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Επιλογή πλάνου</a>
      </div>
      <p style="font-size:13px; color:#718096;">Αν έχετε ερωτήσεις, απαντήστε σε αυτό το email.</p>
    `,
  });
}

async function sendSubscriptionActivated({ to, firstName, planName, amount, periodEnd }) {
  const url = process.env.FRONTEND_URL || 'https://thesis-frontend.gpal.workers.dev';
  const fmtDate = periodEnd ? new Date(periodEnd).toLocaleDateString('el-GR') : '';
  return send({
    to,
    subject: `Ενεργοποίηση συνδρομής: ${planName}`,
    html: `
      <h2 style="color:#38a169;">✅ Η συνδρομή σας ενεργοποιήθηκε</h2>
      <p>Γεια σας ${firstName || ''},</p>
      <p>Η πληρωμή σας επιβεβαιώθηκε επιτυχώς και η συνδρομή σας είναι ενεργή:</p>
      <div style="background:#f7fafc; padding:16px; border-radius:6px; margin:16px 0;">
        <p style="margin:4px 0;"><b>Πλάνο:</b> ${planName}</p>
        <p style="margin:4px 0;"><b>Ποσό:</b> ${amount ? amount.toFixed(2) + ' €' : '—'}</p>
        <p style="margin:4px 0;"><b>Λήξη:</b> ${fmtDate}</p>
      </div>
      <p>Ευχαριστούμε για την εμπιστοσύνη σας!</p>
      <div style="margin:24px 0;">
        <a href="${url}/settings/subscription" style="background:#2E75B6; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Δείτε τη συνδρομή</a>
      </div>
    `,
  });
}

async function sendInvoiceSent({ to, firstName, invoiceNumber, clientName, amount }) {
  return send({
    to,
    subject: `Τιμολόγιο ${invoiceNumber} — Αποστολή στη ΑΑΔΕ`,
    html: `
      <h2 style="color:#1F3864;">📄 Τιμολόγιο εκδόθηκε</h2>
      <p>Γεια σας ${firstName || ''},</p>
      <p>Το τιμολόγιο <b>${invoiceNumber}</b> εκδόθηκε επιτυχώς και διαβιβάστηκε στην ΑΑΔΕ (myDATA).</p>
      <div style="background:#f7fafc; padding:16px; border-radius:6px; margin:16px 0;">
        <p style="margin:4px 0;"><b>Πελάτης:</b> ${clientName}</p>
        <p style="margin:4px 0;"><b>Ποσό:</b> ${amount ? amount.toFixed(2) + ' €' : '—'}</p>
      </div>
    `,
  });
}

async function sendPasswordReset({ to, firstName, newPassword }) {
  return send({
    to,
    subject: 'Ενημέρωση κωδικού πρόσβασης',
    html: `
      <h2 style="color:#1F3864;">🔑 Ο κωδικός σας άλλαξε</h2>
      <p>Γεια σας ${firstName || ''},</p>
      <p>Ο διαχειριστής του γραφείου σας άλλαξε τον κωδικό πρόσβασής σας. Νέος κωδικός:</p>
      <div style="background:#f7fafc; padding:16px; border-radius:6px; margin:16px 0; text-align:center; font-family:monospace; font-size:18px; letter-spacing:2px;">
        ${newPassword}
      </div>
      <p><b>Σας συνιστούμε να τον αλλάξετε άμεσα μετά τη σύνδεση.</b></p>
    `,
  });
}

module.exports = {
  send,
  sendWelcome,
  sendTrialEnding,
  sendSubscriptionActivated,
  sendInvoiceSent,
  sendPasswordReset,
};
