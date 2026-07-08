const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

const DIK_FIELDS = [
  'ypothesi_id','name','date','dikastirio_id','tmima_id','city_id',
  'antidikos_id','diadikasia_id','pinakio',
  'dikigoros_antidikou_id','dikastis_id','grammateas_id',
];

// ---------- Δικαστικές ενέργειες ----------

// GET /api/actions/court?ypothesi_id=..
router.get('/court', async (req, res) => {
  const orgId = req.user.organization_id;
  const filters = ['de.organization_id = $1'];
  const params  = [orgId];
  let i = 2;
  if (req.query.ypothesi_id) {
    filters.push(`de.ypothesi_id = $${i}`); params.push(req.query.ypothesi_id); i++;
  }
  if (req.query.from) { filters.push(`de.date >= $${i}`); params.push(req.query.from); i++; }
  if (req.query.to)   { filters.push(`de.date <= $${i}`); params.push(req.query.to);   i++; }

  try {
    const r = await pool.query(
      `SELECT de.*,
              d.name AS dikastirio_name,
              t.name AS tmima_name,
              c.name AS city_name,
              di.name AS diadikasia_name,
              a.eponymo AS antidikos_eponymo,
              da.eponymo AS dikigoros_antidikou_eponymo,
              dk.eponymo AS dikastis_eponymo, dk.onoma AS dikastis_onoma,
              gr.eponymo AS grammateas_eponymo, gr.onoma AS grammateas_onoma,
              y.xeirokinito_id AS xeirokinito_id
         FROM dikastiria_energeies de
    LEFT JOIN dikastiria           d  ON d.aa  = de.dikastirio_id
    LEFT JOIN dikastiria_tmimata   t  ON t.aa  = de.tmima_id
    LEFT JOIN cities               c  ON c.aa  = de.city_id
    LEFT JOIN diadikasies          di ON di.aa = de.diadikasia_id
    LEFT JOIN antidikoi            a  ON a.aa  = de.antidikos_id
    LEFT JOIN dikigoroi_antidikon  da ON da.aa = de.dikigoros_antidikou_id
    LEFT JOIN dikastiria_dikastes  dk ON dk.aa = de.dikastis_id
    LEFT JOIN dikastiria_grammateis gr ON gr.aa = de.grammateas_id
    LEFT JOIN ypotheseis           y  ON y.aa  = de.ypothesi_id
        WHERE ${filters.join(' AND ')}
        ORDER BY de.date DESC LIMIT 500`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/court', async (req, res) => {
  const data = pickAllowed(req.body || {}, DIK_FIELDS);
  if (!data.ypothesi_id || !data.date) return res.status(400).json({ error: 'ypothesi_id + date required' });

  const cols = ['organization_id', ...Object.keys(data)];
  const vals = [req.user.organization_id, ...Object.values(data)];
  const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');
  try {
    const r = await pool.query(
      `INSERT INTO dikastiria_energeies (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/court/:id', async (req, res) => {
  const data = pickAllowed(req.body || {}, DIK_FIELDS);
  const cols = Object.keys(data);
  if (cols.length === 0) return res.status(400).json({ error: 'no fields' });
  const set  = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), req.params.id, req.user.organization_id];
  try {
    const r = await pool.query(
      `UPDATE dikastiria_energeies SET ${set}
        WHERE aa = $${cols.length + 1} AND organization_id = $${cols.length + 2}
        RETURNING *`, vals);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/court/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM dikastiria_energeies WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Εξελίξεις δικαστικών ενεργειών ----------
router.get('/court/:id/progress', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT dee.*, ex.name AS exelixi_name, dg.eponymo AS dikigoros_eponymo, dg.onoma AS dikigoros_onoma
         FROM dikastiria_energeies_exelixeis dee
    LEFT JOIN dikastiria_exelixi_energeias ex ON ex.aa = dee.exelixi_id
    LEFT JOIN dikigoroi_grafeiou           dg ON dg.aa = dee.dikigoros_id
        WHERE dee.dikastiki_energeia_id = $1 AND dee.organization_id = $2
        ORDER BY dee.date`,
      [req.params.id, req.user.organization_id]
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/court/:id/progress', async (req, res) => {
  const b = req.body || {};
  try {
    const r = await pool.query(
      `INSERT INTO dikastiria_energeies_exelixeis
         (organization_id, dikastiki_energeia_id, name, date, exelixi_id,
          dikigoros_id, dikos_mas, dateend, stamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        req.user.organization_id, req.params.id, b.name || null, b.date || null,
        b.exelixi_id || null, b.dikigoros_id || null, b.dikos_mas !== false,
        b.dateend || null, b.stamp || 0,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Λοιπές ενέργειες (tasks per case) ----------

// GET /api/actions/other?ypothesi_id=..&pending=true
router.get('/other', async (req, res) => {
  const orgId = req.user.organization_id;
  const filters = ['e.organization_id = $1'];
  const params  = [orgId];
  let i = 2;
  if (req.query.ypothesi_id) {
    filters.push(`e.ypotheseis_id = $${i}`); params.push(req.query.ypothesi_id); i++;
  }
  if (req.query.pending === 'true') filters.push('e.ekkremis = TRUE');

  try {
    const r = await pool.query(
      `SELECT e.*, y.xeirokinito_id
         FROM energeies e
    LEFT JOIN ypotheseis y ON y.aa = e.ypotheseis_id
        WHERE ${filters.join(' AND ')}
        ORDER BY e.date_dead_line NULLS LAST LIMIT 500`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/other', async (req, res) => {
  const b = req.body || {};
  if (!b.ypotheseis_id) return res.status(400).json({ error: 'ypotheseis_id required' });
  try {
    const r = await pool.query(
      `INSERT INTO energeies (organization_id, ypotheseis_id, perigrafi_energias, date_dead_line, ekkremis)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.organization_id, b.ypotheseis_id, b.perigrafi_energias || null,
       b.date_dead_line || null, b.ekkremis !== false]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/other/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE energeies SET
         perigrafi_energias = COALESCE($1, perigrafi_energias),
         date_dead_line     = COALESCE($2, date_dead_line),
         ekkremis           = COALESCE($3, ekkremis)
       WHERE aa = $4 AND organization_id = $5 RETURNING *`,
      [b.perigrafi_energias ?? null, b.date_dead_line ?? null,
       typeof b.ekkremis === 'boolean' ? b.ekkremis : null,
       req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/other/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM energeies WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
