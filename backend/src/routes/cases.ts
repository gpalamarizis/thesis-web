import express, { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../index.ts';

const router = Router();

interface AuthRequest extends Request {
  user?: any;
  organizationId?: number;
}

// Validation schemas
const CreateCaseSchema = z.object({
  protocolNumber: z.string().min(1), // xeirokinito_id
  caseTypeName: z.number().optional(), // onomasia_id
  description: z.string().optional(),
  opposingLawyer: z.number().optional(), // diadikos_id
  clientType: z.enum(['fysika', 'nomika']),
  clientId: z.number(),
  startDate: z.string().optional(),
  status: z.string().optional(),
});

const UpdateCaseSchema = CreateCaseSchema.partial();

// Get all cases for organization
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = `
      SELECT 
        y.id, 
        y.xeirokinito_id as protocol_number,
        y.perilipsi as description,
        y.status,
        y.starting_date,
        y.ending_date,
        COALESCE(fp.eponymo || ' ' || fp.onoma, np.eponymia) as client_name,
        da.eponymo as opposing_lawyer_name,
        yon.name as case_type_name,
        y.created_at
      FROM ypotheseis y
      LEFT JOIN fysika_prosopa fp ON y.fysiko_prosopo_id = fp.id
      LEFT JOIN nomika_prosopa np ON y.nomiko_prosopo_id = np.id
      LEFT JOIN dikigoroi_antidikon da ON y.diadikos_id = da.id
      LEFT JOIN ypotheseis_onomasies yon ON y.onomasia_id = yon.id
      WHERE y.organization_id = $1
    `;

    const params: any[] = [req.organizationId];

    if (status) {
      query += ` AND y.status = $${params.length + 1}`;
      params.push(status);
    }

    if (search) {
      query += ` AND (y.xeirokinito_id ILIKE $${params.length + 1} OR y.perilipsi ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY y.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) FROM ypotheseis WHERE organization_id = $1`;
    const countParams = [req.organizationId];

    if (status) {
      countQuery += ` AND status = $${countParams.length + 1}`;
      countParams.push(status);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: result.rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error('Get cases error:', err);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

// Get single case with all related data
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Get case details
    const caseResult = await pool.query(
      `SELECT * FROM ypotheseis WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    );

    if (caseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const caseData = caseResult.rows[0];

    // Get court actions
    const courtActions = await pool.query(
      `SELECT de.*, d.name as court_name, de2.name as status_name
       FROM dikastiria_energeies de
       LEFT JOIN dikastiria d ON de.dikastirio_id = d.id
       LEFT JOIN dikastiria_exelixi_energeias de2 ON de.exelixi_id = de2.id
       WHERE de.ypothesi_id = $1 AND de.organization_id = $2
       ORDER BY de.energeia_date DESC`,
      [id, req.organizationId]
    );

    // Get other activities
    const otherActivities = await pool.query(
      `SELECT * FROM energeies 
       WHERE ypothesi_id = $1 AND organization_id = $2
       ORDER BY energeia_date DESC`,
      [id, req.organizationId]
    );

    // Get documents
    const documents = await pool.query(
      `SELECT * FROM case_documents 
       WHERE case_id = $1 AND organization_id = $2
       ORDER BY uploaded_at DESC`,
      [id, req.organizationId]
    );

    // Get related cases
    const relatedCases = await pool.query(
      `SELECT sy.sxetiki_ypothesi_id as id, y.xeirokinito_id, sy.relation_type
       FROM sxetikes_ypotheseis sy
       JOIN ypotheseis y ON sy.sxetiki_ypothesi_id = y.id
       WHERE sy.ypothesi_id = $1 AND sy.organization_id = $2`,
      [id, req.organizationId]
    );

    res.json({
      case: caseData,
      courtActions: courtActions.rows,
      activities: otherActivities.rows,
      documents: documents.rows,
      relatedCases: relatedCases.rows,
    });
  } catch (err) {
    console.error('Get case error:', err);
    res.status(500).json({ error: 'Failed to fetch case' });
  }
});

// Create new case
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const data = CreateCaseSchema.parse(req.body);

    const result = await pool.query(
      `INSERT INTO ypotheseis 
       (organization_id, xeirokinito_id, onomasia_id, perilipsi, diadikos_id, 
        fysiko_prosopo_id, nomiko_prosopo_id, starting_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.organizationId,
        data.protocolNumber,
        data.caseTypeName || null,
        data.description || null,
        data.opposingLawyer || null,
        data.clientType === 'fysika' ? data.clientId : null,
        data.clientType === 'nomika' ? data.clientId : null,
        data.startDate || new Date().toISOString().split('T')[0],
        data.status || 'open',
      ]
    );

    const newCase = result.rows[0];

    res.status(201).json({
      message: 'Case created successfully',
      case: newCase,
    });
  } catch (err: any) {
    console.error('Create case error:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    res.status(500).json({ error: 'Failed to create case' });
  }
});

// Update case
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const data = UpdateCaseSchema.parse(req.body);

    // Check if case exists
    const existing = await pool.query(
      'SELECT id FROM ypotheseis WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.protocolNumber) {
      updates.push(`xeirokinito_id = $${paramCount++}`);
      values.push(data.protocolNumber);
    }
    if (data.caseTypeName) {
      updates.push(`onomasia_id = $${paramCount++}`);
      values.push(data.caseTypeName);
    }
    if (data.description !== undefined) {
      updates.push(`perilipsi = $${paramCount++}`);
      values.push(data.description);
    }
    if (data.status) {
      updates.push(`status = $${paramCount++}`);
      values.push(data.status);
    }

    updates.push(`updated_at = NOW()`);

    values.push(id, req.organizationId);

    const query = `UPDATE ypotheseis SET ${updates.join(', ')} 
                   WHERE id = $${paramCount++} AND organization_id = $${paramCount}
                   RETURNING *`;

    const result = await pool.query(query, values);

    res.json({
      message: 'Case updated successfully',
      case: result.rows[0],
    });
  } catch (err: any) {
    console.error('Update case error:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    res.status(500).json({ error: 'Failed to update case' });
  }
});

// Delete case
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM ypotheseis WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, req.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Case not found' });
    }

    res.json({ message: 'Case deleted successfully' });
  } catch (err) {
    console.error('Delete case error:', err);
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

export default router;
