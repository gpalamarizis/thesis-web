// Τηλεφωνικός κατάλογος - από το menu "Εργαλεία → Τηλεφωνικός κατάλογος"
//
// Ενοποιεί σε ένα view όλα τα πρόσωπα του γραφείου:
//   • fysika_prosopa       (πελάτες ΦΠ)
//   • nomika_prosopa       (πελάτες ΝΠ)
//   • sxetika_prosopa      (σχετικά)
//   • dikigoroi_grafeiou   (δικηγόροι γραφείου)
//   • dikigoroi_antidikon  (δικηγόροι αντιδίκων)
//   • antidikoi
//
// Πεδία εξόδου (VB.NET screen "Τηλεφωνικός κατάλογος"):
//   source, id, eponymo_or_eponymia, onoma, tilefono_grafeiou, fax, kinito, email

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/phonebook?q=&source=fysika|nomika|sxetika|dikigoroi_grafeiou|dikigoroi_antidikon|antidikoi
router.get('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const params = [orgId];

  // Χτίζουμε το UNION δυναμικά με βάση την πηγή
  const parts = [];
  const push = (label, sql) => parts.push(`SELECT '${label}' AS source, ${sql}`);

  push('fysika', `
    aa AS id,
    eponymo AS eponymo_or_eponymia,
    onoma,
    tilefono_grafeiou_1 AS tilefono_grafeiou,
    fax_1 AS fax,
    tilefono_kinito_1 AS kinito,
    email
  FROM fysika_prosopa WHERE organization_id = $1`);

  push('nomika', `
    aa AS id,
    eponymia AS eponymo_or_eponymia,
    NULL::text AS onoma,
    tilefono_grafeiou_1 AS tilefono_grafeiou,
    fax_1 AS fax,
    tilefono_kinito_1 AS kinito,
    email
  FROM nomika_prosopa WHERE organization_id = $1`);

  push('sxetika', `
    aa AS id,
    COALESCE(eponymia, eponymo) AS eponymo_or_eponymia,
    onoma,
    tilefono_grafeiou_1 AS tilefono_grafeiou,
    fax_1 AS fax,
    tilefono_kinito_1 AS kinito,
    email
  FROM sxetika_prosopa WHERE organization_id = $1`);

  push('dikigoroi_grafeiou', `
    aa AS id,
    eponymo AS eponymo_or_eponymia,
    onoma,
    NULL::text AS tilefono_grafeiou,
    NULL::text AS fax,
    mobile AS kinito,
    email
  FROM dikigoroi_grafeiou WHERE organization_id = $1`);

  push('dikigoroi_antidikon', `
    aa AS id,
    eponymo AS eponymo_or_eponymia,
    onoma,
    tilefono AS tilefono_grafeiou,
    NULL::text AS fax,
    NULL::text AS kinito,
    email
  FROM dikigoroi_antidikon WHERE organization_id = $1`);

  push('antidikoi', `
    aa AS id,
    eponymo AS eponymo_or_eponymia,
    onoma,
    telefono AS tilefono_grafeiou,
    NULL::text AS fax,
    NULL::text AS kinito,
    email
  FROM antidikoi WHERE organization_id = $1`);

  // Φίλτρο πηγής
  let filteredParts = parts;
  if (req.query.source) {
    const wanted = String(req.query.source).split(',');
    filteredParts = parts.filter((p) =>
      wanted.some((w) => p.startsWith(`SELECT '${w}' `))
    );
    if (filteredParts.length === 0) {
      return res.status(400).json({ error: 'Invalid source' });
    }
  }

  let sql = `SELECT * FROM (${filteredParts.join(' UNION ALL ')}) AS book`;

  // Φίλτρο αναζήτησης
  if (req.query.q) {
    sql += ` WHERE (
      eponymo_or_eponymia ILIKE $2
      OR onoma ILIKE $2
      OR email ILIKE $2
      OR tilefono_grafeiou ILIKE $2
      OR kinito ILIKE $2
    )`;
    params.push(`%${req.query.q}%`);
  }

  sql += ` ORDER BY eponymo_or_eponymia, onoma LIMIT 5000`;

  try {
    const r = await pool.query(sql, params);
    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('[phonebook]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
