import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { pool } from '../index.ts';

const router = Router();

interface AuthRequest extends Request {
  user?: any;
  organizationId?: number;
}

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    // Allowed MIME types
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'text/plain',
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

// Cloudflare R2 Configuration
const s3Client = new S3Client({
  region: 'auto',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
  endpoint: process.env.R2_ENDPOINT,
});

const R2_BUCKET = process.env.R2_BUCKET || 'thesis-documents';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://documents.thesis.local';

// Upload document
router.post('/upload/:caseId', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { caseId } = req.params;
    const { documentType } = req.body;

    // Verify case exists
    const caseResult = await pool.query(
      'SELECT id FROM ypotheseis WHERE id = $1 AND organization_id = $2',
      [caseId, req.organizationId]
    );

    if (caseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(7);
    const ext = req.file.originalname.split('.').pop();
    const fileName = `${req.organizationId}/${caseId}/${timestamp}-${randomStr}.${ext}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata: {
        'original-name': req.file.originalname,
        'uploaded-by': req.user?.userId.toString(),
      },
    });

    await s3Client.send(command);

    // Save metadata to database
    const result = await pool.query(
      `INSERT INTO case_documents 
       (organization_id, case_id, file_name, file_path, file_type, file_size, document_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.organizationId,
        caseId,
        req.file.originalname,
        fileName,
        req.file.mimetype,
        req.file.size,
        documentType || 'general',
        req.user?.userId,
      ]
    );

    const document = result.rows[0];

    res.status(201).json({
      message: 'Document uploaded successfully',
      document: {
        id: document.id,
        fileName: document.file_name,
        url: `${R2_PUBLIC_URL}/${document.file_path}`,
        fileSize: document.file_size,
        documentType: document.document_type,
        uploadedAt: document.uploaded_at,
      },
    });
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// Get case documents
router.get('/case/:caseId', async (req: AuthRequest, res: Response) => {
  try {
    const { caseId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Verify case exists
    const caseResult = await pool.query(
      'SELECT id FROM ypotheseis WHERE id = $1 AND organization_id = $2',
      [caseId, req.organizationId]
    );

    if (caseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const result = await pool.query(
      `SELECT 
        cd.*,
        u.first_name || ' ' || u.last_name as uploaded_by_name
       FROM case_documents cd
       LEFT JOIN users u ON cd.uploaded_by = u.id
       WHERE cd.case_id = $1 AND cd.organization_id = $2
       ORDER BY cd.uploaded_at DESC
       LIMIT $3 OFFSET $4`,
      [caseId, req.organizationId, limit, offset]
    );

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM case_documents WHERE case_id = $1 AND organization_id = $2',
      [caseId, req.organizationId]
    );

    const documents = result.rows.map(doc => ({
      id: doc.id,
      fileName: doc.file_name,
      url: `${R2_PUBLIC_URL}/${doc.file_path}`,
      fileSize: doc.file_size,
      documentType: doc.document_type,
      uploadedBy: doc.uploaded_by_name,
      uploadedAt: doc.uploaded_at,
    }));

    res.json({
      data: documents,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: parseInt(countResult.rows[0].count),
      },
    });
  } catch (err) {
    console.error('Get documents error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// Delete document
router.delete('/:documentId', async (req: AuthRequest, res: Response) => {
  try {
    const { documentId } = req.params;

    // Get document
    const result = await pool.query(
      'SELECT file_path FROM case_documents WHERE id = $1 AND organization_id = $2',
      [documentId, req.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const filePath = result.rows[0].file_path;

    // Delete from R2
    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET,
      Key: filePath,
    });

    await s3Client.send(command);

    // Delete from database
    await pool.query(
      'DELETE FROM case_documents WHERE id = $1',
      [documentId]
    );

    res.json({ message: 'Document deleted successfully' });
  } catch (err) {
    console.error('Delete document error:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

export default router;
