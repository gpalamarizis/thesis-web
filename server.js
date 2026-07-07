import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';

dotenv.config();

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(cors());
app.use(express.json());

// Auto-run schema on startup
async function initDatabase() {
  try {
    const schema = fs.readFileSync('./schema.sql', 'utf8');
    await pool.query(schema);
    console.log('✅ Database schema created');
  } catch (err) {
    console.log('Schema already exists or error:', err.message);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Thesis API is running' });
});

app.get('/api/tables', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    res.json({ tables: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Thesis API on port ${PORT}`);
  await initDatabase();
});