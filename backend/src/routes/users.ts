import express, { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../index.ts';

const router = Router();

interface AuthRequest extends Request {
  user?: any;
  organizationId?: number;
}

const CreateUserSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(2),
  lastName: z.string().min(2),
  role: z.enum(['admin', 'lawyer', 'secretary']),
  phone: z.string().optional(),
  password: z.string().min(8).optional(),
});

const UpdateUserSchema = CreateUserSchema.partial().omit({ password: true });

// Get organization users
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, role } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = `
      SELECT id, email, first_name, last_name, role, phone, avatar_url, is_active, last_login, created_at
      FROM users
      WHERE organization_id = $1
    `;

    const params: any[] = [req.organizationId];

    if (role) {
      query += ` AND role = $${params.length + 1}`;
      params.push(role);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) FROM users WHERE organization_id = $1`;
    const countParams = [req.organizationId];

    if (role) {
      countQuery += ` AND role = $${countParams.length + 1}`;
      countParams.push(role);
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      data: result.rows.map(u => ({
        id: u.id,
        email: u.email,
        firstName: u.first_name,
        lastName: u.last_name,
        role: u.role,
        phone: u.phone,
        isActive: u.is_active,
        lastLogin: u.last_login,
        createdAt: u.created_at,
      })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: parseInt(countResult.rows[0].count),
      },
    });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create new user
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    // Check if current user is admin
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create users' });
    }

    const data = CreateUserSchema.parse(req.body);

    // Check if email exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND organization_id = $2',
      [data.email, req.organizationId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Generate password if not provided
    const password = data.password || Math.random().toString(36).slice(-10);
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, first_name, last_name, role, phone, created_at`,
      [req.organizationId, data.email, passwordHash, data.firstName, data.lastName, data.role, data.phone || null]
    );

    const user = result.rows[0];

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        phone: user.phone,
        // Return temp password if it was generated
        tempPassword: !data.password ? password : undefined,
      },
    });
  } catch (err: any) {
    console.error('Create user error:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Get single user
router.get('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, phone, avatar_url, is_active, created_at
       FROM users
       WHERE id = $1 AND organization_id = $2`,
      [userId, req.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        phone: user.phone,
        isActive: user.is_active,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user
router.put('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    // Check permissions
    if (req.user?.role !== 'admin' && req.user?.userId !== Number(req.params.userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { userId } = req.params;
    const data = UpdateUserSchema.parse(req.body);

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.firstName) {
      updates.push(`first_name = $${paramCount++}`);
      values.push(data.firstName);
    }
    if (data.lastName) {
      updates.push(`last_name = $${paramCount++}`);
      values.push(data.lastName);
    }
    if (data.role && req.user?.role === 'admin') {
      updates.push(`role = $${paramCount++}`);
      values.push(data.role);
    }
    if (data.phone !== undefined) {
      updates.push(`phone = $${paramCount++}`);
      values.push(data.phone || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);

    values.push(userId, req.organizationId);

    const query = `UPDATE users SET ${updates.join(', ')} 
                   WHERE id = $${paramCount++} AND organization_id = $${paramCount}
                   RETURNING id, email, first_name, last_name, role, phone`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'User updated successfully',
      user: result.rows[0],
    });
  } catch (err: any) {
    console.error('Update user error:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Deactivate user
router.put('/:userId/deactivate', async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can deactivate users' });
    }

    const { userId } = req.params;

    const result = await pool.query(
      'UPDATE users SET is_active = false WHERE id = $1 AND organization_id = $2 RETURNING id',
      [userId, req.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deactivated successfully' });
  } catch (err) {
    console.error('Deactivate user error:', err);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

export default router;
