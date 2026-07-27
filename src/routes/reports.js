// Reports (Αναφορές) - από το menu "Αναφορές" του παλιού VB.NET app:
//   • Εκκρεμείς υποθέσεις                     GET /api/reports/pending
//   • Ημερολόγιο δικαστικών ενεργειών         GET /api/reports/upcoming-hearings
//   • Ημερολόγιο λοιπών ενεργειών (tasks)     GET /api/reports/pending-tasks

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { buildReportDocx, sendDocx } = require('../utils/docxReport');

const router = express.Router();

// --- Word export helpers ---------------------------------------------------

// Επιστρέφει το όνομα του γραφείου για την επικεφαλίδα. Αν αποτύχει, κενό.
async function orgName(orgId) {
  for (const pk of ['id', 'aa']) {
    try {
      const r = await pool.query(`SELECT * FROM organizations WHERE ${pk} = $1 LIMIT 1`, [orgId]);
      if (r.rows.length) {
        const o = r.rows[0];
        return o.name || o.eponymia || o.epwnymia || o.title || '';
      }
      return '';
    } catch (e) { /* δοκίμασε το επόμενο pk */ }
  }
  return '';
}

// Μετατρέπει τα query params σε αναγνώσιμα κριτήρια για την επικεφαλίδα
function describeFilters(q) {
  const out = [];
  if (q.q)             out.push(`Κείμενο: ${q.q}`);
  if (q.dikigoros_id)  out.push(`Δικηγόρος #${q.dikigoros_id}`);
  if (q.antidikos_id)  out.push(`Αντίδικος #${q.antidikos_id}`);
  if (q.onomasia_id)   out.push(`Είδος υπόθεσης #${q.onomasia_id}`);
  if (q.diadikasia_id) out.push(`Διαδικασία #${q.diadikasia_id}`);
  if (q.dikastirio_id) out.push(`Δικαστήριο #${q.dikastirio_id}`);
  if (q.from)          out.push(`Από: ${q.from}`);
  if (q.to)            out.push(`Έως: ${q.to}`);
  if (q.ekkremis === 'false') out.push('Περιλαμβάνονται ολοκληρωμένες');
  return out;
}

function docxFilename(base) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.docx`;
}
router.use(requireAuth);

// ---- Εκκρεμείς υποθέσεις ----
// GET /api/reports/pending?dikigoros_id=&q=
router.get('/pending', async (req, res) => {
  const orgId = req.user.organization_id;
  const filters = ['y.organization_id = $1', 'y.ekkremis = TRUE'];
  const params  = [orgId];
  let i = 2;

  if (req.query.q) {
    filters.push(`(
      y.xeirokinito_id ILIKE $${i}
      OR y.perilipsi ILIKE $${i}
      OR y.onomasia_fakelou ILIKE $${i}
      OR fp.eponymo ILIKE $${i}
      OR fp.onoma ILIKE $${i}
      OR np.eponymia ILIKE $${i}
      OR a.eponymo ILIKE $${i}
    )`);
    params.push(`%${req.query.q}%`); i++;
  }

  // v3: Είδος υπόθεσης (ypotheseis_onomasies)
  if (req.query.onomasia_id) {
    filters.push(`y.onomasia_id = $${i}`);
    params.push(parseInt(req.query.onomasia_id, 10)); i++;
  }

  // v3: Αντίδικος - είτε της υπόθεσης, είτε σε δικαστική ενέργεια
  if (req.query.antidikos_id) {
    filters.push(`(
      y.diadikos_id = $${i}
      OR EXISTS (SELECT 1 FROM dikastiria_energeies de3
                  WHERE de3.ypothesi_id = y.aa
                    AND de3.organization_id = y.organization_id
                    AND de3.antidikos_id = $${i})
    )`);
    params.push(parseInt(req.query.antidikos_id, 10)); i++;
  }

  // v3 FIX: το JOIN αντικαταστάθηκε με EXISTS ώστε
  //   (α) να μην πολλαπλασιάζονται οι γραμμές όταν η υπόθεση έχει >1 χειριστή
  //   (β) να ταιριάζει ΚΑΙ ο χειριστής της υπόθεσης ΚΑΙ ο δικηγόρος
  //       συγκεκριμένης δικαστικής ενέργειας
  const joinXeir = '';
  if (req.query.dikigoros_id) {
    filters.push(`(
      EXISTS (SELECT 1 FROM xeiristes_dikigoroi xd
               WHERE xd.ypotheseis_id = y.aa
                 AND xd.organization_id = y.organization_id
                 AND xd.dikigoroi_grafeiou_id = $${i})
      OR EXISTS (SELECT 1 FROM dikastiria_energeies de2
                  JOIN dikastiria_dikigoroi dd2 ON dd2.dikastiki_energeia_id = de2.aa
                 WHERE de2.ypothesi_id = y.aa
                   AND de2.organization_id = y.organization_id
                   AND dd2.dikigoros_id = $${i})
    )`);
    params.push(parseInt(req.query.dikigoros_id, 10)); i++;
  }

  try {
    const r = await pool.query(
      `SELECT
         y.aa,
         y.xeirokinito_id,
         y.date_eisagogis,
         y.perilipsi,
         y.onomasia_fakelou,
         COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma,''), np.eponymia) AS pelatis,
         a.eponymo AS antidikos,
         yo.name   AS onomasia_name,
         COALESCE((
           SELECT string_agg(dg.eponymo || ' ' || COALESCE(dg.onoma,''), ', ' ORDER BY dg.eponymo)
             FROM xeiristes_dikigoroi xd
             JOIN dikigoroi_grafeiou dg ON dg.aa = xd.dikigoroi_grafeiou_id
            WHERE xd.ypotheseis_id = y.aa
              AND xd.organization_id = y.organization_id
         ), '') AS xeiristes
       FROM ypotheseis y
       ${joinXeir}
       LEFT JOIN fysika_prosopa       fp ON fp.aa = y.fysiko_prosopo_id
       LEFT JOIN nomika_prosopa       np ON np.aa = y.nomiko_prosopo_id
       LEFT JOIN antidikoi            a  ON a.aa  = y.diadikos_id
       LEFT JOIN ypotheseis_onomasies yo ON yo.aa = y.onomasia_id
       WHERE ${filters.join(' AND ')}
       ORDER BY y.date_eisagogis DESC NULLS LAST, y.aa DESC
       LIMIT 5000`,
      params
    );
    if (req.query.format === 'docx') {
      const buf = buildReportDocx({
        title: 'Εκκρεμείς Υποθέσεις',
        subtitle: await orgName(orgId),
        filters: describeFilters(req.query),
        columns: [
          { key: 'xeirokinito_id',  label: 'Πρωτόκολλο',     width: 1000 },
          { key: 'date_eisagogis',  label: 'Εισαγωγή',       width: 900, type: 'date' },
          { key: 'onomasia_name',   label: 'Είδος υπόθεσης', width: 1600 },
          { key: 'pelatis',         label: 'Πελάτης',        width: 1700 },
          { key: 'antidikos',       label: 'Αντίδικος',      width: 1500 },
          { key: 'xeiristes',       label: 'Χειριστές',      width: 1700 },
          { key: 'perilipsi',       label: 'Περίληψη',       width: 2400 },
        ],
        rows: r.rows,
        landscape: true,
      });
      return sendDocx(res, buf, docxFilename('Ekkremeis-Ypotheseis'));
    }
    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('[reports/pending]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Ημερολόγιο δικαστικών ενεργειών ----
// GET /api/reports/upcoming-hearings?from=YYYY-MM-DD&to=YYYY-MM-DD&dikigoros_id=
router.get('/upcoming-hearings', async (req, res) => {
  const orgId = req.user.organization_id;
  const filters = ['de.organization_id = $1'];
  const params  = [orgId];
  let i = 2;

  if (req.query.from) { filters.push(`de.date >= $${i}`); params.push(req.query.from); i++; }
  if (req.query.to)   { filters.push(`de.date <= $${i}`); params.push(req.query.to);   i++; }
  if (!req.query.from && !req.query.to) {
    // default: από σήμερα και μετά
    filters.push(`de.date >= CURRENT_DATE`);
  }

  // v3: Αντίδικος
  if (req.query.antidikos_id) {
    filters.push(`(de.antidikos_id = $${i} OR EXISTS (
      SELECT 1 FROM ypotheseis y2
       WHERE y2.aa = de.ypothesi_id AND y2.diadikos_id = $${i}))`);
    params.push(parseInt(req.query.antidikos_id, 10)); i++;
  }

  // v3: Δικαστήριο / Διαδικασία ως ανεξάρτητα φίλτρα
  if (req.query.dikastirio_id) {
    filters.push(`de.dikastirio_id = $${i}`);
    params.push(parseInt(req.query.dikastirio_id, 10)); i++;
  }
  if (req.query.diadikasia_id) {
    filters.push(`de.diadikasia_id = $${i}`);
    params.push(parseInt(req.query.diadikasia_id, 10)); i++;
  }

  // v3 FIX: ΑΥΤΟ ήταν το bug των "προσεχών δικασίμων".
  // Το παλιό JOIN κοίταζε ΜΟΝΟ τον dikastiria_dikigoroi (δικηγόρος της
  // συγκεκριμένης δικαστικής ενέργειας), ο οποίος ήταν ΚΕΝΟΣ.
  // Ο χειριστής της ΥΠΟΘΕΣΗΣ ζει σε άλλον πίνακα (xeiristes_dikigoroi).
  // Τώρα ταιριάζει και στα δύο.
  const joinDikig = '';
  if (req.query.dikigoros_id) {
    filters.push(`(
      EXISTS (SELECT 1 FROM dikastiria_dikigoroi dd
               WHERE dd.dikastiki_energeia_id = de.aa
                 AND dd.dikigoros_id = $${i})
      OR EXISTS (SELECT 1 FROM xeiristes_dikigoroi xd
                  WHERE xd.ypotheseis_id = de.ypothesi_id
                    AND xd.organization_id = de.organization_id
                    AND xd.dikigoroi_grafeiou_id = $${i})
    )`);
    params.push(parseInt(req.query.dikigoros_id, 10)); i++;
  }

  try {
    const r = await pool.query(
      `SELECT
         de.aa,
         de.date,
         de.name AS perigrafi,
         de.pinakio,
         d.name  AS dikastirio_name,
         t.name  AS tmima_name,
         c.name  AS city_name,
         di.name AS diadikasia_name,
         y.aa    AS ypothesi_id,
         y.xeirokinito_id,
         COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma,''), np.eponymia) AS pelatis,
         a.eponymo AS antidikos,
         yo.name AS onomasia_name,
         COALESCE((
           SELECT string_agg(dg.eponymo || ' ' || COALESCE(dg.onoma,''), ', ' ORDER BY dg.eponymo)
             FROM dikastiria_dikigoroi dd
             JOIN dikigoroi_grafeiou dg ON dg.aa = dd.dikigoros_id
            WHERE dd.dikastiki_energeia_id = de.aa
         ), '') AS dikigoroi_energeias,
         COALESCE((
           SELECT string_agg(dg.eponymo || ' ' || COALESCE(dg.onoma,''), ', ' ORDER BY dg.eponymo)
             FROM xeiristes_dikigoroi xd
             JOIN dikigoroi_grafeiou dg ON dg.aa = xd.dikigoroi_grafeiou_id
            WHERE xd.ypotheseis_id = de.ypothesi_id
              AND xd.organization_id = de.organization_id
         ), '') AS xeiristes
       FROM dikastiria_energeies de
       ${joinDikig}
       LEFT JOIN dikastiria         d  ON d.aa  = de.dikastirio_id
       LEFT JOIN dikastiria_tmimata t  ON t.aa  = de.tmima_id
       LEFT JOIN cities             c  ON c.aa  = de.city_id
       LEFT JOIN diadikasies        di ON di.aa = de.diadikasia_id
       LEFT JOIN ypotheseis         y  ON y.aa  = de.ypothesi_id
       LEFT JOIN ypotheseis_onomasies yo ON yo.aa = y.onomasia_id
       LEFT JOIN fysika_prosopa     fp ON fp.aa = y.fysiko_prosopo_id
       LEFT JOIN nomika_prosopa     np ON np.aa = y.nomiko_prosopo_id
       LEFT JOIN antidikoi          a  ON a.aa  = de.antidikos_id
       WHERE ${filters.join(' AND ')}
       ORDER BY de.date ASC, y.xeirokinito_id
       LIMIT 5000`,
      params
    );
    if (req.query.format === 'docx') {
      const buf = buildReportDocx({
        title: 'Προσεχείς Δικάσιμοι',
        subtitle: await orgName(orgId),
        filters: describeFilters(req.query),
        columns: [
          { key: 'date',            label: 'Ημ/νία',       width: 900, type: 'date' },
          { key: 'xeirokinito_id',  label: 'Πρωτόκολλο',   width: 1000 },
          { key: 'dikastirio_name', label: 'Δικαστήριο',   width: 1600 },
          { key: 'tmima_name',      label: 'Τμήμα',        width: 1100 },
          { key: 'diadikasia_name', label: 'Διαδικασία',   width: 1200 },
          { key: 'pelatis',         label: 'Πελάτης',      width: 1600 },
          { key: 'antidikos',       label: 'Αντίδικος',    width: 1400 },
          { key: 'xeiristes',       label: 'Χειριστές',    width: 1500 },
          { key: 'pinakio',         label: 'Πινάκιο',      width: 700 },
        ],
        rows: r.rows,
        landscape: true,
      });
      return sendDocx(res, buf, docxFilename('Prosexeis-Dikasimoi'));
    }
    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('[reports/upcoming-hearings]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Ημερολόγιο λοιπών ενεργειών (tasks / energeies) ----
// GET /api/reports/pending-tasks?from=&to=&dikigoros_id=&ekkremis=true|false
router.get('/pending-tasks', async (req, res) => {
  const orgId = req.user.organization_id;
  const filters = ['e.organization_id = $1'];
  const params  = [orgId];
  let i = 2;

  if (req.query.ekkremis !== 'false') {
    filters.push('e.ekkremis = TRUE');   // default: μόνο εκκρεμείς
  }
  if (req.query.from) { filters.push(`e.date_dead_line >= $${i}`); params.push(req.query.from); i++; }
  if (req.query.to)   { filters.push(`e.date_dead_line <= $${i}`); params.push(req.query.to);   i++; }

  // v3 FIX: το σχόλιο δήλωνε ότι δέχεται dikigoros_id αλλά ΔΕΝ ήταν υλοποιημένο.
  // Ταιριάζει (α) με τον δικηγόρο της ΙΔΙΑΣ της ενέργειας (energeies_loipes_dikigoroi)
  //          (β) με τον χειριστή της υπόθεσης στην οποία ανήκει η ενέργεια.
  if (req.query.dikigoros_id) {
    filters.push(`(
      EXISTS (SELECT 1 FROM energeies_loipes_dikigoroi eld
               WHERE eld.loiph_energeia_id = e.aa
                 AND eld.organization_id = e.organization_id
                 AND eld.lawyer_id = $${i})
      OR EXISTS (SELECT 1 FROM xeiristes_dikigoroi xd
                  WHERE xd.ypotheseis_id = e.ypotheseis_id
                    AND xd.organization_id = e.organization_id
                    AND xd.dikigoroi_grafeiou_id = $${i})
    )`);
    params.push(parseInt(req.query.dikigoros_id, 10)); i++;
  }

  // v3: Είδος υπόθεσης
  if (req.query.onomasia_id) {
    filters.push(`EXISTS (SELECT 1 FROM ypotheseis y2
                           WHERE y2.aa = e.ypotheseis_id
                             AND y2.onomasia_id = $${i})`);
    params.push(parseInt(req.query.onomasia_id, 10)); i++;
  }

  // v3: Αντίδικος
  if (req.query.antidikos_id) {
    filters.push(`EXISTS (SELECT 1 FROM ypotheseis y3
                           WHERE y3.aa = e.ypotheseis_id
                             AND y3.diadikos_id = $${i})`);
    params.push(parseInt(req.query.antidikos_id, 10)); i++;
  }

  try {
    const r = await pool.query(
      `SELECT
         e.aa,
         e.date_dead_line,
         e.perigrafi_energias,
         e.ekkremis,
         y.aa AS ypothesi_id,
         y.xeirokinito_id,
         COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma,''), np.eponymia) AS pelatis,
         yo.name AS onomasia_name,
         a.eponymo AS antidikos,
         COALESCE((
           SELECT string_agg(dg.eponymo || ' ' || COALESCE(dg.onoma,''), ', ' ORDER BY dg.eponymo)
             FROM energeies_loipes_dikigoroi eld
             JOIN dikigoroi_grafeiou dg ON dg.aa = eld.lawyer_id
            WHERE eld.loiph_energeia_id = e.aa
              AND eld.organization_id = e.organization_id
         ), '') AS dikigoroi_energeias,
         COALESCE((
           SELECT string_agg(dg.eponymo || ' ' || COALESCE(dg.onoma,''), ', ' ORDER BY dg.eponymo)
             FROM xeiristes_dikigoroi xd
             JOIN dikigoroi_grafeiou dg ON dg.aa = xd.dikigoroi_grafeiou_id
            WHERE xd.ypotheseis_id = y.aa
              AND xd.organization_id = y.organization_id
         ), '') AS xeiristes
       FROM energeies e
       JOIN ypotheseis y ON y.aa = e.ypotheseis_id
       LEFT JOIN ypotheseis_onomasies yo ON yo.aa = y.onomasia_id
       LEFT JOIN antidikoi      a  ON a.aa  = y.diadikos_id
       LEFT JOIN fysika_prosopa fp ON fp.aa = y.fysiko_prosopo_id
       LEFT JOIN nomika_prosopa np ON np.aa = y.nomiko_prosopo_id
       WHERE ${filters.join(' AND ')}
       ORDER BY e.date_dead_line ASC NULLS LAST
       LIMIT 5000`,
      params
    );
    if (req.query.format === 'docx') {
      const buf = buildReportDocx({
        title: 'Λοιπές Ενέργειες',
        subtitle: await orgName(orgId),
        filters: describeFilters(req.query),
        columns: [
          { key: 'date_dead_line',      label: 'Προθεσμία',      width: 900, type: 'date' },
          { key: 'xeirokinito_id',      label: 'Πρωτόκολλο',     width: 1000 },
          { key: 'perigrafi_energias',  label: 'Ενέργεια',       width: 2600 },
          { key: 'onomasia_name',       label: 'Είδος υπόθεσης', width: 1500 },
          { key: 'pelatis',             label: 'Πελάτης',        width: 1600 },
          { key: 'antidikos',           label: 'Αντίδικος',      width: 1300 },
          { key: 'dikigoroi_energeias', label: 'Δικηγόροι ενέργειας', width: 1500 },
          { key: 'xeiristes',           label: 'Χειριστές',      width: 1500 },
        ],
        rows: r.rows,
        landscape: true,
      });
      return sendDocx(res, buf, docxFilename('Loipes-Energeies'));
    }
    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('[reports/pending-tasks]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Στατιστικά dashboard ----
// GET /api/reports/summary
router.get('/summary', async (req, res) => {
  const orgId = req.user.organization_id;
  try {
    const [cases, ekkr, hearings30, tasks] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM ypotheseis WHERE organization_id=$1`, [orgId]),
      pool.query(`SELECT COUNT(*)::int AS c FROM ypotheseis WHERE organization_id=$1 AND ekkremis=TRUE`, [orgId]),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM dikastiria_energeies
          WHERE organization_id=$1 AND date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30`,
        [orgId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM energeies
          WHERE organization_id=$1 AND ekkremis=TRUE
            AND (date_dead_line IS NULL OR date_dead_line >= CURRENT_DATE)`,
        [orgId]
      ),
    ]);
    res.json({
      total_cases:        cases.rows[0].c,
      pending_cases:      ekkr.rows[0].c,
      hearings_next_30d:  hearings30.rows[0].c,
      open_tasks:         tasks.rows[0].c,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
