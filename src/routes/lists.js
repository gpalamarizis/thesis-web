// Generic CRUD για όλες τις "λίστες" (lookup tables) του παλιού VB.NET app.
// Χρησιμοποιείται από τη σελίδα "Επεξεργασία λιστών" του frontend.
//
// Endpoints:
//   GET    /api/lists/:list              → όλες οι εγγραφές
//   POST   /api/lists/:list              → δημιουργία
//   PUT    /api/lists/:list/:id          → ενημέρωση
//   DELETE /api/lists/:list/:id          → διαγραφή
//   GET    /api/lists                    → κατάλογος διαθέσιμων λιστών

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

// Ορισμός επιτρεπτών λιστών + πεδίων + default order.
const LISTS = {
  diadikasies: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  thesi: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  ypotheseis_onomasies: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  theseis_arxeiothetisis: {
    fields: ['name', 'perigrafi'],
    required: ['name'],
    order: 'name',
  },
  eidos_sxesis: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  pagia_exoda: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  amoives: {
    fields: ['name', 'amount'],
    required: ['name'],
    order: 'name',
  },
  cities: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  countries: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  address_type: {
    fields: ['address_type'],
    required: ['address_type'],
    order: 'address_type',
  },
  phone_types: {
    fields: ['phone_type'],
    required: ['phone_type'],
    order: 'phone_type',
  },
  dikastiria_exelixi_energeias: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  dikastiria_tmimata: {
    fields: ['name'],
    required: ['name'],
    order: 'name',
  },
  dikastiria_dikastes: {
    fields: ['eponymo', 'onoma'],
    required: ['eponymo'],
    order: 'eponymo, onoma',
  },
  dikastiria_grammateis: {
    fields: ['eponymo', 'onoma'],
    required: ['eponymo'],
    order: 'eponymo, onoma',
  },
};

// GET /api/lists → κατάλογος των διαθέσιμων λιστών
router.get('/', (_req, res) => {
  res.json({
    lists: Object.keys(LISTS).map((k) => ({
      name: k,
      fields: LISTS[k].fields,
    })),
  });
});

// helper: pull config or 404
function cfg(listName, res) {
  const c = LISTS[listName];
  if (!c) {
    res.status(404).json({ error: `Unknown list: ${listName}` });
    return null;
  }
  return c;
}

// GET /api/lists/:list
router.get('/:list', async (req, res) => {
  const c = cfg(req.params.list, res);
  if (!c) return;
  try {
    const r = await pool.query(
      `SELECT * FROM ${req.params.list}
        WHERE organization_id = $1
        ORDER BY ${c.order}
        LIMIT 5000`,
      [req.user.organization_id]
    );
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/lists/:list
router.post('/:list', async (req, res) => {
  const c = cfg(req.params.list, res);
  if (!c) return;

  const data = pickAllowed(req.body || {}, c.fields);
  for (const r of c.required) {
    if (!data[r] || String(data[r]).trim() === '') {
      return res.status(400).json({ error: `Missing required field: ${r}` });
    }
  }

  const cols = ['organization_id', ...Object.keys(data)];
  const vals = [req.user.organization_id, ...Object.values(data)];
  const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    const r = await pool.query(
      `INSERT INTO ${req.params.list} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/lists/:list/:id
router.put('/:list/:id', async (req, res) => {
  const c = cfg(req.params.list, res);
  if (!c) return;

  const data = pickAllowed(req.body || {}, c.fields);
  const cols = Object.keys(data);
  if (cols.length === 0) {
    return res.status(400).json({ error: 'No editable fields provided' });
  }
  const set  = cols.map((col, i) => `${col} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), req.params.id, req.user.organization_id];

  try {
    const r = await pool.query(
      `UPDATE ${req.params.list} SET ${set}
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

// DELETE /api/lists/:list/:id
router.delete('/:list/:id', async (req, res) => {
  const c = cfg(req.params.list, res);
  if (!c) return;

  try {
    const r = await pool.query(
      `DELETE FROM ${req.params.list}
        WHERE aa = $1 AND organization_id = $2
        RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) {
    // πιθανό FK violation (λ.χ. thesi χρησιμοποιείται σε ypotheseis)
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'Cannot delete: record is in use',
        detail: err.detail,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
