// Ενοποιημένο route για: dikigoroi_grafeiou, dikigoroi_antidikon, antidikoi, sxetika_prosopa

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pickAllowed } = require('../utils/query');

const router = express.Router();
router.use(requireAuth);

function makeCrud(basePath, table, fields, requiredField, orderBy, opts = {}) {
  const r = express.Router();

  // opts.select      -> custom SELECT (π.χ. με JOIN για ονόματα lookup)
  // opts.extraWhere  -> fn(req, params, nextIndex) -> { clauses[], params[], next }
  // opts.limit       -> default 500

  r.get('/', async (req, res) => {
    const orgId = req.user.organization_id;
    const alias = opts.select ? 't.' : '';
    const filters = [`${alias}organization_id = $1`];
    const params  = [orgId];
    let i = 2;

    if (req.query.q) {
      const searchable = ['eponymo','onoma','eponymia','email'].filter(f => fields.includes(f));
      if (searchable.length) {
        filters.push(`(${searchable.map(f => `${alias}${f} ILIKE $${i}`).join(' OR ')})`);
        params.push(`%${req.query.q}%`); i++;
      }
    }
    if (req.query.energos === 'true'  && fields.includes('energos')) filters.push(`${alias}energos = TRUE`);
    if (req.query.energos === 'false' && fields.includes('energos')) filters.push(`${alias}energos = FALSE`);

    // Επιπλέον φίλτρα ανά πίνακα
    if (typeof opts.extraWhere === 'function') {
      const ex = opts.extraWhere(req, i);
      if (ex && ex.clauses && ex.clauses.length) {
        filters.push(...ex.clauses);
        params.push(...ex.params);
        i = ex.next;
      }
    }

    const select = opts.select || `SELECT * FROM ${table} t`;
    // Ήταν 500 -> σε γραφεία με πολλούς αντιδίκους η λίστα κοβόταν
    // αλφαβητικά (σταματούσε γύρω στο "Ι") και δεν έβρισκες τους υπόλοιπους.
    const limit  = opts.limit || 5000;

    try {
      const q = await pool.query(
        `${select} WHERE ${filters.join(' AND ')} ORDER BY ${orderBy} LIMIT ${limit}`,
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

// ---------------------------------------------------------------------------
// ΣΧΕΤΙΚΑ ΠΡΟΣΩΠΑ
// Επιπλέον από το βασικό CRUD:
//   * idiotita_id   — τι ΕΙΝΑΙ ο άνθρωπος (δικηγόρος, συμβολαιογράφος...)
//   * paratiriseis  — εσωτερικές σημειώσεις/αξιολόγηση
//   * φίλτρα: ?idiotita_id=  &poli=   (γεωγραφικό)
//   * GET /related/cities        — οι πόλεις που υπάρχουν, για το φίλτρο
//   * GET /related/:id/cases     — σε ποιες υποθέσεις εμφανίζεται
// ---------------------------------------------------------------------------

// ΠΡΟΣΟΧΗ: αυτά τα routes ΠΡΕΠΕΙ να δηλωθούν ΠΡΙΝ το makeCrud('/related'),
// αλλιώς το γενικό GET /:id θα «έτρωγε» το /cities.
const relatedExtra = express.Router();

// Λίστα πόλεων (γραφείου ή οικίας) για το γεωγραφικό φίλτρο
relatedExtra.get('/cities', async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT poli, COUNT(*)::int AS plithos FROM (
         SELECT COALESCE(NULLIF(TRIM(poli_grafeiou), ''), NULLIF(TRIM(poli_oikias), '')) AS poli
         FROM sxetika_prosopa
         WHERE organization_id = $1
       ) x
       WHERE poli IS NOT NULL
       GROUP BY poli
       ORDER BY plithos DESC, poli`,
      [req.user.organization_id]
    );
    res.json({ data: q.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Σε ποιες υποθέσεις εμφανίζεται αυτό το πρόσωπο
relatedExtra.get('/:id/cases', async (req, res) => {
  const orgId = req.user.organization_id;
  const pid = parseInt(req.params.id, 10);
  if (!pid) return res.status(400).json({ error: 'bad id' });
  try {
    const q = await pool.query(
      `SELECT DISTINCT
              y.aa,
              y.xeirokinito_id,
              y.perilipsi,
              y.date_eisagogis,
              y.ekkremis,
              es.name AS eidos_sxesis_name
         FROM ypotheseis y
         LEFT JOIN case_related_persons crp
                ON crp.ypothesi_id = y.aa AND crp.sxetiko_prosopo_id = $2
         LEFT JOIN eidos_sxesis es ON es.aa = crp.eidos_sxesis_id
        WHERE y.organization_id = $1
          AND (crp.sxetiko_prosopo_id = $2
               OR y.aa = (SELECT ypotheseis_id FROM sxetika_prosopa
                           WHERE aa = $2 AND organization_id = $1))
        ORDER BY y.aa DESC
        LIMIT 5000`,
      [orgId, pid]
    );
    res.json({ data: q.rows });
  } catch (err) {
    console.error('[related/:id/cases]', err);
    res.status(500).json({ error: err.message });
  }
});

router.use('/related', relatedExtra);

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
   'eidos_sxesis_id','ypotheseis_id',
   'idiotita_id','paratiriseis'],
  null,
  't.eponymo, t.onoma',
  {
    // Φέρνουμε και τα ονόματα των lookup, για να μη χρειάζεται δεύτερη κλήση
    select: `SELECT t.*,
                    idt.name AS idiotita_name,
                    es.name  AS eidos_sxesis_name,
                    COALESCE(NULLIF(TRIM(t.poli_grafeiou), ''), NULLIF(TRIM(t.poli_oikias), '')) AS poli
               FROM sxetika_prosopa t
               LEFT JOIN idiotites    idt ON idt.aa = t.idiotita_id     AND idt.organization_id = t.organization_id
               LEFT JOIN eidos_sxesis es  ON es.aa  = t.eidos_sxesis_id AND es.organization_id  = t.organization_id`,
    extraWhere: (req, i) => {
      const clauses = [], params = [];

      // ΔΙΑΧΩΡΙΣΜΟΣ ΑΝΤΙΔΙΚΩΝ
      // Η αρχική migration έβαλε τους αντιδίκους ΚΑΙ στους δύο πίνακες:
      // 1142 στο `antidikoi` και 1568 στα `sxetika_prosopa` με είδος
      // σχέσης «Αντίδικος». Από τους 1568 μόνο 2 συνδέονται με υπόθεση.
      // Είναι διπλοεγγραφές που μπερδεύουν τη λίστα σχετικών προσώπων.
      //
      // Εξ ορισμού ΔΕΝ εμφανίζονται εδώ. Με ?include_opponents=1 φαίνονται.
      if (req.query.include_opponents !== '1') {
        clauses.push(`(es.name IS NULL OR es.name <> 'Αντίδικος')`);
      }

      // Φίλτρο ιδιότητας
      if (req.query.idiotita_id) {
        if (req.query.idiotita_id === 'none') {
          clauses.push('t.idiotita_id IS NULL');
        } else {
          clauses.push(`t.idiotita_id = $${i}`);
          params.push(parseInt(req.query.idiotita_id, 10)); i++;
        }
      }
      // Γεωγραφικό φίλτρο — γραφείο Ή οικία
      if (req.query.poli) {
        clauses.push(
          `(TRIM(COALESCE(t.poli_grafeiou, '')) ILIKE $${i} OR TRIM(COALESCE(t.poli_oikias, '')) ILIKE $${i})`
        );
        params.push(req.query.poli); i++;
      }
      return { clauses, params, next: i };
    },
  }
);

module.exports = router;
