// src/routes/nomika.js
// Νομικά πρόσωπα CRUD.
// v2: προσθήκη 11 fields (credentials + ιδιοκτησία), encryption για TAXIS/ΔΕΗ/ΓΕΜΗ passwords.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');
const { ensureColumns, NOMIKA_EXTRA_FIELDS } = require('../routes/client-extras');
const { transformFields, ENCRYPTED_FIELDS_NOMIKA } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);

const CORE_FIELDS = [
  'diakritikos_titlos', 'eponymia', 'afm', 'doy', 'gemi',
  'email', 'web_site', 'energos',
  'odos', 'arithmos', 'tk', 'poli', 'xora',
  'tilefono_grafeiou_1', 'tilefono_grafeiou_2', 'tilefono_grafeiou_3',
  'tilefono_kinito_1', 'tilefono_kinito_2', 'tilefono_kinito_3',
  'fax_1', 'fax_2', 'fax_3',
];
const FIELDS = [...CORE_FIELDS, ...NOMIKA_EXTRA_FIELDS];

// GET /api/nomika?q=&energos=true|false&limit=&slim=1
// v3 FIX: το LIMIT 500 έκοβε τη λίστα αλφαβητικά. Νέο default 10000, ?limit= ρυθμιζόμενο.
// v3 FIX: αναζήτηση και σε ΓΕΜΗ.
// v3 NEW: ?slim=1 για dropdowns.
router.get('/', async (req, res) => {
  await ensureColumns();
  const orgId = req.user.organization_id;
  const filters = ['organization_id = $1'];
  const params  = [orgId];
  let i = 2;

  if (req.query.q) {
    filters.push(`(
      eponymia ILIKE $${i}
      OR diakritikos_titlos ILIKE $${i}
      OR afm ILIKE $${i}
      OR gemi ILIKE $${i}
    )`);
    params.push(`%${String(req.query.q).trim()}%`); i++;
  }
  if (req.query.energos === 'true')  filters.push('energos = TRUE');
  if (req.query.energos === 'false') filters.push('energos = FALSE');

  const where = filters.join(' AND ');
  const limit = Math.min(50000, Math.max(1, parseInt(req.query.limit || '10000', 10)));
  const slim  = req.query.slim === '1';
  const cols  = slim ? 'aa, eponymia, diakritikos_titlos, afm, energos' : '*';

  try {
    const countR = await pool.query(
      `SELECT COUNT(*)::int AS c FROM nomika_prosopa WHERE ${where}`, params
    );
    const r = await pool.query(
      `SELECT ${cols} FROM nomika_prosopa WHERE ${where}
       ORDER BY eponymia LIMIT ${limit}`,
      params
    );
    // Στη λίστα δεν επιστρέφουμε passwords
    const rows = slim
      ? r.rows
      : r.rows.map(row => ({ ...row, taxis_password: null, dei_password: null, gemi_password: null }));
    res.json({ data: rows, total: countR.rows[0].c, returned: rows.length, limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  await ensureColumns();
  try {
    const r = await pool.query(
      `SELECT * FROM nomika_prosopa WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(transformFields(r.rows[0], ENCRYPTED_FIELDS_NOMIKA, 'decrypt'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  await ensureColumns();
  const orgId = req.user.organization_id;
  let data = pickAllowed(req.body || {}, FIELDS);
  if (!data.eponymia) return res.status(400).json({ error: 'eponymia required' });

  data = transformFields(data, ENCRYPTED_FIELDS_NOMIKA, 'encrypt');

  const cols = ['organization_id', ...Object.keys(data)];
  const vals = [orgId, ...Object.values(data)];
  const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    const r = await pool.query(
      `INSERT INTO nomika_prosopa (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    res.status(201).json(transformFields(r.rows[0], ENCRYPTED_FIELDS_NOMIKA, 'decrypt'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  await ensureColumns();
  const orgId = req.user.organization_id;
  let data = pickAllowed(req.body || {}, FIELDS);
  const cols = Object.keys(data);
  if (cols.length === 0) return res.status(400).json({ error: 'no fields to update' });

  data = transformFields(data, ENCRYPTED_FIELDS_NOMIKA, 'encrypt');

  const set  = Object.keys(data).map((c, i) => `${c} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), req.params.id, orgId];

  try {
    const r = await pool.query(
      `UPDATE nomika_prosopa SET ${set}, updated_at = NOW()
        WHERE aa = $${cols.length + 1} AND organization_id = $${cols.length + 2}
        RETURNING *`,
      vals
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(transformFields(r.rows[0], ENCRYPTED_FIELDS_NOMIKA, 'decrypt'));
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
