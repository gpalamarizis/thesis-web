// src/services/email.js
// SendGrid HTTP API (port 443) - παρακάμπτει SMTP block.
// Απαιτεί: SENDGRID_API_KEY (ή SMTP_PASS αν είναι SG.xxx)
// SMTP_FROM = "Thesis <verified@email>"

async function sgSend({ to, subject, html, text }) {
  const apiKey = process.env.SENDGRID_API_KEY || process.env.SMTP_PASS;
  const fromRaw = process.env.SMTP_FROM || 'Thesis <no-reply@thesis.gr>';
  if (!apiKey || !apiKey.startsWith('SG.')) {
    console.warn('[email] SENDGRID_API_KEY missing or invalid');
    return { skipped: true, reason: 'no api key' };
  }

  // Parse "Name <email>"
  let fromEmail = fromRaw, fromName = 'Thesis';
  const m = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
  if (m) { fromName = m[1].trim(); fromEmail = m[2].trim(); }

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: 'text/plain', value: text || html.replace(/<[^>]+>/g, '') },
      { type: 'text/html',  value: html },
    ],
  };

  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`SendGrid ${r.status}: ${errText}`);
  }
  return { messageId: r.headers.get('x-message-id') };
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
  return sgSend({ to, subject, html: baseTemplate(html), text });
}

async function sendWelcome({ to, firstName, organizationName }) {
  const url = process.env.FRONTEND_URL || 'https://thesis-frontend.gpal.workers.dev';
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
  const url = process.env.FRONTEND_URL || 'https://thesis-frontend.gpal.workers.dev';
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

async function sendPasswordReset({ to, firstName, newPassword }) {
  return send({
    to, subject: 'Ενημέρωση κωδικού πρόσβασης',
    html: `<h2>Ο κωδικός σας άλλαξε</h2>
      <p>Νέος κωδικός: <code>${newPassword}</code></p>
      <p>Σας συνιστούμε να τον αλλάξετε άμεσα μετά τη σύνδεση.</p>`,
  });
}

module.exports = { send, sendWelcome, sendTrialEnding, sendSubscriptionActivated, sendInvoiceSent, sendPasswordReset };
