// Case documents - από το VB.NET tab "Αρχεία" της υπόθεσης
//
// Storage: Cloudflare R2 (S3-compatible)
// Env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//
// Endpoints:
//   GET    /api/documents?ypothesi_id=..    → λίστα αρχείων υπόθεσης
//   POST   /api/documents                   → upload (multipart form-data: file, ypothesi_id)
//   GET    /api/documents/:id/download-url  → presigned GET URL (valid 5 min)
//   DELETE /api/documents/:id               → delete από R2 + από DB

const express = require('express');
const multer  = require('multer');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// --- R2 client (lazy init - λειτουργεί ακόμα κι αν λείπουν env vars στο dev) ---
let s3 = null;
function getS3() {
  if (s3) return s3;
  const {
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 credentials not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)');
  }
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return s3;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },   // 50 MB
});

// GET /api/documents?ypothesi_id=..
router.get('/', async (req, res) => {
  const orgId = req.user.organization_id;
  if (!req.query.ypothesi_id) {
    return res.status(400).json({ error: 'ypothesi_id required' });
  }
  try {
    const r = await pool.query(
      `SELECT d.*, u.first_name AS uploader_first, u.last_name AS uploader_last
         FROM case_documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.organization_id = $1 AND d.ypothesi_id = $2
        ORDER BY d.uploaded_at DESC`,
      [orgId, parseInt(req.query.ypothesi_id, 10)]
    );
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents  (multipart: file, ypothesi_id)
router.post('/', upload.single('file'), async (req, res) => {
  const orgId = req.user.organization_id;
  const ypothesi_id = parseInt(req.body.ypothesi_id, 10);

  if (!req.file) return res.status(400).json({ error: 'file required (multipart form-data)' });
  if (!ypothesi_id) return res.status(400).json({ error: 'ypothesi_id required' });

  // Επιβεβαίωση ότι η υπόθεση ανήκει στον org
  try {
    const own = await pool.query(
      `SELECT aa FROM ypotheseis WHERE aa = $1 AND organization_id = $2`,
      [ypothesi_id, orgId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const bucket = process.env.R2_BUCKET || 'thesis-documents';
  const key    = `org-${orgId}/case-${ypothesi_id}/${Date.now()}-${req.file.originalname.replace(/[^A-Za-z0-9._-]/g, '_')}`;

  try {
    await getS3().send(new PutObjectCommand({
      Bucket: bucket,
      Key:    key,
      Body:   req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const r = await pool.query(
      `INSERT INTO case_documents
         (organization_id, ypothesi_id, filename, r2_key, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [orgId, ypothesi_id, req.file.originalname, key, req.file.mimetype, req.file.size, req.user.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[documents/upload]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/download-url
router.get('/:id/download-url', async (req, res) => {
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(
      `SELECT * FROM case_documents WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const doc = r.rows[0];
    const url = await getSignedUrl(
      getS3(),
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET || 'thesis-documents',
        Key: doc.r2_key,
      }),
      { expiresIn: 300 }   // 5 min
    );
    res.json({ url, filename: doc.filename, mime_type: doc.mime_type });
  } catch (err) {
    console.error('[documents/download-url]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(
      `SELECT * FROM case_documents WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const doc = r.rows[0];

    // πρώτα από R2 (best-effort)
    try {
      await getS3().send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET || 'thesis-documents',
        Key: doc.r2_key,
      }));
    } catch (r2err) {
      console.warn('[documents/delete] R2 delete failed (continuing):', r2err.message);
    }

    await pool.query(`DELETE FROM case_documents WHERE aa = $1 AND organization_id = $2`,
      [req.params.id, orgId]);
    res.json({ deleted: parseInt(req.params.id, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
