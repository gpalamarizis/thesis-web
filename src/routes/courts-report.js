// src/routes/courts-report.js
// Αναφορά Δικαστηρίων: όλες οι υποθέσεις ανά δικαστήριο με φίλτρα.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/reports/courts-report?date_from=YYYY-MM-DD&date_to=...&court_id=...&status=all|pending|closed
router.get('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const { date_from, date_to, court_id, status } = req.query;

  const filters = ['ca.organization_id = $1'];
  const params = [orgId];
  let i = 2;

  if (date_from) { filters.push(`ca.date_action >= $${i}`); params.push(date_from); i++; }
  if (date_to)   { filters.push(`ca.date_action <= $${i}`); params.push(date_to);   i++; }
  if (court_id)  { filters.push(`ca.court_id = $${i}`);      params.push(parseInt(court_id, 10)); i++; }
  if (status === 'pending') filters.push(`ca.ekkremis = TRUE`);
  if (status === 'closed')  filters.push(`ca.ekkremis = FALSE`);

  try {
    // Group by court
    const r = await pool.query(`
      SELECT
        c.aa       AS court_id,
        c.name     AS court_name,
        c.diadikasia,
        c.city,
        COUNT(ca.aa)::int                                        AS total_actions,
        COUNT(*) FILTER (WHERE ca.ekkremis = TRUE)::int          AS pending,
        COUNT(*) FILTER (WHERE ca.ekkremis = FALSE)::int         AS closed,
        json_agg(json_build_object(
          'action_id',    ca.aa,
          'date_action',  ca.date_action,
          'ekkremis',     ca.ekkremis,
          'ar_pinakiou',  ca.ar_pinakiou,
          'apofasi_num',  ca.arithmos_apofasis,
          'ypothesi_id',  y.aa,
          'xeirokinito',  y.xeirokinito_id,
          'perilipsi',    y.perilipsi,
          'client_name',  COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma, ''), np.eponymia)
        ) ORDER BY ca.date_action DESC) AS actions
      FROM court_actions ca
      JOIN ypotheseis y ON y.aa = ca.ypothesi_id
      LEFT JOIN courts c ON c.aa = ca.court_id
      LEFT JOIN fysika_prosopa fp ON fp.aa = y.fysiko_prosopo_id
      LEFT JOIN nomika_prosopa np ON np.aa = y.nomiko_prosopo_id
      WHERE ${filters.join(' AND ')}
      GROUP BY c.aa, c.name, c.diadikasia, c.city
      ORDER BY c.name ASC
    `, params);

    // Summary totals
    const total_actions = r.rows.reduce((a, x) => a + x.total_actions, 0);
    const total_pending = r.rows.reduce((a, x) => a + x.pending, 0);
    const total_closed  = r.rows.reduce((a, x) => a + x.closed, 0);

    res.json({
      data: r.rows,
      summary: { total_courts: r.rows.length, total_actions, total_pending, total_closed },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/courts-report/filters — για UI dropdowns
router.get('/filters', async (req, res) => {
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(`
      SELECT DISTINCT c.aa, c.name, c.city, c.diadikasia
        FROM courts c
        JOIN court_actions ca ON ca.court_id = c.aa
       WHERE ca.organization_id = $1
       ORDER BY c.name`, [orgId]);
    res.json({ courts: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
