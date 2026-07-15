// src/routes/invoices.js
// Τιμολόγια — main invoicing route with lines.
//
// Endpoints:
//   GET    /api/invoices
//   GET    /api/invoices/:id
//   POST   /api/invoices                       (create draft)
//   PUT    /api/invoices/:id                   (update draft — issued invoices are immutable)
//   POST   /api/invoices/:id/issue             (issue draft: lock, assign number)
//   POST   /api/invoices/:id/cancel            (mark cancelled)
//   DELETE /api/invoices/:id                   (only drafts)
//   POST   /api/invoices/from-case/:caseId     (create pre-filled draft from case fees/hours)

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      aa                  BIGSERIAL PRIMARY KEY,
      organization_id     BIGINT NOT NULL,
      series_id           BIGINT,
      number              BIGINT,
      series_name         VARCHAR(50),
      full_number         VARCHAR(80),
      date                DATE NOT NULL,
      -- Recipient (choose one)
      fysiko_prosopo_id   BIGINT,
      nomiko_prosopo_id   BIGINT,
      -- Optional case link
      ypothesi_id         BIGINT,
      -- Snapshotted issuer data (frozen at issue-time)
      issuer_afm          VARCHAR(20),
      issuer_eponymia     VARCHAR(255),
      issuer_odos         VARCHAR(255),
      issuer_arithmos     VARCHAR(20),
      issuer_tk           VARCHAR(20),
      issuer_poli         VARCHAR(120),
      issuer_doy          VARCHAR(120),
      issuer_kad          VARCHAR(20),
      -- Snapshotted recipient
      recipient_afm       VARCHAR(20),
      recipient_name      VARCHAR(255),
      recipient_doy       VARCHAR(120),
      recipient_address   TEXT,
      -- Amounts (computed from lines + adjustments)
      subtotal            NUMERIC(14,2) DEFAULT 0,
      vat_total           NUMERIC(14,2) DEFAULT 0,
      withhold_total      NUMERIC(14,2) DEFAULT 0,
      stamp_total         NUMERIC(14,2) DEFAULT 0,
      tn_total            NUMERIC(14,2) DEFAULT 0,
      total_gross         NUMERIC(14,2) DEFAULT 0,
      total_net           NUMERIC(14,2) DEFAULT 0,
      -- Deductions applied (flags at invoice-level)
      apply_withhold      BOOLEAN DEFAULT FALSE,
      apply_stamp         BOOLEAN DEFAULT FALSE,
      apply_tn            BOOLEAN DEFAULT FALSE,
      -- Status
      status              VARCHAR(20) DEFAULT 'draft',    -- draft | issued | cancelled
      issued_at           TIMESTAMPTZ,
      cancelled_at        TIMESTAMPTZ,
      cancel_reason       TEXT,
      -- Notes & payment
      notes               TEXT,
      payment_terms       TEXT,
      due_date            DATE,
      -- myDATA (populated later)
      mydata_uid          VARCHAR(120),
      mydata_mark         VARCHAR(120),
      mydata_status       VARCHAR(30),
      mydata_response     JSONB,
      -- Audit
      created_by          BIGINT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inv_org         ON invoices (organization_id);
    CREATE INDEX IF NOT EXISTS idx_inv_case        ON invoices (ypothesi_id);
    CREATE INDEX IF NOT EXISTS idx_inv_fysiko      ON invoices (fysiko_prosopo_id);
    CREATE INDEX IF NOT EXISTS idx_inv_nomiko      ON invoices (nomiko_prosopo_id);
    CREATE INDEX IF NOT EXISTS idx_inv_status_date ON invoices (organization_id, status, date);

    CREATE TABLE IF NOT EXISTS invoice_lines (
      aa            BIGSERIAL PRIMARY KEY,
      invoice_id    BIGINT NOT NULL REFERENCES invoices(aa) ON DELETE CASCADE,
      description   TEXT NOT NULL,
      quantity      NUMERIC(14,4) DEFAULT 1,
      unit_price    NUMERIC(14,4) DEFAULT 0,
      vat_rate      NUMERIC(5,2)  DEFAULT 24,
      subtotal      NUMERIC(14,2) DEFAULT 0,
      vat_amount    NUMERIC(14,2) DEFAULT 0,
      line_total    NUMERIC(14,2) DEFAULT 0,
      line_order    INT DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON invoice_lines (invoice_id);
  `);
  tableEnsured = true;
}

// ---------- Helpers ----------

function recomputeTotals(lines, applyWithhold, applyStamp, applyTn) {
  let subtotal = 0;
  let vat_total = 0;
  const processedLines = (lines || []).map((l, idx) => {
    const qty  = Number(l.quantity) || 0;
    const unit = Number(l.unit_price) || 0;
    const vatr = Number(l.vat_rate) || 0;
    const sub  = round2(qty * unit);
    const vat  = round2(sub * vatr / 100);
    const tot  = round2(sub + vat);
    subtotal += sub;
    vat_total += vat;
    return {
      description: l.description || '',
      quantity: qty,
      unit_price: unit,
      vat_rate: vatr,
      subtotal: sub,
      vat_amount: vat,
      line_total: tot,
      line_order: l.line_order != null ? l.line_order : idx,
    };
  });
  subtotal = round2(subtotal);
  vat_total = round2(vat_total);

  const gross = round2(subtotal + vat_total);

  // Ελληνικές παρακρατήσεις (υπολογισμός επί καθαρής αξίας)
  const withhold_total = applyWithhold ? round2(subtotal * 0.20) : 0;
  const stamp_total    = applyStamp    ? round2(subtotal * 0.024 * 1.20) : 0; // 2.4% χαρτόσημο + 20% ΟΓΑ χαρτ.
  const tn_total       = applyTn       ? round2(subtotal * 0.12) : 0;         // 12% Ταμείο Νομικών

  const net = round2(gross - withhold_total - stamp_total - tn_total);

  return {
    subtotal, vat_total,
    withhold_total, stamp_total, tn_total,
    total_gross: gross,
    total_net: net,
    lines: processedLines,
  };
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function loadInvoice(id, orgId) {
  const r = await pool.query(
    `SELECT i.*,
            COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma,''), np.eponymia) AS recipient_display_name,
            y.xeirokinito_id AS case_protocol
       FROM invoices i
       LEFT JOIN fysika_prosopa fp ON fp.aa = i.fysiko_prosopo_id
       LEFT JOIN nomika_prosopa np ON np.aa = i.nomiko_prosopo_id
       LEFT JOIN ypotheseis y      ON y.aa  = i.ypothesi_id
      WHERE i.aa = $1 AND i.organization_id = $2`,
    [id, orgId]
  );
  if (r.rows.length === 0) return null;
  const inv = r.rows[0];
  const linesR = await pool.query(
    `SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_order, aa`,
    [id]
  );
  inv.lines = linesR.rows;
  return inv;
}

// ---------- Endpoints ----------

router.get('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const filters = ['i.organization_id = $1'];
  const params = [orgId];
  let i = 2;
  if (req.query.ypothesi_id) { filters.push(`i.ypothesi_id = $${i}`); params.push(req.query.ypothesi_id); i++; }
  if (req.query.status)      { filters.push(`i.status = $${i}`);       params.push(req.query.status); i++; }
  if (req.query.from)        { filters.push(`i.date >= $${i}`);        params.push(req.query.from); i++; }
  if (req.query.to)          { filters.push(`i.date <= $${i}`);        params.push(req.query.to); i++; }

  try {
    const r = await pool.query(
      `SELECT i.aa, i.series_name, i.number, i.full_number, i.date,
              i.total_gross, i.total_net, i.status, i.ypothesi_id,
              i.fysiko_prosopo_id, i.nomiko_prosopo_id,
              i.mydata_mark,
              COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma,''), np.eponymia) AS recipient_name,
              y.xeirokinito_id AS case_protocol,
              i.created_at
         FROM invoices i
         LEFT JOIN fysika_prosopa fp ON fp.aa = i.fysiko_prosopo_id
         LEFT JOIN nomika_prosopa np ON np.aa = i.nomiko_prosopo_id
         LEFT JOIN ypotheseis y      ON y.aa  = i.ypothesi_id
        WHERE ${filters.join(' AND ')}
        ORDER BY i.date DESC, i.aa DESC
        LIMIT 500`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[invoices list]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const inv = await loadInvoice(req.params.id, orgId);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    res.json({ data: inv });
  } catch (err) {
    console.error('[invoices get]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const b = req.body || {};
  if (!b.date) return res.status(400).json({ error: 'date required' });
  if (!b.fysiko_prosopo_id && !b.nomiko_prosopo_id) {
    return res.status(400).json({ error: 'Recipient (fysiko or nomiko) required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const totals = recomputeTotals(b.lines || [], !!b.apply_withhold, !!b.apply_stamp, !!b.apply_tn);

    const invR = await client.query(
      `INSERT INTO invoices (
         organization_id, series_id, date,
         fysiko_prosopo_id, nomiko_prosopo_id, ypothesi_id,
         subtotal, vat_total, withhold_total, stamp_total, tn_total, total_gross, total_net,
         apply_withhold, apply_stamp, apply_tn,
         notes, payment_terms, due_date, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        orgId,
        b.series_id ? parseInt(b.series_id, 10) : null,
        b.date,
        b.fysiko_prosopo_id ? parseInt(b.fysiko_prosopo_id, 10) : null,
        b.nomiko_prosopo_id ? parseInt(b.nomiko_prosopo_id, 10) : null,
        b.ypothesi_id ? parseInt(b.ypothesi_id, 10) : null,
        totals.subtotal, totals.vat_total, totals.withhold_total, totals.stamp_total, totals.tn_total,
        totals.total_gross, totals.total_net,
        !!b.apply_withhold, !!b.apply_stamp, !!b.apply_tn,
        b.notes || null, b.payment_terms || null, b.due_date || null,
        req.user.sub || req.user.id || null,
      ]
    );
    const invoice = invR.rows[0];

    for (const line of totals.lines) {
      await client.query(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, vat_rate, subtotal, vat_amount, line_total, line_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [invoice.aa, line.description, line.quantity, line.unit_price, line.vat_rate,
         line.subtotal, line.vat_amount, line.line_total, line.line_order]
      );
    }

    await client.query('COMMIT');
    const full = await loadInvoice(invoice.aa, orgId);
    res.status(201).json({ data: full });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[invoices create]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const b = req.body || {};

  // Load current
  const cur = await pool.query(
    `SELECT * FROM invoices WHERE aa = $1 AND organization_id = $2`,
    [req.params.id, orgId]
  );
  if (cur.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  if (cur.rows[0].status !== 'draft') {
    return res.status(400).json({ error: 'Μόνο τα προσχέδια (draft) τιμολόγια είναι επεξεργάσιμα.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const totals = recomputeTotals(b.lines || [], !!b.apply_withhold, !!b.apply_stamp, !!b.apply_tn);

    await client.query(
      `UPDATE invoices SET
         series_id         = $1,
         date              = $2,
         fysiko_prosopo_id = $3,
         nomiko_prosopo_id = $4,
         ypothesi_id       = $5,
         subtotal          = $6,
         vat_total         = $7,
         withhold_total    = $8,
         stamp_total       = $9,
         tn_total          = $10,
         total_gross       = $11,
         total_net         = $12,
         apply_withhold    = $13,
         apply_stamp       = $14,
         apply_tn          = $15,
         notes             = $16,
         payment_terms     = $17,
         due_date          = $18,
         updated_at        = NOW()
       WHERE aa = $19 AND organization_id = $20`,
      [
        b.series_id ? parseInt(b.series_id, 10) : null,
        b.date,
        b.fysiko_prosopo_id ? parseInt(b.fysiko_prosopo_id, 10) : null,
        b.nomiko_prosopo_id ? parseInt(b.nomiko_prosopo_id, 10) : null,
        b.ypothesi_id ? parseInt(b.ypothesi_id, 10) : null,
        totals.subtotal, totals.vat_total, totals.withhold_total, totals.stamp_total, totals.tn_total,
        totals.total_gross, totals.total_net,
        !!b.apply_withhold, !!b.apply_stamp, !!b.apply_tn,
        b.notes || null, b.payment_terms || null, b.due_date || null,
        req.params.id, orgId,
      ]
    );

    // Replace lines
    await client.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [req.params.id]);
    for (const line of totals.lines) {
      await client.query(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, vat_rate, subtotal, vat_amount, line_total, line_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.id, line.description, line.quantity, line.unit_price, line.vat_rate,
         line.subtotal, line.vat_amount, line.line_total, line.line_order]
      );
    }

    await client.query('COMMIT');
    const full = await loadInvoice(req.params.id, orgId);
    res.json({ data: full });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[invoices update]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Issue draft: assigns full_number, snapshots issuer/recipient, locks
router.post('/:id/issue', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;

  const cur = await pool.query(
    `SELECT * FROM invoices WHERE aa = $1 AND organization_id = $2`,
    [req.params.id, orgId]
  );
  if (cur.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const invoice = cur.rows[0];
  if (invoice.status !== 'draft') return res.status(400).json({ error: 'Δεν είναι draft' });
  if (!invoice.series_id) return res.status(400).json({ error: 'Επιλέξτε σειρά τιμολογίου.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock series row & get next number
    const sR = await client.query(
      `SELECT * FROM invoice_series WHERE aa = $1 AND organization_id = $2 FOR UPDATE`,
      [invoice.series_id, orgId]
    );
    if (sR.rows.length === 0) throw new Error('Series not found');
    const series = sR.rows[0];
    const nextNum = series.next_number;

    await client.query(
      `UPDATE invoice_series SET next_number = next_number + 1 WHERE aa = $1`,
      [series.aa]
    );

    // Load issuer settings snapshot
    const issR = await client.query(
      `SELECT * FROM organization_settings WHERE organization_id = $1`,
      [orgId]
    );
    const iss = issR.rows[0] || {};

    // Load recipient snapshot
    let recAfm = null, recName = null, recDoy = null, recAddr = null;
    if (invoice.fysiko_prosopo_id) {
      const fpR = await client.query(
        `SELECT afm, doy, eponymo, onoma, odos_oikias AS odos, arithmos_oikias AS arithmos,
                tk_oikias AS tk, poli_oikias AS poli
           FROM fysika_prosopa WHERE aa = $1`,
        [invoice.fysiko_prosopo_id]
      );
      const p = fpR.rows[0] || {};
      recAfm  = p.afm || null;
      recName = `${p.eponymo || ''} ${p.onoma || ''}`.trim();
      recDoy  = p.doy || null;
      recAddr = [p.odos, p.arithmos, p.tk, p.poli].filter(Boolean).join(', ');
    } else if (invoice.nomiko_prosopo_id) {
      const npR = await client.query(
        `SELECT afm, doy, eponymia, odos, arithmos, tk, poli
           FROM nomika_prosopa WHERE aa = $1`,
        [invoice.nomiko_prosopo_id]
      );
      const p = npR.rows[0] || {};
      recAfm  = p.afm || null;
      recName = p.eponymia || null;
      recDoy  = p.doy || null;
      recAddr = [p.odos, p.arithmos, p.tk, p.poli].filter(Boolean).join(', ');
    }

    const fullNumber = `${series.name}/${nextNum}`;

    await client.query(
      `UPDATE invoices SET
         status         = 'issued',
         number         = $1,
         series_name    = $2,
         full_number    = $3,
         issued_at      = NOW(),
         issuer_afm       = $4,
         issuer_eponymia  = $5,
         issuer_odos      = $6,
         issuer_arithmos  = $7,
         issuer_tk        = $8,
         issuer_poli      = $9,
         issuer_doy       = $10,
         issuer_kad       = $11,
         recipient_afm     = $12,
         recipient_name    = $13,
         recipient_doy     = $14,
         recipient_address = $15,
         updated_at        = NOW()
       WHERE aa = $16`,
      [
        nextNum, series.name, fullNumber,
        iss.afm || null, iss.eponymia || null,
        iss.odos || null, iss.arithmos || null, iss.tk || null, iss.poli || null,
        iss.doy || null, iss.kad || null,
        recAfm, recName, recDoy, recAddr,
        req.params.id,
      ]
    );

    await client.query('COMMIT');
    const full = await loadInvoice(req.params.id, orgId);
    res.json({ data: full });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[invoices issue]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/:id/cancel', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const reason = req.body?.reason || null;
  try {
    const r = await pool.query(
      `UPDATE invoices
          SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1, updated_at = NOW()
        WHERE aa = $2 AND organization_id = $3 AND status = 'issued'
        RETURNING *`,
      [reason, req.params.id, orgId]
    );
    if (r.rows.length === 0) return res.status(400).json({ error: 'Δεν υπάρχει ή δεν είναι εκδοθέν' });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[invoices cancel]', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const cur = await pool.query(
      `SELECT status FROM invoices WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, orgId]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (cur.rows[0].status !== 'draft') return res.status(400).json({ error: 'Μόνο drafts διαγράφονται.' });
    await pool.query(`DELETE FROM invoices WHERE aa = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error('[invoices delete]', err);
    res.status(500).json({ error: err.message });
  }
});

// Pre-fill draft from case fees/hours
router.post('/from-case/:caseId', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  const caseId = parseInt(req.params.caseId, 10);

  try {
    const cR = await pool.query(
      `SELECT * FROM ypotheseis WHERE aa = $1 AND organization_id = $2`,
      [caseId, orgId]
    );
    if (cR.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    const c = cR.rows[0];

    // Load fees (amoives) and hours (ores) for this case
    const feesR  = await pool.query(
      `SELECT date, perigrafi, amount FROM amoives WHERE ypothesi_id = $1 ORDER BY date`,
      [caseId]
    ).catch(() => ({ rows: [] }));
    const hoursR = await pool.query(
      `SELECT date, perigrafi, ores, amount FROM ores WHERE ypothesi_id = $1 ORDER BY date`,
      [caseId]
    ).catch(() => ({ rows: [] }));

    const lines = [];
    for (const f of feesR.rows) {
      lines.push({
        description: f.perigrafi || `Αμοιβή ${f.date || ''}`.trim(),
        quantity: 1,
        unit_price: Number(f.amount) || 0,
        vat_rate: 24,
      });
    }
    for (const h of hoursR.rows) {
      if (h.ores && h.amount) {
        lines.push({
          description: h.perigrafi || `Ώρες εργασίας ${h.date || ''}`.trim(),
          quantity: Number(h.ores),
          unit_price: round2(Number(h.amount) / Number(h.ores)),
          vat_rate: 24,
        });
      } else if (h.amount) {
        lines.push({
          description: h.perigrafi || `Εργασία ${h.date || ''}`.trim(),
          quantity: 1,
          unit_price: Number(h.amount),
          vat_rate: 24,
        });
      }
    }

    const settingsR = await pool.query(
      `SELECT default_vat_rate, default_withhold, default_stamp, default_tn
         FROM organization_settings WHERE organization_id = $1`,
      [orgId]
    );
    const defs = settingsR.rows[0] || { default_vat_rate: 24, default_withhold: true, default_stamp: false, default_tn: false };

    if (defs.default_vat_rate) {
      lines.forEach(l => { if (l.vat_rate == null) l.vat_rate = Number(defs.default_vat_rate); });
    }

    // Delegate to POST logic
    const draft = {
      date: new Date().toISOString().slice(0, 10),
      fysiko_prosopo_id: c.fysiko_prosopo_id,
      nomiko_prosopo_id: c.nomiko_prosopo_id,
      ypothesi_id: caseId,
      apply_withhold: !!defs.default_withhold,
      apply_stamp:    !!defs.default_stamp,
      apply_tn:       !!defs.default_tn,
      lines,
      notes: `Αφορά την υπόθεση ${c.xeirokinito_id || `#${caseId}`}`,
    };

    // Simulate direct create
    const totals = recomputeTotals(draft.lines, draft.apply_withhold, draft.apply_stamp, draft.apply_tn);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invR = await client.query(
        `INSERT INTO invoices (
           organization_id, date, fysiko_prosopo_id, nomiko_prosopo_id, ypothesi_id,
           subtotal, vat_total, withhold_total, stamp_total, tn_total, total_gross, total_net,
           apply_withhold, apply_stamp, apply_tn, notes, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          orgId, draft.date, draft.fysiko_prosopo_id, draft.nomiko_prosopo_id, draft.ypothesi_id,
          totals.subtotal, totals.vat_total, totals.withhold_total, totals.stamp_total, totals.tn_total,
          totals.total_gross, totals.total_net,
          draft.apply_withhold, draft.apply_stamp, draft.apply_tn, draft.notes,
          req.user.sub || req.user.id || null,
        ]
      );
      const invId = invR.rows[0].aa;
      for (const line of totals.lines) {
        await client.query(
          `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, vat_rate, subtotal, vat_amount, line_total, line_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [invId, line.description, line.quantity, line.unit_price, line.vat_rate,
           line.subtotal, line.vat_amount, line.line_total, line.line_order]
        );
      }
      await client.query('COMMIT');
      const full = await loadInvoice(invId, orgId);
      res.status(201).json({ data: full });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[invoices from-case]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
