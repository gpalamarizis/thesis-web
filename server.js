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

// === AUTH MIDDLEWARE ===
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// === AUTO-RUN SCHEMA ===
async function initDatabase() {
  try {
    const check = await pool.query(`
      SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'
    `);
    const tableCount = parseInt(check.rows[0].count);
    console.log(`Found ${tableCount} tables`);
    
    if (tableCount === 0) {
      const schema = fs.readFileSync('./schema.sql', 'utf8');
      await pool.query(schema);
      console.log('✅ Schema loaded');
    }
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

// === HEALTH ===
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Thesis API' });
});

app.get('/', (req, res) => {
  res.json({ message: 'Thesis API v2' });
});

app.get('/api/tables', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    res.json({ count: result.rows.length, tables: result.rows.map(r => r.table_name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === AUTH ===
app.post('/api/auth/register', async (req, res) => {
  try {
    const { organizationName, email, password, firstName, lastName, phone } = req.body;
    if (!organizationName || !email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const slug = organizationName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
    
    const orgResult = await pool.query(
      `INSERT INTO organizations (name, slug, email, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
      [organizationName, slug, email, phone || null]
    );
    const orgId = orgResult.rows[0].id;
    
    const userResult = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, phone) 
       VALUES ($1, $2, $3, $4, $5, 'admin', $6) 
       RETURNING id, email, first_name, last_name, role`,
      [orgId, email, passwordHash, firstName, lastName, phone || null]
    );
    const user = userResult.rows[0];
    
    const token = jwt.sign(
      { userId: user.id, organizationId: orgId, email: user.email, role: user.role },
      JWT_SECRET, { expiresIn: '7d' }
    );
    
    res.status(201).json({ 
      token, 
      user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role, organizationId: orgId }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query(
      `SELECT id, password_hash, first_name, last_name, role, organization_id
       FROM users WHERE email = $1`, [email]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, email, role: user.role },
      JWT_SECRET, { expiresIn: '7d' }
    );
    
    res.json({ 
      token,
      user: { id: user.id, email, firstName: user.first_name, lastName: user.last_name, role: user.role, organizationId: user.organization_id }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === STATS ===
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const orgId = req.user.organizationId;
    const [cases, fysika, nomika, actions, docs] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM ypotheseis WHERE organization_id = $1', [orgId]),
      pool.query('SELECT COUNT(*) FROM fysika_prosopa WHERE organization_id = $1', [orgId]),
      pool.query('SELECT COUNT(*) FROM nomika_prosopa WHERE organization_id = $1', [orgId]),
      pool.query('SELECT COUNT(*) FROM dikastiria_energeies WHERE organization_id = $1', [orgId]),
      pool.query('SELECT COUNT(*) FROM case_documents WHERE organization_id = $1', [orgId])
    ]);
    
    res.json({
      cases: parseInt(cases.rows[0].count),
      fysika: parseInt(fysika.rows[0].count),
      nomika: parseInt(nomika.rows[0].count),
      actions: parseInt(actions.rows[0].count),
      documents: parseInt(docs.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === CASES (Υποθέσεις) ===
app.get('/api/cases', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT y.*, 
        COALESCE(fp.eponymo || ' ' || fp.onoma, np.eponymia) as client_name,
        yo.name as case_type
       FROM ypotheseis y
       LEFT JOIN fysika_prosopa fp ON y.fysiko_prosopo_id = fp.id
       LEFT JOIN nomika_prosopa np ON y.nomiko_prosopo_id = np.id
       LEFT JOIN ypotheseis_onomasies yo ON y.onomasia_id = yo.id
       WHERE y.organization_id = $1
       ORDER BY y.created_at DESC`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cases', authMiddleware, async (req, res) => {
  try {
    const { xeirokinito_id, perilipsi, fysiko_prosopo_id, nomiko_prosopo_id, status, starting_date } = req.body;
    const result = await pool.query(
      `INSERT INTO ypotheseis (organization_id, xeirokinito_id, perilipsi, fysiko_prosopo_id, nomiko_prosopo_id, status, starting_date) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.organizationId, xeirokinito_id, perilipsi, fysiko_prosopo_id || null, nomiko_prosopo_id || null, status || 'open', starting_date || new Date()]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cases/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM ypotheseis WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cases/:id', authMiddleware, async (req, res) => {
  try {
    const { xeirokinito_id, perilipsi, status } = req.body;
    const result = await pool.query(
      `UPDATE ypotheseis SET xeirokinito_id = $1, perilipsi = $2, status = $3, updated_at = NOW() 
       WHERE id = $4 AND organization_id = $5 RETURNING *`,
      [xeirokinito_id, perilipsi, status, req.params.id, req.user.organizationId]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cases/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM ypotheseis WHERE id = $1 AND organization_id = $2', 
      [req.params.id, req.user.organizationId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === FYSIKA PROSOPA (Φυσικά Πρόσωπα) ===
app.get('/api/fysika', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM fysika_prosopa WHERE organization_id = $1 ORDER BY eponymo, onoma`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fysika', authMiddleware, async (req, res) => {
  try {
    const { eponymo, onoma, fatherName, afm, birthDate, nationality, profession } = req.body;
    const result = await pool.query(
      `INSERT INTO fysika_prosopa (organization_id, eponymo, onoma, "fatherName", afm, "birthDate", nationality, profession) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.organizationId, eponymo, onoma, fatherName || null, afm || null, birthDate || null, nationality || null, profession || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/fysika/:id', authMiddleware, async (req, res) => {
  try {
    const { eponymo, onoma, fatherName, afm, birthDate, nationality, profession } = req.body;
    const result = await pool.query(
      `UPDATE fysika_prosopa SET eponymo=$1, onoma=$2, "fatherName"=$3, afm=$4, "birthDate"=$5, nationality=$6, profession=$7, updated_at=NOW()
       WHERE id=$8 AND organization_id=$9 RETURNING *`,
      [eponymo, onoma, fatherName, afm, birthDate, nationality, profession, req.params.id, req.user.organizationId]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/fysika/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM fysika_prosopa WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === NOMIKA PROSOPA (Νομικά Πρόσωπα) ===
app.get('/api/nomika', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM nomika_prosopa WHERE organization_id = $1 ORDER BY eponymia`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nomika', authMiddleware, async (req, res) => {
  try {
    const { eponymia, afm, doy, legal_form, headquarters, city } = req.body;
    const result = await pool.query(
      `INSERT INTO nomika_prosopa (organization_id, eponymia, afm, doy, legal_form, headquarters, city) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.organizationId, eponymia, afm || null, doy || null, legal_form || null, headquarters || null, city || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/nomika/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM nomika_prosopa WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === COURTS (Δικαστήρια) ===
app.get('/api/courts', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM dikastiria WHERE organization_id = $1 ORDER BY name`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/courts', authMiddleware, async (req, res) => {
  try {
    const { name, city, phone, address, court_type } = req.body;
    const result = await pool.query(
      `INSERT INTO dikastiria (organization_id, name, city, phone, address, court_type) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.organizationId, name, city || null, phone || null, address || null, court_type || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/courts/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM dikastiria WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === COURT ACTIONS (Δικαστικές Ενέργειες) ===
app.get('/api/actions', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT de.*, y.xeirokinito_id, d.name as court_name
       FROM dikastiria_energeies de
       LEFT JOIN ypotheseis y ON de.ypothesi_id = y.id
       LEFT JOIN dikastiria d ON de.dikastirio_id = d.id
       WHERE de.organization_id = $1
       ORDER BY de.next_hearing_date DESC NULLS LAST`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/actions', authMiddleware, async (req, res) => {
  try {
    const { ypothesi_id, dikastirio_id, energeia_date, next_hearing_date, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO dikastiria_energeies (organization_id, ypothesi_id, dikastirio_id, energeia_date, next_hearing_date, notes) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.organizationId, ypothesi_id, dikastirio_id || null, energeia_date || null, next_hearing_date || null, notes || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/actions/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM dikastiria_energeies WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === LAWYERS (Δικηγόροι Γραφείου) ===
app.get('/api/lawyers', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM dikigoroi_grafeiou WHERE organization_id = $1 ORDER BY eponymo`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lawyers', authMiddleware, async (req, res) => {
  try {
    const { eponymo, onoma, afm, bar_id, specialization, phone } = req.body;
    const result = await pool.query(
      `INSERT INTO dikigoroi_grafeiou (organization_id, eponymo, onoma, afm, bar_id, specialization, phone) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.organizationId, eponymo, onoma || null, afm || null, bar_id || null, specialization || null, phone || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lawyers/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM dikigoroi_grafeiou WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === FINANCE (Οικονομικά) ===
app.get('/api/finance', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fc.*, y.xeirokinito_id 
       FROM finance_case fc
       LEFT JOIN ypotheseis y ON fc.ypothesi_id = y.id
       WHERE fc.organization_id = $1
       ORDER BY fc.created_at DESC`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/finance', authMiddleware, async (req, res) => {
  try {
    const { ypothesi_id, metrimenes_ores, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO finance_case (organization_id, ypothesi_id, metrimenes_ores, notes) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.organizationId, ypothesi_id, metrimenes_ores || 0, notes || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === TEAM (Users) ===
app.get('/api/team', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, phone, is_active, created_at
       FROM users WHERE organization_id = $1 ORDER BY created_at`,
      [req.user.organizationId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/team', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins' });
    
    const { email, password, firstName, lastName, role, phone } = req.body;
    const passwordHash = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, phone) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING id, email, first_name, last_name, role, phone`,
      [req.user.organizationId, email, passwordHash, firstName, lastName, role, phone || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === START ===
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Thesis API v2 on port ${PORT}`);
  await initDatabase();
});
