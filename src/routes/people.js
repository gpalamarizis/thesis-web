// Ενοποιημένο route για: dikigoroi_grafeiou, dikigoroi_antidikon, antidikoi, sxetika_prosopa

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

function makeCrud(basePath, table, fields, requiredField, orderBy) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const orgId = req.user.organization_id;
    const filters = ['organization_id = $1'];
    const params  = [orgId];
    let i = 2;
    if (req.query.q) {
      filters.push(`(${['eponymo','onoma','eponymia','email'].filter(f=>fields.includes(f)).map(f=>`${f} ILIKE $${i}`).join(' OR ')})`);
      params.push(`%${req.query.q}%`); i++;
    }
    if (req.query.energos === 'true'  && fields.includes('energos')) filters.push('energos = TRUE');
    if (req.query.energos === 'false' && fields.includes('energos')) filters.push('energos = FALSE');

    try {
      const q = await pool.query(
        `SELECT * FROM ${table} WHERE ${filters.join(' AND ')} ORDER BY ${orderBy} LIMIT 500`,
        params
      );
      res.json({ data: q.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/:id', async (req, res) => {
    try {
      const q = await pool.query(
        `SELECT * FROM ${table} WHERE aa = $1 AND organization_id = $2`,
        [req.params.id, req.user.organization_id]
      );
      if (q.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(q.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/', async (req, res) => {
    const data = pickAllowed(req.body || {}, fields);
    if (requiredField && !data[requiredField]) {
      return res.status(400).json({ error: `${requiredField} required` });
    }
    const cols = ['organization_id', ...Object.keys(data)];
    const vals = [req.user.organization_id, ...Object.values(data)];
    const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');
    try {
      const q = await pool.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
        vals
      );
      res.status(201).json(q.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.put('/:id', async (req, res) => {
    const data = pickAllowed(req.body || {}, fields);
    const cols = Object.keys(data);
    if (cols.length === 0) return res.status(400).json({ error: 'no fields' });
    const set  = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const vals = [...Object.values(data), req.params.id, req.user.organization_id];
    try {
      const q = await pool.query(
        `UPDATE ${table} SET ${set}
          WHERE aa = $${cols.length + 1} AND organization_id = $${cols.length + 2}
          RETURNING *`,
        vals
      );
      if (q.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(q.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const q = await pool.query(
        `DELETE FROM ${table} WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
        [req.params.id, req.user.organization_id]
      );
      if (q.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ deleted: q.rows[0].aa });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.use(basePath, r);
}

// Δικηγόροι Γραφείου
makeCrud(
  '/lawyers',
  'dikigoroi_grafeiou',
  ['eponymo','onoma','onoma_patros','eponymo_syzygou','onoma_syzygou','date_gennisis',
   'adt','afm','doy','energos','date_eggrafis','date_diagrafis','ar_mitroou','syllogos',
   'email','mobile','exoterikos'],
  'eponymo',
  'eponymo, onoma'
);

// Δικηγόροι Αντιδίκων
makeCrud(
  '/opposing-lawyers',
  'dikigoroi_antidikon',
  ['eponymo','onoma','email','tilefono','syllogos'],
  'eponymo',
  'eponymo'
);

// Αντίδικοι
makeCrud(
  '/opponents',
  'antidikoi',
  ['eponymo','onoma','telefono','email'],
  'eponymo',
  'eponymo'
);

// Σχετικά Πρόσωπα
makeCrud(
  '/related',
  'sxetika_prosopa',
  ['eponymia','diakritikos_titlos','eponymo','onoma','onoma_patros','eponymo_syzygou','onoma_syzygou',
   'date_gennisis','afm','doy','adt','ekdousa_arxi','email','web_site','energos',
   'odos_oikias','arithmos_oikias','tk_oikias','poli_oikias','xora_oikias',
   'odos_grafeiou','arithmos_grafeiou','tk_grafeiou','poli_grafeiou','xora_grafeiou',
   'tilefono_oikias_1','tilefono_oikias_2','tilefono_oikias_3',
   'tilefono_grafeiou_1','tilefono_grafeiou_2','tilefono_grafeiou_3',
   'tilefono_kinito_1','tilefono_kinito_2','tilefono_kinito_3',
   'fax_1','fax_2','fax_3',
   'eidos_sxesis_id','ypotheseis_id'],
  null,
  'eponymo, onoma'
);

module.exports = router;
