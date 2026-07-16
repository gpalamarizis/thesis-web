// src/routes/fysika.js
// Φυσικά πρόσωπα CRUD.
// v2: προσθήκη 12 fields (φορολογικά + credentials + ιδιοκτησία), encryption για TAXIS/ΔΕΗ passwords.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');
const { ensureColumns, FYSIKA_EXTRA_FIELDS } = require('../routes/client-extras');
const { transformFields, ENCRYPTED_FIELDS_FYSIKA } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);

const CORE_FIELDS = [
  'eponymo', 'onoma', 'onoma_patros', 'eponymo_syzygou', 'onoma_syzygou',
  'date_gennisis', 'afm', 'doy', 'adt', 'ekdousa_arxi',
  'email', 'web_site', 'energos',
  'odos_oikias', 'arithmos_oikias', 'tk_oikias', 'poli_oikias', 'xora_oikias',
  'odos_grafeiou', 'arithmos_grafeiou', 'tk_grafeiou', 'poli_grafeiou', 'xora_grafeiou',
  'tilefono_oikias_1', 'tilefono_oikias_2', 'tilefono_oikias_3',
  'tilefono_grafeiou_1', 'tilefono_grafeiou_2', 'tilefono_grafeiou_3',
  'tilefono_kinito_1', 'tilefono_kinito_2', 'tilefono_kinito_3',
  'fax_1', 'fax_2', 'fax_3',
];
const FIELDS = [...CORE_FIELDS, ...FYSIKA_EXTRA_FIELDS];

// GET /api/fysika?q=&energos=true|false
router.get('/', async (req, res) => {
  await ensureColumns();
  const orgId = req.user.organization_id;
  const filters = ['organization_id = $1'];
  const params  = [orgId];
  let i = 2;

  if (req.query.q) {
    filters.push(`(eponymo ILIKE $${i} OR onoma ILIKE $${i} OR afm ILIKE $${i})`);
    params.push(`%${req.query.q}%`); i++;
  }
  if (req.query.energos === 'true')  filters.push('energos = TRUE');
  if (req.query.energos === 'false') filters.push('energos = FALSE');

  try {
    const r = await pool.query(
      `SELECT * FROM fysika_prosopa WHERE ${filters.join(' AND ')}
       ORDER BY eponymo, onoma LIMIT 500`,
      params
    );
    // NOTE: στη λίστα ΔΕΝ επιστρέφουμε passwords για ασφάλεια — τα μηδενίζουμε.
    const rows = r.rows.map(row => ({ ...row, taxis_password: null, dei_password: null, adt: null }));
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fysika/:id
router.get('/:id', async (req, res) => {
  await ensureColumns();
  try {
    const r = await pool.query(
      `SELECT * FROM fysika_prosopa WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    // Decrypt sensitive fields πριν την επιστροφή
    const row = transformFields(r.rows[0], ENCRYPTED_FIELDS_FYSIKA, 'decrypt');
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fysika
router.post('/', async (req, res) => {
  await ensureColumns();
  const orgId = req.user.organization_id;
  let data = pickAllowed(req.body || {}, FIELDS);
  if (!data.eponymo) return res.status(400).json({ error: 'eponymo required' });

  // Encrypt sensitive fields πριν το insert
  data = transformFields(data, ENCRYPTED_FIELDS_FYSIKA, 'encrypt');

  const cols = ['organization_id', ...Object.keys(data)];
  const vals = [orgId, ...Object.values(data)];
  const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    const r = await pool.query(
      `INSERT INTO fysika_prosopa (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    // Decrypt πριν την επιστροφή ώστε ο client να δει τα plain values
    res.status(201).json(transformFields(r.rows[0], ENCRYPTED_FIELDS_FYSIKA, 'decrypt'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fysika/:id
router.put('/:id', async (req, res) => {
  await ensureColumns();
  const orgId = req.user.organization_id;
  let data = pickAllowed(req.body || {}, FIELDS);
  const cols = Object.keys(data);
  if (cols.length === 0) return res.status(400).json({ error: 'no fields to update' });

  data = transformFields(data, ENCRYPTED_FIELDS_FYSIKA, 'encrypt');

  const set  = Object.keys(data).map((c, i) => `${c} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), req.params.id, orgId];

  try {
    const r = await pool.query(
      `UPDATE fysika_prosopa SET ${set}, updated_at = NOW()
        WHERE aa = $${cols.length + 1} AND organization_id = $${cols.length + 2}
        RETURNING *`,
      vals
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(transformFields(r.rows[0], ENCRYPTED_FIELDS_FYSIKA, 'decrypt'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fysika/:id
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM fysika_prosopa WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
