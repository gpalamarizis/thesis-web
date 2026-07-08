const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const router = express.Router();

router.get('/tables', async (req, res) => {
  try {
    const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
    res.json({ count: r.rows.length, tables: r.rows.map(x => x.table_name) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/run-migration', async (req, res) => {
  if (req.query.secret !== process.env.MIGRATION_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const client = await pool.connect();
  const log = [];
  try {
    const dropSql = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'drop_v2.sql'), 'utf8');
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'schema.sql'), 'utf8');
    log.push('Dropping v2');
    await client.query(dropSql);
    log.push('Applying v3 schema');
    await client.query(schemaSql);
    const r = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
    log.push('Total tables: ' + r.rows.length);
    res.json({ ok: true, log, tables: r.rows.map(x => x.table_name) });
  } catch (err) {
    log.push('ERROR: ' + err.message);
    res.status(500).json({ ok: false, log, error: err.message });
  } finally { client.release(); }
});

module.exports = router;
