// src/routes/mydata.js
// myDATA integration — send an issued invoice to AADE, cancel it, or check its status.
//
// Endpoints:
//   POST   /api/mydata/invoices/:id/send      Send an issued invoice
//   POST   /api/mydata/invoices/:id/cancel    Cancel a submitted invoice
//   GET    /api/mydata/invoices/:id/status    Read stored status (no external call)
//
// Prerequisites (per organization, in organization_settings):
//   mydata_user_id, mydata_subscription_key, mydata_environment ('dev' | 'prod')

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { buildSendInvoicesXml, parseResponseXml } = require('../utils/mydata-xml');
const client = require('../utils/mydata-client');

const router = express.Router();
router.use(requireAuth);

// Ensure additive columns exist (idempotent — safe on every boot).
let colsEnsured = false;
async function ensureColumns() {
  if (colsEnsured) return;
  await pool.query(`
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mydata_type          VARCHAR(10);
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mydata_auth_code     VARCHAR(255);
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mydata_submitted_at  TIMESTAMPTZ;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mydata_cancel_mark   VARCHAR(120);
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mydata_cancelled_at  TIMESTAMPTZ;

    ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS mydata_default_invoice_type      VARCHAR(10) DEFAULT '2.1';
    ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS mydata_classification_type       VARCHAR(30) DEFAULT 'E3_561_001';
    ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS mydata_classification_category   VARCHAR(30) DEFAULT 'category1_3';
  `);
  colsEnsured = true;
}

// ---------- Helpers ----------

async function loadInvoiceForSend(invoiceId, orgId) {
  const q = await pool.query(
    `SELECT i.*
       FROM invoices i
      WHERE i.aa = $1 AND i.organization_id = $2`,
    [invoiceId, orgId]
  );
  if (q.rows.length === 0) return null;
  const invoice = q.rows[0];
  const linesR = await pool.query(
    `SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_order ASC, aa ASC`,
    [invoiceId]
  );
  invoice.lines = linesR.rows;
  return invoice;
}

async function loadOrgSettings(orgId) {
  const r = await pool.query(
    `SELECT * FROM organization_settings WHERE organization_id = $1`,
    [orgId]
  );
  return r.rows[0] || null;
}

async function loadRecipient(invoice) {
  if (invoice.fysiko_prosopo_id) {
    const r = await pool.query(
      `SELECT afm, eponymo, onoma FROM fysika_prosopa WHERE aa = $1`,
      [invoice.fysiko_prosopo_id]
    );
    if (r.rows[0]) {
      return {
        vatNumber: r.rows[0].afm,
        country:   'GR',
        branch:    0,
        name:      [r.rows[0].eponymo, r.rows[0].onoma].filter(Boolean).join(' '),
      };
    }
  }
  if (invoice.nomiko_prosopo_id) {
    const r = await pool.query(
      `SELECT afm, eponymia FROM nomika_prosopa WHERE aa = $1`,
      [invoice.nomiko_prosopo_id]
    );
    if (r.rows[0]) {
      return {
        vatNumber: r.rows[0].afm,
        country:   'GR',
        branch:    0,
        name:      r.rows[0].eponymia,
      };
    }
  }
  return null;
}

function requireCreds(org) {
  if (!org) throw new Error('Δεν έχουν οριστεί στοιχεία γραφείου.');
  if (!org.afm) throw new Error('Το γραφείο δεν έχει ΑΦΜ στα στοιχεία οργανισμού.');
  if (!org.mydata_user_id || !org.mydata_subscription_key) {
    throw new Error('Λείπουν myDATA credentials (mydata_user_id / mydata_subscription_key) στις ρυθμίσεις οργανισμού.');
  }
  return {
    env:              org.mydata_environment || 'dev',
    userId:           org.mydata_user_id,
    subscriptionKey:  org.mydata_subscription_key,
  };
}

// ---------- POST /api/mydata/invoices/:id/send ----------

router.post('/invoices/:id/send', async (req, res) => {
  try {
    await ensureColumns();
    const orgId = req.user.organization_id;
    const invoiceId = req.params.id;

    const invoice = await loadInvoiceForSend(invoiceId, orgId);
    if (!invoice) return res.status(404).json({ error: 'Το τιμολόγιο δεν βρέθηκε.' });
    if (invoice.status !== 'issued') {
      return res.status(400).json({ error: 'Μόνο εκδοθέντα τιμολόγια αποστέλλονται στο myDATA.' });
    }
    if (invoice.mydata_mark) {
      return res.status(409).json({ error: `Έχει ήδη αποσταλεί (MARK ${invoice.mydata_mark}).` });
    }

    const org = await loadOrgSettings(orgId);
    let creds;
    try { creds = requireCreds(org); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const recipient = await loadRecipient(invoice);
    if (!recipient || !recipient.vatNumber) {
      return res.status(400).json({ error: 'Ο λήπτης δεν έχει ΑΦΜ.' });
    }

    const invoiceType = req.body.invoiceType
      || invoice.mydata_type
      || org.mydata_default_invoice_type
      || '2.1';

    if (!['1.1', '2.1', '5.1'].includes(invoiceType)) {
      return res.status(400).json({ error: `Μη υποστηριζόμενος τύπος: ${invoiceType}. Υποστηρίζονται 1.1, 2.1, 5.1.` });
    }

    // Για 5.1 (Πιστωτικό) χρειάζεται correlatedInvoices — δηλαδή link στο αρχικό MARK του τιμολογίου που ακυρώνει
    let correlatedMark = null;
    if (invoiceType === '5.1') {
      correlatedMark = req.body.correlatedMark || null;
      if (!correlatedMark) {
        return res.status(400).json({ error: 'Για τύπο 5.1 (Πιστωτικό) απαιτείται το MARK του αρχικού τιμολογίου (correlatedMark).' });
      }
    }

    const xml = buildSendInvoicesXml({
      invoice,
      lines:       invoice.lines,
      issuer:      { vatNumber: org.afm, country: 'GR', branch: 0 },
      counterpart: recipient,
      invoiceType,
      correlatedMark,
      classificationType:     org.mydata_classification_type     || 'E3_561_001',
      classificationCategory: org.mydata_classification_category || 'category1_3',
    });

    const aadeRes = await client.sendInvoices(xml, creds);
    const parsed = parseResponseXml(aadeRes.body);
    const first  = parsed[0] || {};

    // Persist result
    if (aadeRes.ok && first.statusCode === 'Success' && first.invoiceMark) {
      await pool.query(
        `UPDATE invoices SET
           mydata_uid          = $1,
           mydata_mark         = $2,
           mydata_auth_code    = $3,
           mydata_status       = 'sent',
           mydata_type         = $4,
           mydata_submitted_at = NOW(),
           mydata_response     = $5
         WHERE aa = $6 AND organization_id = $7`,
        [
          first.invoiceUid,
          first.invoiceMark,
          first.authenticationCode,
          invoiceType,
          JSON.stringify({ requestXml: xml, responseXml: aadeRes.body, parsed }),
          invoiceId,
          orgId,
        ]
      );
      return res.json({
        ok: true,
        mark: first.invoiceMark,
        uid:  first.invoiceUid,
        authenticationCode: first.authenticationCode,
        invoiceType,
      });
    }

    // Persist error, but keep status=null so user can retry
    await pool.query(
      `UPDATE invoices SET
         mydata_status   = 'error',
         mydata_response = $1
       WHERE aa = $2 AND organization_id = $3`,
      [JSON.stringify({ requestXml: xml, responseXml: aadeRes.body, parsed, httpStatus: aadeRes.status }), invoiceId, orgId]
    );
    return res.status(400).json({
      ok: false,
      httpStatus: aadeRes.status,
      statusCode: first.statusCode || null,
      errors:     first.errors || [],
      raw:        aadeRes.body,
    });
  } catch (err) {
    console.error('[mydata send]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- POST /api/mydata/invoices/:id/cancel ----------

router.post('/invoices/:id/cancel', async (req, res) => {
  try {
    await ensureColumns();
    const orgId = req.user.organization_id;
    const invoiceId = req.params.id;

    const invR = await pool.query(
      `SELECT aa, mydata_mark, mydata_cancel_mark
         FROM invoices
        WHERE aa = $1 AND organization_id = $2`,
      [invoiceId, orgId]
    );
    if (invR.rows.length === 0) return res.status(404).json({ error: 'Δεν βρέθηκε.' });
    const inv = invR.rows[0];
    if (!inv.mydata_mark) return res.status(400).json({ error: 'Το τιμολόγιο δεν έχει σταλεί ακόμα στο myDATA.' });
    if (inv.mydata_cancel_mark) return res.status(409).json({ error: `Έχει ήδη ακυρωθεί (MARK ${inv.mydata_cancel_mark}).` });

    const org = await loadOrgSettings(orgId);
    let creds;
    try { creds = requireCreds(org); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const aadeRes = await client.cancelInvoice(inv.mydata_mark, creds);
    const parsed = parseResponseXml(aadeRes.body);
    const first = parsed[0] || {};

    if (aadeRes.ok && first.statusCode === 'Success' && first.cancellationMark) {
      await pool.query(
        `UPDATE invoices SET
           mydata_status       = 'cancelled',
           mydata_cancel_mark  = $1,
           mydata_cancelled_at = NOW()
         WHERE aa = $2 AND organization_id = $3`,
        [first.cancellationMark, invoiceId, orgId]
      );
      return res.json({ ok: true, cancellationMark: first.cancellationMark });
    }

    return res.status(400).json({
      ok: false,
      httpStatus: aadeRes.status,
      statusCode: first.statusCode || null,
      errors:     first.errors || [],
      raw:        aadeRes.body,
    });
  } catch (err) {
    console.error('[mydata cancel]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- GET /api/mydata/invoices/:id/status ----------

router.get('/invoices/:id/status', async (req, res) => {
  try {
    await ensureColumns();
    const orgId = req.user.organization_id;
    const r = await pool.query(
      `SELECT aa, mydata_uid, mydata_mark, mydata_auth_code, mydata_status,
              mydata_type, mydata_submitted_at, mydata_cancel_mark, mydata_cancelled_at
         FROM invoices
        WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Δεν βρέθηκε.' });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[mydata status]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET /api/mydata/health ----------
// Ελέγχει αν τα credentials δουλεύουν κάνοντας ένα no-op RequestDocs call.
// Δεν στέλνει τίποτα — απλά διαπιστώνει ότι το AADE gateway δέχεται τα headers.

router.get('/health', async (req, res) => {
  try {
    await ensureColumns();
    const orgId = req.user.organization_id;
    const org = await loadOrgSettings(orgId);
    let creds;
    try { creds = requireCreds(org); }
    catch (e) { return res.status(200).json({ ok: false, reason: e.message }); }

    // RequestDocs με ένα δήθεν MARK — αν επιστρέψει 401/403, τα credentials είναι λάθος.
    // Οποιοδήποτε άλλο response = τα credentials δεκτά.
    const r = await client.requestDocs('1', creds);

    let ok, message;
    if (r.status === 401 || r.status === 403) {
      ok = false;
      message = `Λάθος credentials (HTTP ${r.status}). Έλεγξε το User ID και το Subscription Key.`;
    } else if (r.status >= 500) {
      ok = false;
      message = `Το ΑΑΔΕ API απάντησε με ${r.status}. Δοκίμασε αργότερα.`;
    } else {
      ok = true;
      message = `Credentials δεκτά (HTTP ${r.status}). Περιβάλλον: ${creds.env}.`;
    }
    res.json({ ok, message, httpStatus: r.status, environment: creds.env });
  } catch (err) {
    console.error('[mydata health]', err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

module.exports = router;
