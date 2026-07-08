// Reports (Αναφορές) - από το menu "Αναφορές" του παλιού VB.NET app:
//   • Εκκρεμείς υποθέσεις                     GET /api/reports/pending
//   • Ημερολόγιο δικαστικών ενεργειών         GET /api/reports/upcoming-hearings
//   • Ημερολόγιο λοιπών ενεργειών (tasks)     GET /api/reports/pending-tasks

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
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

  // Φίλτρο ανά χειριστή δικηγόρο
  let joinXeir = '';
  if (req.query.dikigoros_id) {
    joinXeir = `JOIN xeiristes_dikigoroi xd
                  ON xd.ypotheseis_id = y.aa
                 AND xd.dikigoroi_grafeiou_id = $${i}`;
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
         yo.name   AS onomasia_name
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

  // φίλτρο ανά χειριστή σε δικαστική ενέργεια
  let joinDikig = '';
  if (req.query.dikigoros_id) {
    joinDikig = `JOIN dikastiria_dikigoroi dd
                   ON dd.dikastiki_energeia_id = de.aa
                  AND dd.dikigoros_id = $${i}`;
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
         a.eponymo AS antidikos
       FROM dikastiria_energeies de
       ${joinDikig}
       LEFT JOIN dikastiria         d  ON d.aa  = de.dikastirio_id
       LEFT JOIN dikastiria_tmimata t  ON t.aa  = de.tmima_id
       LEFT JOIN cities             c  ON c.aa  = de.city_id
       LEFT JOIN diadikasies        di ON di.aa = de.diadikasia_id
       LEFT JOIN ypotheseis         y  ON y.aa  = de.ypothesi_id
       LEFT JOIN fysika_prosopa     fp ON fp.aa = y.fysiko_prosopo_id
       LEFT JOIN nomika_prosopa     np ON np.aa = y.nomiko_prosopo_id
       LEFT JOIN antidikoi          a  ON a.aa  = de.antidikos_id
       WHERE ${filters.join(' AND ')}
       ORDER BY de.date ASC, y.xeirokinito_id
       LIMIT 5000`,
      params
    );
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

  try {
    const r = await pool.query(
      `SELECT
         e.aa,
         e.date_dead_line,
         e.perigrafi_energias,
         e.ekkremis,
         y.aa AS ypothesi_id,
         y.xeirokinito_id,
         COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma,''), np.eponymia) AS pelatis
       FROM energeies e
       JOIN ypotheseis y ON y.aa = e.ypotheseis_id
       LEFT JOIN fysika_prosopa fp ON fp.aa = y.fysiko_prosopo_id
       LEFT JOIN nomika_prosopa np ON np.aa = y.nomiko_prosopo_id
       WHERE ${filters.join(' AND ')}
       ORDER BY e.date_dead_line ASC NULLS LAST
       LIMIT 5000`,
      params
    );
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
