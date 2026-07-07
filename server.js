import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

app.use(cors());
app.use(express.json());

// Auto-run schema on startup
async function initDatabase() {
  try {
    console.log('Checking database...');
    const check = await pool.query(`
      SELECT COUNT(*) FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tableCount = parseInt(check.rows[0].count);
    console.log(`Found ${tableCount} tables`);
    
    if (tableCount === 0) {
      console.log('Loading schema.sql...');
      const schema = fs.readFileSync('./schema.sql', 'utf8');
      await pool.query(schema);
      console.log('✅ Schema loaded successfully');
    } else {
      console.log('✅ Schema already exists');
    }
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Thesis API is running' });
});

// List all tables (for verification)
app.get('/api/tables', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    res.json({ 
      count: result.rows.length,
      tables: result.rows.map(r => r.table_name) 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register organization + admin user
app.post('/api/auth/register', async (req, res) => {
  try {
    const { organizationName, email, password, firstName, lastName, phone } = req.body;
    
    if (!organizationName || !email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const slug = organizationName.toLowerCase().replace(/\s+/g, '-');
    
    const orgResult = await pool.query(
      `INSERT INTO organizations (name, slug, email, phone) 
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [organizationName, slug, email, phone || null]
    );
    
    const orgId = orgResult.rows[0].id;
    
    const userResult = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, phone) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING id, email, first_name, last_name, role`,
      [orgId, email, passwordHash, firstName, lastName, 'admin', phone || null]
    );
    
    const user = userResult.rows[0];
    
    const token = jwt.sign(
      { userId: user.id, organizationId: orgId, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.status(201).json({ 
      message: 'Registration successful',
      token, 
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        organizationId: orgId
      }
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const result = await pool.query(
      `SELECT id, password_hash, first_name, last_name, role, organization_id
       FROM users WHERE email = $1`,
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({ 
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        organizationId: user.organization_id
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({ 
    message: 'Thesis API',
    endpoints: [
      'GET /health',
      'GET /api/tables',
      'POST /api/auth/register',
      'POST /api/auth/login'
    ]
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Thesis API running on port ${PORT}`);
  await initDatabase();
});
