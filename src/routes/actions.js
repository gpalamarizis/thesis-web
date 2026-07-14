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
// =============================================================================
// ADD THIS TO src/routes/actions.js (BACKEND)
// Paste anywhere after the existing court routes, BEFORE the `module.exports = router;`
// =============================================================================

// ---------- Λοιπές ενέργειες (energeies table) ----------

const ENERGEIA_FIELDS = [
  'ypotheseis_id', 'date_dead_line', 'perigrafi_energias', 'ekkremis', 'dikigoros_id'
];

// GET /api/actions/task?ypothesi_id=..  (accepts both ypothesi_id and ypotheseis_id)
router.get('/task', async (req, res) => {
  const orgId = req.user.organization_id;
  const ypId = req.query.ypothesi_id || req.query.ypotheseis_id;
  const filters = ['y.organization_id = $1'];
  const params  = [orgId];
  let i = 2;
  if (ypId) {
    filters.push(`e.ypotheseis_id = $${i}`); params.push(parseInt(ypId, 10)); i++;
  }
  if (req.query.from) { filters.push(`e.date_dead_line >= $${i}`); params.push(req.query.from); i++; }
  if (req.query.to)   { filters.push(`e.date_dead_line <= $${i}`); params.push(req.query.to);   i++; }
  if (req.query.ekkremis !== undefined) {
    filters.push(`e.ekkremis = $${i}`);
    params.push(req.query.ekkremis === 'true' || req.query.ekkremis === '1');
    i++;
  }
  try {
    const r = await pool.query(
      `SELECT e.*,
              y.xeirokinito_id,
              CONCAT_WS(' ', u.first_name, u.last_name) AS dikigoros_name
         FROM energeies e
         LEFT JOIN ypotheseis y ON y.aa = e.ypotheseis_id
         LEFT JOIN users u ON u.id = e.dikigoros_id
        WHERE ${filters.join(' AND ')}
        ORDER BY e.date_dead_line ASC NULLS LAST LIMIT 500`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[actions/task list]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/actions/task
router.post('/task', async (req, res) => {
  const orgId = req.user.organization_id;
  const body = req.body || {};
  const ypId = body.ypothesi_id || body.ypotheseis_id;
  if (!ypId) return res.status(400).json({ error: 'ypothesi_id required' });

  try {
    // verify case belongs to org
    const check = await pool.query(
      'SELECT aa FROM ypotheseis WHERE aa = $1 AND organization_id = $2',
      [parseInt(ypId, 10), orgId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

    const r = await pool.query(
      `INSERT INTO energeies (ypotheseis_id, date_dead_line, perigrafi_energias, ekkremis, dikigoros_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        parseInt(ypId, 10),
        body.date_dead_line || null,
        body.perigrafi_energias || null,
        body.ekkremis !== false,
        body.dikigoros_id ? parseInt(body.dikigoros_id, 10) : null,
      ]
    );
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    console.error('[actions/task create]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/actions/task/:id
router.put('/task/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  const body = req.body || {};
  try {
    // Verify ownership via join
    const own = await pool.query(
      `SELECT e.aa FROM energeies e
         JOIN ypotheseis y ON y.aa = e.ypotheseis_id
        WHERE e.aa = $1 AND y.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const fields = [];
    const params = [];
    let i = 1;
    if (body.date_dead_line !== undefined)     { fields.push(`date_dead_line = $${i++}`);     params.push(body.date_dead_line); }
    if (body.perigrafi_energias !== undefined) { fields.push(`perigrafi_energias = $${i++}`); params.push(body.perigrafi_energias); }
    if (body.ekkremis !== undefined)           { fields.push(`ekkremis = $${i++}`);           params.push(!!body.ekkremis); }
    if (body.dikigoros_id !== undefined)       { fields.push(`dikigoros_id = $${i++}`);       params.push(body.dikigoros_id ? parseInt(body.dikigoros_id, 10) : null); }
    if (fields.length === 0) return res.status(400).json({ error: 'No changes' });
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE energeies SET ${fields.join(', ')} WHERE aa = $${i} RETURNING *`,
      params
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[actions/task update]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/actions/task/:id
router.delete('/task/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  try {
    const own = await pool.query(
      `SELECT e.aa FROM energeies e
         JOIN ypotheseis y ON y.aa = e.ypotheseis_id
        WHERE e.aa = $1 AND y.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM energeies WHERE aa = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error('[actions/task delete]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
