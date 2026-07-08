// Οικονομικά υπόθεσης - από το VB.NET tab "Οικονομικά" της υπόθεσης
//
// 4 πίνακες:
//   finance_ores                      → Χρέωση ωρών δικηγόρων
//   finance_pagia_exoda_case          → Πάγια έξοδα ανά υπόθεση
//   finance_amoives_dikigoron         → Αμοιβές δικηγόρων
//   finance_exoda_exoterikou_synergati→ Έξοδα εξωτερικού συνεργάτη

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

// Ορισμός των 4 finance sub-resources
const RESOURCES = {
  ores: {
    table: 'finance_ores',
    fields: ['ypothesi_id', 'dikigoros_id', 'date', 'ores', 'perigrafi', 'amount'],
    required: ['ypothesi_id'],
  },
  'pagia-exoda': {
    table: 'finance_pagia_exoda_case',
    fields: ['ypothesi_id', 'pagio_exodo_definition_id', 'date', 'amount', 'perigrafi'],
    required: ['ypothesi_id'],
  },
  amoives: {
    table: 'finance_amoives_dikigoron',
    fields: ['ypothesi_id', 'dikigoros_id', 'date', 'amount', 'perigrafi'],
    required: ['ypothesi_id'],
  },
  'exoda-synergati': {
    table: 'finance_exoda_exoterikou_synergati',
    fields: ['ypothesi_id', 'synergatis_id', 'date', 'amount', 'perigrafi'],
    required: ['ypothesi_id'],
  },
};

function cfg(name, res) {
  const c = RESOURCES[name];
  if (!c) { res.status(404).json({ error: `Unknown finance resource: ${name}` }); return null; }
  return c;
}

// GET /api/finance/:resource?ypothesi_id=..
router.get('/:resource', async (req, res) => {
  const c = cfg(req.params.resource, res);
  if (!c) return;
  const orgId = req.user.organization_id;
  const filters = ['organization_id = $1'];
  const params  = [orgId];
  let i = 2;

  if (req.query.ypothesi_id) {
    filters.push(`ypothesi_id = $${i}`);
    params.push(parseInt(req.query.ypothesi_id, 10)); i++;
  }
  if (req.query.from) { filters.push(`date >= $${i}`); params.push(req.query.from); i++; }
  if (req.query.to)   { filters.push(`date <= $${i}`); params.push(req.query.to);   i++; }

  try {
    const r = await pool.query(
      `SELECT * FROM ${c.table} WHERE ${filters.join(' AND ')} ORDER BY date DESC, aa DESC LIMIT 5000`,
      params
    );
    // aggregated sum επίσης
    const sumR = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::float AS total FROM ${c.table} WHERE ${filters.join(' AND ')}`,
      params
    );
    res.json({ data: r.rows, total: sumR.rows[0].total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finance/:resource
router.post('/:resource', async (req, res) => {
  const c = cfg(req.params.resource, res);
  if (!c) return;

  const data = pickAllowed(req.body || {}, c.fields);
  for (const r of c.required) {
    if (data[r] === undefined || data[r] === null || data[r] === '') {
      return res.status(400).json({ error: `Missing required field: ${r}` });
    }
  }

  const cols = ['organization_id', ...Object.keys(data)];
  const vals = [req.user.organization_id, ...Object.values(data)];
  const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    const r = await pool.query(
      `INSERT INTO ${c.table} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/finance/:resource/:id
router.put('/:resource/:id', async (req, res) => {
  const c = cfg(req.params.resource, res);
  if (!c) return;

  const data = pickAllowed(req.body || {}, c.fields);
  const cols = Object.keys(data);
  if (cols.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  const set  = cols.map((col, i) => `${col} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), req.params.id, req.user.organization_id];

  try {
    const r = await pool.query(
      `UPDATE ${c.table} SET ${set}
        WHERE aa = $${cols.length + 1} AND organization_id = $${cols.length + 2}
        RETURNING *`,
      vals
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/finance/:resource/:id
router.delete('/:resource/:id', async (req, res) => {
  const c = cfg(req.params.resource, res);
  if (!c) return;
  try {
    const r = await pool.query(
      `DELETE FROM ${c.table} WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
