const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

// --- Δικαστήρια ---
router.get('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const filters = ['organization_id = $1'];
  const params  = [orgId];
  let i = 2;
  if (req.query.q) {
    filters.push(`(name ILIKE $${i} OR edra ILIKE $${i})`);
    params.push(`%${req.query.q}%`); i++;
  }
  if (req.query.vathmos) { filters.push(`vathmos = $${i}`); params.push(req.query.vathmos); i++; }
  if (req.query.eidos)   { filters.push(`eidos   = $${i}`); params.push(req.query.eidos);   i++; }

  try {
    const r = await pool.query(
      `SELECT * FROM dikastiria WHERE ${filters.join(' AND ')} ORDER BY vathmos, name LIMIT 1000`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  const data = pickAllowed(req.body || {}, ['name','vathmos','eidos','edra']);
  if (!data.name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await pool.query(
      `INSERT INTO dikastiria (organization_id, name, vathmos, eidos, edra)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.organization_id, data.name, data.vathmos || null, data.eidos || null, data.edra || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  const data = pickAllowed(req.body || {}, ['name','vathmos','eidos','edra']);
  const cols = Object.keys(data);
  if (cols.length === 0) return res.status(400).json({ error: 'no fields' });
  const set  = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), req.params.id, req.user.organization_id];
  try {
    const r = await pool.query(
      `UPDATE dikastiria SET ${set}
        WHERE aa = $${cols.length + 1} AND organization_id = $${cols.length + 2}
        RETURNING *`, vals
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM dikastiria WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Τμήματα ---
router.get('/tmimata/list', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM dikastiria_tmimata WHERE organization_id = $1 ORDER BY name`,
      [req.user.organization_id]
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tmimata', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await pool.query(
      `INSERT INTO dikastiria_tmimata (organization_id, name) VALUES ($1,$2) RETURNING *`,
      [req.user.organization_id, name]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Δικαστές ---
router.get('/judges/list', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM dikastiria_dikastes WHERE organization_id = $1 ORDER BY eponymo, onoma`,
      [req.user.organization_id]
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/judges', async (req, res) => {
  const { eponymo, onoma } = req.body || {};
  if (!eponymo) return res.status(400).json({ error: 'eponymo required' });
  try {
    const r = await pool.query(
      `INSERT INTO dikastiria_dikastes (organization_id, eponymo, onoma) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.organization_id, eponymo, onoma || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Γραμματείς ---
router.get('/clerks/list', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM dikastiria_grammateis WHERE organization_id = $1 ORDER BY eponymo, onoma`,
      [req.user.organization_id]
    );
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/clerks', async (req, res) => {
  const { eponymo, onoma } = req.body || {};
  if (!eponymo) return res.status(400).json({ error: 'eponymo required' });
  try {
    const r = await pool.query(
      `INSERT INTO dikastiria_grammateis (organization_id, eponymo, onoma) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.organization_id, eponymo, onoma || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
