const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

const FIELDS = [
  'diakritikos_titlos', 'eponymia', 'afm', 'doy', 'gemi',
  'email', 'web_site', 'energos',
  'odos', 'arithmos', 'tk', 'poli', 'xora',
  'tilefono_grafeiou_1', 'tilefono_grafeiou_2', 'tilefono_grafeiou_3',
  'tilefono_kinito_1', 'tilefono_kinito_2', 'tilefono_kinito_3',
  'fax_1', 'fax_2', 'fax_3',
];

router.get('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const filters = ['organization_id = $1'];
  const params  = [orgId];
  let i = 2;

  if (req.query.q) {
    filters.push(`(eponymia ILIKE $${i} OR diakritikos_titlos ILIKE $${i} OR afm ILIKE $${i})`);
    params.push(`%${req.query.q}%`); i++;
  }
  if (req.query.energos === 'true')  filters.push('energos = TRUE');
  if (req.query.energos === 'false') filters.push('energos = FALSE');

  try {
    const r = await pool.query(
      `SELECT * FROM nomika_prosopa WHERE ${filters.join(' AND ')}
       ORDER BY eponymia LIMIT 500`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM nomika_prosopa WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const data = pickAllowed(req.body || {}, FIELDS);
  if (!data.eponymia) return res.status(400).json({ error: 'eponymia required' });

  const cols = ['organization_id', ...Object.keys(data)];
  const vals = [orgId, ...Object.values(data)];
  const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    const r = await pool.query(
      `INSERT INTO nomika_prosopa (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  const data = pickAllowed(req.body || {}, FIELDS);
  const cols = Object.keys(data);
  if (cols.length === 0) return res.status(400).json({ error: 'no fields to update' });

  const set  = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), req.params.id, orgId];

  try {
    const r = await pool.query(
      `UPDATE nomika_prosopa SET ${set}, updated_at = NOW()
        WHERE aa = $${cols.length + 1} AND organization_id = $${cols.length + 2}
        RETURNING *`,
      vals
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM nomika_prosopa WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
