// src/routes/document-templates.js
// Word/DOCX templates with mail-merge rendering.
//
// Requires:
//   npm install docxtemplater pizzip
//
// R2 storage layout:
//   templates/{organization_id}/{template_id}.docx  — original template
//   documents/{organization_id}/{case_id}/{doc_id}  — rendered case documents (existing pattern)
//
// Endpoints:
//   GET    /api/document-templates                                 → list
//   POST   /api/document-templates                                 → upload (multipart form: file, name, category, description)
//   GET    /api/document-templates/:id/download                    → download original template
//   DELETE /api/document-templates/:id
//   POST   /api/document-templates/:id/create-doc/:caseId          → render + save as case doc, returns new doc id

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const PizZip  = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// R2 client (uses same env vars as documents.js)
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || 'fa2b2b65d8059c6061e220c00371e471'}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID     || process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET || 'thesis-documents';

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_templates (
      aa               BIGSERIAL PRIMARY KEY,
      organization_id  BIGINT NOT NULL,
      name             VARCHAR(255) NOT NULL,
      category         VARCHAR(120),
      description      TEXT,
      original_filename VARCHAR(255),
      size_bytes       BIGINT,
      mime_type        VARCHAR(120),
      r2_key           TEXT NOT NULL,
      uploaded_by      BIGINT,
      uploaded_at      TIMESTAMPTZ DEFAULT NOW(),
      active           BOOLEAN DEFAULT TRUE
    );
    CREATE INDEX IF NOT EXISTS idx_doc_templates_org ON document_templates (organization_id);
  `);
  tableEnsured = true;
}

// ---------- Helpers ----------

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const GREEK_MONTHS = [
  'Ιανουαρίου','Φεβρουαρίου','Μαρτίου','Απριλίου','Μαΐου','Ιουνίου',
  'Ιουλίου','Αυγούστου','Σεπτεμβρίου','Οκτωβρίου','Νοεμβρίου','Δεκεμβρίου',
];

function greekDateLong(d) {
  const dt = d ? new Date(d) : new Date();
  if (isNaN(dt.getTime())) return '';
  return `${dt.getDate()} ${GREEK_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}
function greekDateShort(d) {
  const dt = d ? new Date(d) : new Date();
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('el-GR');
}

/**
 * Build the flat data object for mail-merge from a case.
 * All keys are UPPER_SNAKE_CASE for readability inside Word docs.
 */
async function buildCaseData(caseId, orgId) {
  const cR = await pool.query(
    `SELECT y.*,
            fp.eponymo         AS fp_eponymo,
            fp.onoma           AS fp_onoma,
            fp.onoma_patros    AS fp_onoma_patros,
            fp.afm             AS fp_afm,
            fp.doy             AS fp_doy,
            fp.adt             AS fp_adt,
            fp.ekdousa_arxi    AS fp_ekdousa_arxi,
            fp.email           AS fp_email,
            fp.odos_oikias     AS fp_odos,
            fp.arithmos_oikias AS fp_arithmos,
            fp.tk_oikias       AS fp_tk,
            fp.poli_oikias     AS fp_poli,
            np.eponymia            AS np_eponymia,
            np.diakritikos_titlos  AS np_diakritikos_titlos,
            np.afm                 AS np_afm,
            np.doy                 AS np_doy,
            np.odos                AS np_odos,
            np.arithmos            AS np_arithmos,
            np.tk                  AS np_tk,
            np.poli                AS np_poli,
            an.eponymo         AS an_eponymo,
            an.onoma           AS an_onoma
       FROM ypotheseis y
       LEFT JOIN fysika_prosopa fp ON fp.aa = y.fysiko_prosopo_id
       LEFT JOIN nomika_prosopa np ON np.aa = y.nomiko_prosopo_id
       LEFT JOIN antidikoi     an ON an.aa = y.diadikos_id
      WHERE y.aa = $1 AND y.organization_id = $2`,
    [caseId, orgId]
  );
  if (cR.rows.length === 0) throw new Error('Case not found');
  const c = cR.rows[0];

  const oR = await pool.query(
    `SELECT * FROM organization_settings WHERE organization_id = $1`,
    [orgId]
  );
  const o = oR.rows[0] || {};

  const isFysiko = !!c.fysiko_prosopo_id;
  const clientFullName = isFysiko
    ? `${c.fp_eponymo || ''} ${c.fp_onoma || ''}`.trim()
    : (c.np_eponymia || c.np_diakritikos_titlos || '');

  // ---- Xeiristes (multiple lawyers per case) ----
  const xR = await pool.query(
    `SELECT dg.aa, dg.eponymo, dg.onoma, dg.onoma_patros,
            dg.ar_mitroou, dg.syllogos, dg.email, dg.mobile,
            dg.afm, dg.doy
       FROM xeiristes_dikigoroi xd
       JOIN dikigoroi_grafeiou dg ON dg.aa = xd.dikigoroi_grafeiou_id
      WHERE xd.ypotheseis_id = $1 AND xd.organization_id = $2
      ORDER BY dg.eponymo, dg.onoma`,
    [caseId, orgId]
  );
  const xeiristes = xR.rows;

  // ---- Related persons of the case ----
  const rpR = await pool.query(
    `SELECT sp.aa, sp.eponymo, sp.onoma, sp.eponymia, sp.afm, sp.doy, sp.email,
            sp.odos, sp.arithmos, sp.tk, sp.poli,
            es.name AS role_name
       FROM case_related_persons crp
       JOIN ypotheseis y ON y.aa = crp.ypothesi_id
       LEFT JOIN sxetika_prosopa sp ON sp.aa = crp.sxetiko_prosopo_id
       LEFT JOIN eidos_sxesis    es ON es.aa = crp.eidos_sxesis_id
      WHERE y.organization_id = $1 AND crp.ypothesi_id = $2
      ORDER BY crp.created_at ASC`,
    [orgId, caseId]
  );
  const relatedPersons = rpR.rows;

  const xNameFull = (x) => `${x.eponymo || ''} ${x.onoma || ''}`.trim();
  const rNameFull = (r) => (r.eponymia && r.eponymia.trim())
    ? r.eponymia
    : `${r.eponymo || ''} ${r.onoma || ''}`.trim();

  // Individual placeholders for top 5 lawyers
  const xeiristesFields = {};
  for (let i = 0; i < 5; i++) {
    const x = xeiristes[i] || {};
    const n = i + 1;
    xeiristesFields[`XEIRISTIS_${n}_FULL_NAME`] = xNameFull(x);
    xeiristesFields[`XEIRISTIS_${n}_EPONYMO`]   = x.eponymo || '';
    xeiristesFields[`XEIRISTIS_${n}_ONOMA`]     = x.onoma || '';
    xeiristesFields[`XEIRISTIS_${n}_AM`]        = x.ar_mitroou || '';
    xeiristesFields[`XEIRISTIS_${n}_SYLLOGOS`]  = x.syllogos || '';
    xeiristesFields[`XEIRISTIS_${n}_EMAIL`]     = x.email || '';
    xeiristesFields[`XEIRISTIS_${n}_MOBILE`]    = x.mobile || '';
    xeiristesFields[`XEIRISTIS_${n}_AFM`]       = x.afm || '';
  }

  // Individual placeholders for top 5 related persons
  const relatedFields = {};
  for (let i = 0; i < 5; i++) {
    const r = relatedPersons[i] || {};
    const n = i + 1;
    relatedFields[`RELATED_${n}_FULL_NAME`] = r.aa ? rNameFull(r) : '';
    relatedFields[`RELATED_${n}_ROLE`]     = r.role_name || '';
    relatedFields[`RELATED_${n}_AFM`]      = r.afm || '';
    relatedFields[`RELATED_${n}_DOY`]      = r.doy || '';
    relatedFields[`RELATED_${n}_EMAIL`]    = r.email || '';
    relatedFields[`RELATED_${n}_DIEYTHYNSI`] = [r.odos, r.arithmos, r.tk, r.poli].filter(Boolean).join(' ');
  }

  // Comma-separated summaries
  const XEIRISTES_ALL   = xeiristes.map(xNameFull).filter(Boolean).join(', ');
  const XEIRISTES_FORMAL = xeiristes.map(x => {
    const name = xNameFull(x);
    const parts = [];
    if (x.ar_mitroou) parts.push(`Α.Μ. ${x.syllogos || 'ΔΣΑ'} ${x.ar_mitroou}`);
    return parts.length ? `${name} (${parts.join(', ')})` : name;
  }).filter(Boolean).join(', ');
  const RELATED_ALL = relatedPersons.map(r => {
    const name = rNameFull(r);
    return r.role_name ? `${name} (${r.role_name})` : name;
  }).filter(Boolean).join(', ');

  return {
    // ---- Case ----
    XEIROKINITO_ID:    c.xeirokinito_id || '',
    DATE_EISAGOGIS:    greekDateShort(c.date_eisagogis),
    DATE_TELOUS:       greekDateShort(c.date_telous),
    PERILIPSI:         c.perilipsi || '',
    ONOMASIA_FAKELOU:  c.onomasia_fakelou || '',
    OLD_KOD:           c.old_kod || '',
    ARITHMOS_APOFASIS: c.arithmos_apofasis || '',

    // ---- Client (unified) ----
    PELATIS_FULL_NAME:  clientFullName,
    PELATIS_EPONYMO:    isFysiko ? (c.fp_eponymo || '') : '',
    PELATIS_ONOMA:      isFysiko ? (c.fp_onoma || '') : '',
    PELATIS_ONOMA_PATROS: isFysiko ? (c.fp_onoma_patros || '') : '',
    PELATIS_EPONYMIA:   isFysiko ? '' : (c.np_eponymia || ''),
    PELATIS_DIAKRITIKOS_TITLOS: isFysiko ? '' : (c.np_diakritikos_titlos || ''),
    PELATIS_AFM:        isFysiko ? (c.fp_afm || '') : (c.np_afm || ''),
    PELATIS_DOY:        isFysiko ? (c.fp_doy || '') : (c.np_doy || ''),
    PELATIS_ADT:        isFysiko ? (c.fp_adt || '') : '',
    PELATIS_EKDOUSA_ARXI: isFysiko ? (c.fp_ekdousa_arxi || '') : '',
    PELATIS_EMAIL:      isFysiko ? (c.fp_email || '') : '',
    PELATIS_ODOS:       isFysiko ? (c.fp_odos || '') : (c.np_odos || ''),
    PELATIS_ARITHMOS:   isFysiko ? (c.fp_arithmos || '') : (c.np_arithmos || ''),
    PELATIS_TK:         isFysiko ? (c.fp_tk || '') : (c.np_tk || ''),
    PELATIS_POLI:       isFysiko ? (c.fp_poli || '') : (c.np_poli || ''),
    PELATIS_DIEYTHYNSI: [
      isFysiko ? c.fp_odos     : c.np_odos,
      isFysiko ? c.fp_arithmos : c.np_arithmos,
      isFysiko ? c.fp_tk       : c.np_tk,
      isFysiko ? c.fp_poli     : c.np_poli,
    ].filter(Boolean).join(' '),

    // ---- Opponent ----
    ANTIDIKOS_EPONYMO:   c.an_eponymo || '',
    ANTIDIKOS_ONOMA:     c.an_onoma || '',
    ANTIDIKOS_FULL_NAME: `${c.an_eponymo || ''} ${c.an_onoma || ''}`.trim(),

    // ---- Office (issuer) ----
    OFFICE_EPONYMIA:            o.eponymia || '',
    OFFICE_DIAKRITIKOS_TITLOS:  o.diakritikos_titlos || '',
    OFFICE_AFM:      o.afm || '',
    OFFICE_DOY:      o.doy || '',
    OFFICE_ODOS:     o.odos || '',
    OFFICE_ARITHMOS: o.arithmos || '',
    OFFICE_TK:       o.tk || '',
    OFFICE_POLI:     o.poli || '',
    OFFICE_DIEYTHYNSI: [o.odos, o.arithmos, o.tk, o.poli].filter(Boolean).join(' '),
    OFFICE_TILEFONO: o.tilefono || '',
    OFFICE_EMAIL:    o.email || '',
    OFFICE_GEMI:     o.gemi || '',
    OFFICE_KAD:      o.kad || '',
    OFFICE_IBAN:     o.iban || '',
    OFFICE_TRAPEZA:  o.trapeza || '',

    // ---- Xeiristes (multiple) ----
    XEIRISTES_ALL,
    XEIRISTES_FORMAL,
    ...xeiristesFields,

    // ---- Related persons ----
    RELATED_ALL,
    ...relatedFields,

        // ---- Date ----
    DATE_TODAY:        greekDateShort(new Date()),
    DATE_TODAY_GREEK:  greekDateLong(new Date()),
    DATE_TODAY_LONG:   greekDateLong(new Date()),
  };
}

// ---------- Routes ----------

router.get('/', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(
      `SELECT dt.*,
              CONCAT_WS(' ', u.first_name, u.last_name) AS uploader_name
         FROM document_templates dt
         LEFT JOIN users u ON u.id = dt.uploaded_by
        WHERE dt.organization_id = $1 AND dt.active = TRUE
        ORDER BY dt.category NULLS FIRST, dt.name`,
      [orgId]
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[templates list]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', upload.single('file'), async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const name = req.body.name || req.file.originalname.replace(/\.docx?$/i, '');
  const category = req.body.category || null;
  const description = req.body.description || null;

  const isDocx = req.file.originalname.toLowerCase().endsWith('.docx');
  if (!isDocx) return res.status(400).json({ error: 'Μόνο .docx αρχεία υποστηρίζονται.' });

  try {
    // Reserve DB row first for id
    const ins = await pool.query(
      `INSERT INTO document_templates (organization_id, name, category, description, original_filename, size_bytes, mime_type, r2_key, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
       RETURNING aa`,
      [orgId, name, category, description, req.file.originalname, req.file.size, req.file.mimetype, req.user.sub || req.user.id || null]
    );
    const templateId = ins.rows[0].aa;
    const r2Key = `templates/${orgId}/${templateId}.docx`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));

    await pool.query(
      `UPDATE document_templates SET r2_key = $1 WHERE aa = $2`,
      [r2Key, templateId]
    );

    const full = await pool.query(`SELECT * FROM document_templates WHERE aa = $1`, [templateId]);
    res.status(201).json({ data: full.rows[0] });
  } catch (err) {
    console.error('[templates upload]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/download', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(
      `SELECT * FROM document_templates WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const t = r.rows[0];

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: t.r2_key }));
    const buf = await streamToBuffer(obj.Body);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(t.original_filename || (t.name + '.docx'))}"`);
    res.send(buf);
  } catch (err) {
    console.error('[templates download]', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(
      `SELECT r2_key FROM document_templates WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    // Soft delete first (in case R2 delete fails)
    await pool.query(`UPDATE document_templates SET active = FALSE WHERE aa = $1`, [req.params.id]);

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r.rows[0].r2_key }));
    } catch (delErr) {
      console.warn('[templates delete R2]', delErr.message);
    }

    res.status(204).end();
  } catch (err) {
    console.error('[templates delete]', err);
    res.status(500).json({ error: err.message });
  }
});

// Render + save as case document
router.post('/:id/create-doc/:caseId', async (req, res) => {
  await ensureTable();
  const orgId = req.user.organization_id;
  try {
    const tR = await pool.query(
      `SELECT * FROM document_templates WHERE aa = $1 AND organization_id = $2 AND active = TRUE`,
      [req.params.id, orgId]
    );
    if (tR.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const t = tR.rows[0];

    // Verify case belongs to org
    const cR = await pool.query(
      `SELECT aa, xeirokinito_id FROM ypotheseis WHERE aa = $1 AND organization_id = $2`,
      [req.params.caseId, orgId]
    );
    if (cR.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    const caseInfo = cR.rows[0];

    // Load template DOCX
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: t.r2_key }));
    const templateBuf = await streamToBuffer(obj.Body);

    // Render with case data
    const data = await buildCaseData(req.params.caseId, orgId);
    const zip = new PizZip(templateBuf);
    const doc = new Docxtemplater(zip, {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
    });

    try {
      doc.render(data);
    } catch (renderErr) {
      // docxtemplater errors are informative
      const details = renderErr.properties?.errors
        ? renderErr.properties.errors.map(e => e.properties?.explanation || e.message).join('; ')
        : renderErr.message;
      return res.status(400).json({ error: `Σφάλμα render: ${details}` });
    }

    const renderedBuf = doc.getZip().generate({ type: 'nodebuffer' });

    // Save as case document (mirroring documents.js pattern)
    // Filename: {template name} - {protocol}.docx
    const safeProtocol = (caseInfo.xeirokinito_id || `case-${caseInfo.aa}`).replace(/[^\wΑ-Ωα-ωΆ-Ώά-ώ\-.]/g, '_');
    const filename = `${t.name.replace(/[^\wΑ-Ωα-ωΆ-Ώά-ώ\-.\s]/g, '_')} — ${safeProtocol}.docx`;

    // Insert case_documents row and upload
    const docIns = await pool.query(
      `INSERT INTO case_documents (organization_id, ypothesi_id, filename, size_bytes, mime_type, r2_key, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, NOW())
       RETURNING aa`,
      [
        orgId,
        parseInt(req.params.caseId, 10),
        filename,
        renderedBuf.length,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        req.user.sub || req.user.id || null,
      ]
    );
    const docId = docIns.rows[0].aa;
    const docR2Key = `documents/${orgId}/${req.params.caseId}/${docId}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: docR2Key,
      Body: renderedBuf,
      ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));

    await pool.query(`UPDATE case_documents SET r2_key = $1 WHERE aa = $2`, [docR2Key, docId]);

    res.status(201).json({
      data: {
        document_id: docId,
        filename,
        size_bytes: renderedBuf.length,
      }
    });
  } catch (err) {
    console.error('[templates render]', err);
    res.status(500).json({ error: err.message });
  }
});

// List available placeholders (for admin UI reference)
router.get('/placeholders/help', async (req, res) => {
  res.json({
    data: [
      { category: 'Υπόθεση', vars: [
        'XEIROKINITO_ID','DATE_EISAGOGIS','DATE_TELOUS','PERILIPSI','ONOMASIA_FAKELOU','OLD_KOD','ARITHMOS_APOFASIS'
      ]},
      { category: 'Πελάτης', vars: [
        'PELATIS_FULL_NAME','PELATIS_EPONYMO','PELATIS_ONOMA','PELATIS_ONOMA_PATROS',
        'PELATIS_EPONYMIA','PELATIS_DIAKRITIKOS_TITLOS',
        'PELATIS_AFM','PELATIS_DOY','PELATIS_ADT','PELATIS_EKDOUSA_ARXI','PELATIS_EMAIL',
        'PELATIS_ODOS','PELATIS_ARITHMOS','PELATIS_TK','PELATIS_POLI','PELATIS_DIEYTHYNSI'
      ]},
      { category: 'Αντίδικος', vars: [
        'ANTIDIKOS_EPONYMO','ANTIDIKOS_ONOMA','ANTIDIKOS_FULL_NAME'
      ]},
      { category: 'Χειριστές δικηγόροι (πολλαπλοί)', vars: [
        'XEIRISTES_ALL','XEIRISTES_FORMAL',
        'XEIRISTIS_1_FULL_NAME','XEIRISTIS_1_EPONYMO','XEIRISTIS_1_ONOMA','XEIRISTIS_1_AM','XEIRISTIS_1_SYLLOGOS','XEIRISTIS_1_EMAIL','XEIRISTIS_1_MOBILE','XEIRISTIS_1_AFM',
        'XEIRISTIS_2_FULL_NAME','XEIRISTIS_2_EPONYMO','XEIRISTIS_2_ONOMA','XEIRISTIS_2_AM','XEIRISTIS_2_SYLLOGOS','XEIRISTIS_2_EMAIL','XEIRISTIS_2_MOBILE','XEIRISTIS_2_AFM',
        'XEIRISTIS_3_FULL_NAME','XEIRISTIS_3_EPONYMO','XEIRISTIS_3_ONOMA','XEIRISTIS_3_AM','XEIRISTIS_3_SYLLOGOS','XEIRISTIS_3_EMAIL','XEIRISTIS_3_MOBILE','XEIRISTIS_3_AFM',
        'XEIRISTIS_4_FULL_NAME','XEIRISTIS_5_FULL_NAME'
      ]},
      { category: 'Σχετικά πρόσωπα υπόθεσης (πολλαπλά)', vars: [
        'RELATED_ALL',
        'RELATED_1_FULL_NAME','RELATED_1_ROLE','RELATED_1_AFM','RELATED_1_DOY','RELATED_1_EMAIL','RELATED_1_DIEYTHYNSI',
        'RELATED_2_FULL_NAME','RELATED_2_ROLE',
        'RELATED_3_FULL_NAME','RELATED_3_ROLE',
        'RELATED_4_FULL_NAME','RELATED_5_FULL_NAME'
      ]},
      { category: 'Γραφείο', vars: [
        'OFFICE_EPONYMIA','OFFICE_DIAKRITIKOS_TITLOS','OFFICE_AFM','OFFICE_DOY',
        'OFFICE_ODOS','OFFICE_ARITHMOS','OFFICE_TK','OFFICE_POLI','OFFICE_DIEYTHYNSI',
        'OFFICE_TILEFONO','OFFICE_EMAIL','OFFICE_GEMI','OFFICE_KAD','OFFICE_IBAN','OFFICE_TRAPEZA'
      ]},
      { category: 'Ημερομηνία', vars: [
        'DATE_TODAY','DATE_TODAY_GREEK','DATE_TODAY_LONG'
      ]},
    ]
  });
});

module.exports = router;
