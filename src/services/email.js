// src/services/email.js
// v5: Αποστολή ΑΠΟΚΛΕΙΣΤΙΚΑ μέσω dnHost SMTP (nodemailer). Το SendGrid αφαιρέθηκε.
// Το Railway επιβεβαιώθηκε ότι ΔΕΝ μπλοκάρει τη θύρα 587.
//
// Μεταβλητές περιβάλλοντος (Railway -> Variables):
//   SMTP_HOST          mail.thesislegal.gr
//   SMTP_PORT          587
//   SMTP_SECURE        false        (STARTTLS στην 587)
//   SMTP_USER          noreply@thesislegal.gr   (ΟΛΟΚΛΗΡΗ διεύθυνση)
//   SMTP_PASS          ο κωδικός του email
//   SMTP_TLS_INSECURE  true         (το πιστοποιητικό dnHost είναι *.mynewserver.com)
//   SMTP_FROM          Thesis <noreply@thesislegal.gr>
//   FRONTEND_URL       https://app.thesislegal.gr

const nodemailer = require('nodemailer');

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.warn('[email] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)');
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = String(process.env.SMTP_SECURE || 'false') === 'true';
  const insecure = String(process.env.SMTP_TLS_INSECURE || 'false') === 'true';

  _transporter = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: insecure
      ? { rejectUnauthorized: false }
      : { minVersion: 'TLSv1.2', servername: host },
  });
  return _transporter;
}

function parseFrom() {
  const raw = process.env.SMTP_FROM || 'Thesis <noreply@thesislegal.gr>';
  const m = raw.match(/^(.+?)\s*<(.+?)>$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: 'Thesis', email: raw };
}

function baseTemplate(body) {
  const brand = process.env.SMTP_FROM_NAME || 'Thesis';
  return `<!DOCTYPE html><html lang="el"><head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background:#f7fafc; margin:0; padding:20px;">
  <table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px; margin:0 auto; background:#fff; border-radius:8px; overflow:hidden;">
    <tr><td style="background:#1F3864; padding:20px 24px;"><h1 style="color:#fff; margin:0; font-size:24px;">${brand}</h1></td></tr>
    <tr><td style="padding:24px;">${body}</td></tr>
    <tr><td style="background:#f7fafc; padding:16px 24px; border-top:1px solid #e2e8f0;">
      <p style="color:#718096; font-size:12px; margin:0; text-align:center;">Thesis — © OB.AN IKE. Αυτό είναι αυτόματο email.</p>
    </td></tr>
  </table>
</body></html>`;
}

async function send({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    console.error(`[email] NOT SENT to ${to}: SMTP not configured`);
    return { skipped: true, reason: 'smtp not configured' };
  }
  const from = parseFrom();
  const wrapped = baseTemplate(html);
  try {
    const info = await t.sendMail({
      from: `"${from.name}" <${from.email}>`,
      to, subject,
      text: text || wrapped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      html: wrapped,
    });
    console.log(`[email] sent to ${to} (${info.messageId})`);
    return { messageId: info.messageId };
  } catch (err) {
    console.error(`[email] send failed to ${to}: ${err.message}`);
    throw err;
  }
}

async function sendWelcome({ to, firstName, organizationName }) {
  const url = (process.env.FRONTEND_URL || 'https://app.thesislegal.gr').replace(/\/$/, '');
  return send({
    to, subject: 'Καλωσορίσατε στο Thesis',
    html: `
      <h2 style="color:#1F3864;">Γεια σας ${firstName || ''}!</h2>
      <p>Ευχαριστούμε που εγγραφήκατε στο <b>Thesis</b>. Ο λογαριασμός του γραφείου <b>${organizationName}</b> είναι έτοιμος.</p>
      <p>Έχετε <b>30 ημέρες δωρεάν</b> για να εξερευνήσετε όλες τις δυνατότητες.</p>
      <div style="margin:24px 0;"><a href="${url}/dashboard" style="background:#2E75B6; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Εκκίνηση</a></div>
    `,
  });
}

async function sendTrialEnding({ to, firstName, daysLeft }) {
  const url = (process.env.FRONTEND_URL || 'https://app.thesislegal.gr').replace(/\/$/, '');
  const urgent = daysLeft <= 3;
  return send({
    to, subject: urgent ? `Απομένουν ${daysLeft} ημέρες trial` : `Λήγει σε ${daysLeft} ημέρες η δοκιμαστική`,
    html: `<h2 style="color:${urgent ? '#e53e3e' : '#dd6b20'};">Λήγει σε ${daysLeft} ημέρες</h2>
      <p>Γεια σας ${firstName || ''}, η δωρεάν περίοδος λήγει σε <b>${daysLeft} ημέρες</b>.</p>
      <div style="margin:24px 0;"><a href="${url}/settings/subscription" style="background:#2E75B6; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Επιλογή πλάνου</a></div>`,
  });
}

async function sendSubscriptionActivated({ to, firstName, planName, amount, periodEnd }) {
  const fmtDate = periodEnd ? new Date(periodEnd).toLocaleDateString('el-GR') : '';
  return send({
    to, subject: `Ενεργοποίηση συνδρομής: ${planName}`,
    html: `<h2 style="color:#38a169;">Η συνδρομή σας ενεργοποιήθηκε</h2>
      <p>Γεια σας ${firstName || ''},</p>
      <p><b>${planName}</b> — <b>${amount ? amount.toFixed(2) + ' €' : '—'}</b> — Λήξη: <b>${fmtDate}</b></p>`,
  });
}

async function sendInvoiceSent({ to, firstName, invoiceNumber, clientName, amount }) {
  return send({
    to, subject: `Τιμολόγιο ${invoiceNumber} — Αποστολή στη ΑΑΔΕ`,
    html: `<h2>Τιμολόγιο ${invoiceNumber} εκδόθηκε</h2>
      <p>Πελάτης: ${clientName}<br>Ποσό: ${amount ? amount.toFixed(2) + ' €' : '—'}</p>`,
  });
}

async function sendPasswordReset({ to, firstName, resetUrl }) {
  return send({
    to, subject: 'Επαναφορά κωδικού πρόσβασης — Thesis',
    html: `<h2 style="color:#1F3864;">Επαναφορά κωδικού</h2>
      <p>Γεια σας ${firstName || ''},</p>
      <p>Λάβαμε αίτημα επαναφοράς του κωδικού σας. Πατήστε το κουμπί για να ορίσετε νέο κωδικό:</p>
      <div style="margin:24px 0;">
        <a href="${resetUrl}" style="background:#2E75B6; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Ορισμός νέου κωδικού</a>
      </div>
      <p style="font-size:13px; color:#718096;">Ο σύνδεσμος λήγει σε <b>60 λεπτά</b>. Αν δεν ζητήσατε επαναφορά, αγνοήστε αυτό το email — ο κωδικός σας παραμένει ίδιος.</p>
      <p style="font-size:12px; color:#a0aec0; word-break:break-all;">Αν το κουμπί δεν λειτουργεί, αντιγράψτε: ${resetUrl}</p>`,
  });
}

module.exports = { send, sendWelcome, sendTrialEnding, sendSubscriptionActivated, sendInvoiceSent, sendPasswordReset };
