const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

let courtActionColumnsEnsured = false;
async function ensureCourtActionColumns() {
  if (courtActionColumnsEnsured) return;
  try {
    await pool.query(`
      ALTER TABLE dikastiria_energeies
        ADD COLUMN IF NOT EXISTS date_apofasis DATE,
        ADD COLUMN IF NOT EXISTS ekkremis      BOOLEAN DEFAULT TRUE;
    `);
    courtActionColumnsEnsured = true;
  } catch (err) {
    console.error('[ensureCourtActionColumns]', err);
  }
}

const DIK_FIELDS = [
  'ypothesi_id','name','date','dikastirio_id','tmima_id','city_id',
  'antidikos_id','diadikasia_id','pinakio',
  'dikigoros_antidikou_id','dikastis_id','grammateas_id',
  'date_apofasis','ekkremis',
];

// ---------- Δικαστικές ενέργειες ----------

// GET /api/actions/court?ypothesi_id=..
router.get('/court', async (req, res) => {
  await ensureCourtActionColumns();
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
  await ensureCourtActionColumns();
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
  await ensureCourtActionColumns();
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
  await ensureCourtActionColumns();
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

// ---------- Λοιπές ενέργειες (tasks per case) - legacy /other endpoints ----------

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
// TASK ROUTES (Λοιπές ενέργειες - energeies table)
// Multi-dikigoros via energeies_dikigoroi junction → dikigoroi_grafeiou
// =============================================================================

// Fields that can be updated on the energeies row itself (dikigoroi handled separately)
const ENERGEIA_FIELDS = [
  'ypotheseis_id', 'date_dead_line', 'perigrafi_energias', 'ekkremis'
];

// Helper: sanitize dikigoroi_ids input to unique array of positive integers
function normalizeDikigoroiIds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const v of input) {
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// Helper: verify all dikigoroi_ids belong to the org (prevents cross-tenant leakage)
async function verifyDikigoroiOwnership(client, orgId, ids) {
  if (ids.length === 0) return true;
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM dikigoroi_grafeiou
      WHERE organization_id = $1 AND aa = ANY($2::int[])`,
    [orgId, ids]
  );
  return r.rows[0].c === ids.length;
}

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
              COALESCE(
                (SELECT json_agg(
                          json_build_object(
                            'id',       d.aa,
                            'onoma',    d.onoma,
                            'eponymo',  d.eponymo,
                            'fullname', TRIM(CONCAT_WS(' ', d.eponymo, d.onoma))
                          )
                          ORDER BY d.eponymo, d.onoma
                        )
                   FROM energeies_dikigoroi ed
                   JOIN dikigoroi_grafeiou  d ON d.aa = ed.dikigoroi_grafeiou_id
                  WHERE ed.energeia_id = e.aa),
                '[]'::json
              ) AS dikigoroi
         FROM energeies e
         LEFT JOIN ypotheseis y ON y.aa = e.ypotheseis_id
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

  const dikigoroiIds = normalizeDikigoroiIds(body.dikigoroi_ids);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify case belongs to org
    const check = await client.query(
      'SELECT aa FROM ypotheseis WHERE aa = $1 AND organization_id = $2',
      [parseInt(ypId, 10), orgId]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Case not found' });
    }

    // Verify all dikigoroi belong to this org (prevent cross-tenant assignment)
    const owns = await verifyDikigoroiOwnership(client, orgId, dikigoroiIds);
    if (!owns) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid dikigoros reference' });
    }

    // Insert the energeia row
    const ins = await client.query(
      `INSERT INTO energeies (organization_id, ypotheseis_id, perigrafi_energias, date_dead_line, ekkremis)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING aa`,
      [
        orgId,
        parseInt(ypId, 10),
        body.perigrafi_energias || null,
        body.date_dead_line || null,
        body.ekkremis !== false,
      ]
    );
    const energeiaId = ins.rows[0].aa;

    // Insert junction rows (if any)
    if (dikigoroiIds.length > 0) {
      const values = dikigoroiIds
        .map((_, idx) => `($1, $2, $${idx + 3})`)
        .join(', ');
      await client.query(
        `INSERT INTO energeies_dikigoroi (organization_id, energeia_id, dikigoroi_grafeiou_id)
         VALUES ${values}
         ON CONFLICT (energeia_id, dikigoroi_grafeiou_id) DO NOTHING`,
        [orgId, energeiaId, ...dikigoroiIds]
      );
    }

    await client.query('COMMIT');

    // Fetch the full row with aggregated dikigoroi
    const full = await pool.query(
      `SELECT e.*,
              COALESCE(
                (SELECT json_agg(
                          json_build_object(
                            'id',       d.aa,
                            'onoma',    d.onoma,
                            'eponymo',  d.eponymo,
                            'fullname', TRIM(CONCAT_WS(' ', d.eponymo, d.onoma))
                          )
                          ORDER BY d.eponymo, d.onoma
                        )
                   FROM energeies_dikigoroi ed
                   JOIN dikigoroi_grafeiou  d ON d.aa = ed.dikigoroi_grafeiou_id
                  WHERE ed.energeia_id = e.aa),
                '[]'::json
              ) AS dikigoroi
         FROM energeies e
        WHERE e.aa = $1`,
      [energeiaId]
    );
    res.status(201).json({ data: full.rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[actions/task create]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/actions/task/:id
router.put('/task/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  const body = req.body || {};
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: 'Invalid id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify ownership via join
    const own = await client.query(
      `SELECT e.aa FROM energeies e
         JOIN ypotheseis y ON y.aa = e.ypotheseis_id
        WHERE e.aa = $1 AND y.organization_id = $2`,
      [taskId, orgId]
    );
    if (own.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    // Update scalar fields on energeies (only those provided)
    const fields = [];
    const params = [];
    let i = 1;
    if (body.date_dead_line !== undefined) {
      fields.push(`date_dead_line = $${i++}`);
      params.push(body.date_dead_line || null);
    }
    if (body.perigrafi_energias !== undefined) {
      fields.push(`perigrafi_energias = $${i++}`);
      params.push(body.perigrafi_energias || null);
    }
    if (body.ekkremis !== undefined) {
      fields.push(`ekkremis = $${i++}`);
      params.push(!!body.ekkremis);
    }

    if (fields.length > 0) {
      params.push(taskId);
      await client.query(
        `UPDATE energeies SET ${fields.join(', ')} WHERE aa = $${i}`,
        params
      );
    }

    // Sync dikigoroi if the field was provided (empty array = clear all)
    if (body.dikigoroi_ids !== undefined) {
      const dikigoroiIds = normalizeDikigoroiIds(body.dikigoroi_ids);
      const owns = await verifyDikigoroiOwnership(client, orgId, dikigoroiIds);
      if (!owns) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid dikigoros reference' });
      }
      // Clear existing
      await client.query(
        'DELETE FROM energeies_dikigoroi WHERE energeia_id = $1',
        [taskId]
      );
      // Insert new (if any)
      if (dikigoroiIds.length > 0) {
        const values = dikigoroiIds
          .map((_, idx) => `($1, $2, $${idx + 3})`)
          .join(', ');
        await client.query(
          `INSERT INTO energeies_dikigoroi (organization_id, energeia_id, dikigoroi_grafeiou_id)
           VALUES ${values}
           ON CONFLICT (energeia_id, dikigoroi_grafeiou_id) DO NOTHING`,
          [orgId, taskId, ...dikigoroiIds]
        );
      }
    }

    await client.query('COMMIT');

    // Return updated row with aggregated dikigoroi
    const full = await pool.query(
      `SELECT e.*,
              COALESCE(
                (SELECT json_agg(
                          json_build_object(
                            'id',       d.aa,
                            'onoma',    d.onoma,
                            'eponymo',  d.eponymo,
                            'fullname', TRIM(CONCAT_WS(' ', d.eponymo, d.onoma))
                          )
                          ORDER BY d.eponymo, d.onoma
                        )
                   FROM energeies_dikigoroi ed
                   JOIN dikigoroi_grafeiou  d ON d.aa = ed.dikigoroi_grafeiou_id
                  WHERE ed.energeia_id = e.aa),
                '[]'::json
              ) AS dikigoroi
         FROM energeies e
        WHERE e.aa = $1`,
      [taskId]
    );
    res.json({ data: full.rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[actions/task update]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/actions/task/:id  (junction rows cascade automatically)
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
