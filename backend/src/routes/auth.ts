import express, { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../index.ts';

const router = Router();

// Validation schemas
const RegisterSchema = z.object({
  organizationName: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(2),
  lastName: z.string().min(2),
  phone: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Register new organization + admin user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const data = RegisterSchema.parse(req.body);

    // Check if organization exists
    const orgExists = await pool.query(
      'SELECT id FROM organizations WHERE email = $1',
      [data.email]
    );

    if (orgExists.rows.length > 0) {
      return res.status(400).json({ error: 'Organization already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Create organization
    const orgResult = await pool.query(
      `INSERT INTO organizations (name, slug, email, phone) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, name`,
      [data.organizationName, data.organizationName.toLowerCase().replace(/\s+/g, '-'), data.email, data.phone || null]
    );

    const orgId = orgResult.rows[0].id;

    // Create admin user
    const userResult = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, phone) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING id, email, first_name, last_name, role`,
      [orgId, data.email, passwordHash, data.firstName, data.lastName, 'admin', data.phone || null]
    );

    const user = userResult.rows[0];

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, organizationId: orgId, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Organization registered successfully',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        organizationId: orgId,
      },
    });
  } catch (err: any) {
    console.error('Register error:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const data = LoginSchema.parse(req.body);

    const result = await pool.query(
      `SELECT u.id, u.password_hash, u.first_name, u.last_name, u.role, u.organization_id, u.is_active
       FROM users u
       WHERE u.email = $1`,
      [data.email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is inactive' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(data.password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, email: data.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: data.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        organizationId: user.organization_id,
      },
    });
  } catch (err: any) {
    console.error('Login error:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify token
router.get('/me', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token' });
    }

    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    const result = await pool.query(
      'SELECT id, email, first_name, last_name, role, organization_id FROM users WHERE id = $1',
      [decoded.userId]
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
        organizationId: user.organization_id,
      },
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
