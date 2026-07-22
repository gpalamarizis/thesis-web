// src/routes/schema-inspect.js
// Admin endpoint to dump DB schema information as tab-separated text.
// Auth: X-CRON-KEY header (same as cron endpoints).
//
// GET /api/admin/schema-inspect
//   ?table=users        (optional: limit output to specific table columns)

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.use((req, res, next) => {
  const key = req.headers['x-cron-key'];
  if (!process.env.CRON_SECRET) {
    return res.status(500).type('text/plain').send('CRON_SECRET not configured');
  }
  if (key !== process.env.CRON_SECRET) {
    return res.status(403).type('text/plain').send('Invalid key');
  }
  next();
});

const QUERIES = [
  {
    name: 'ALL TABLES IN public SCHEMA',
    sql: `SELECT t.table_name,
            (SELECT COUNT(*) FROM information_schema.columns c
             WHERE c.table_name = t.table_name AND c.table_schema='public') AS n_cols
          FROM information_schema.tables t
          WHERE t.table_schema = 'public'
          ORDER BY t.table_name`
  },
  {
    name: 'ALL COLUMNS OF ALL public TABLES',
    sql: `SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position`
  },
  {
    name: 'ROW COUNTS',
    sql: `SELECT relname AS table_name, n_live_tup AS approx_row_count
          FROM pg_stat_user_tables
          WHERE schemaname = 'public'
          ORDER BY relname`
  },
  {
    name: 'FOREIGN KEY CONSTRAINTS',
    sql: `SELECT
            tc.table_name AS from_table,
            kcu.column_name AS from_column,
            ccu.table_name AS to_table,
            ccu.column_name AS to_column
          FROM information_schema.table_constraints AS tc
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
          ORDER BY tc.table_name, kcu.column_name`
  },
  {
    name: 'INDEXES',
    sql: `SELECT tablename, indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = 'public'
          ORDER BY tablename, indexname`
  }
];

router.get('/schema-inspect', async (req, res) => {
  const lines = [];
  lines.push('DB Schema Dump');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('='.repeat(80));

  const tableFilter = req.query.table;

  for (const q of QUERIES) {
    lines.push('');
    lines.push('='.repeat(80));
    lines.push('== ' + q.name);
    lines.push('='.repeat(80));

    let sql = q.sql;
    if (tableFilter && (q.name.includes('COLUMNS') || q.name.includes('CONSTRAINT'))) {
      sql = sql.replace('ORDER BY', "AND table_name = '" + tableFilter.replace(/'/g, "''") + "' ORDER BY");
    }

    try {
      const result = await pool.query(sql);
      if (result.rows.length === 0) {
        lines.push('(no rows)');
      } else {
        const cols = Object.keys(result.rows[0]);
        lines.push(cols.join('\t'));
        lines.push(cols.map(() => '---').join('\t'));
        for (const row of result.rows) {
          lines.push(cols.map(c => {
            const v = row[c];
            if (v === null) return 'NULL';
            if (v === undefined) return '';
            return String(v).replace(/\n/g, ' ').replace(/\t/g, ' ');
          }).join('\t'));
        }
        lines.push('');
        lines.push('(' + result.rows.length + ' rows)');
      }
    } catch (err) {
      lines.push('ERROR: ' + err.message);
    }
  }

  res.type('text/plain; charset=utf-8').send(lines.join('\n'));
});

module.exports = router;
