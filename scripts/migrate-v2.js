// scripts/migrate-v2.js
// Incremental migration runner with tracking table `schema_migrations`.
//
// Usage:
//   node scripts/migrate-v2.js              → apply pending migrations
//   node scripts/migrate-v2.js --status     → show applied/pending list
//   node scripts/migrate-v2.js --dry-run    → show what would run, no changes
//   node scripts/migrate-v2.js --baseline   → mark ALL current migration files as applied (bootstrap)
//
// Migration files: sql/migrations/*.sql (sorted alphabetically by filename)
// Each migration runs in a transaction. If it fails, rollback and stop.
//
// Requires: DATABASE_URL in environment (Railway provides this).

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const isStatus   = args.includes('--status');
const isDryRun   = args.includes('--dry-run');
const isBaseline = args.includes('--baseline');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set.');
  process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production' || /railway|neon|supabase|amazonaws/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15_000,
});

const MIGRATIONS_DIR = path.join(__dirname, '..', 'sql', 'migrations');

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMap(client) {
  const r = await client.query('SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename');
  const map = new Map();
  for (const row of r.rows) map.set(row.filename, row);
  return map;
}

async function runStatus(client) {
  await ensureTrackingTable(client);
  const applied = await getAppliedMap(client);
  const files = listMigrationFiles();

  console.log('\n=== Migration Status ===\n');
  if (files.length === 0) {
    console.log('  (no migration files in sql/migrations/)');
    return;
  }
  for (const f of files) {
    const a = applied.get(f);
    if (a) {
      const date = new Date(a.applied_at).toISOString().replace('T', ' ').slice(0, 19);
      console.log(`  ✓ ${f}  (applied ${date} UTC)`);
    } else {
      console.log(`  · ${f}  [PENDING]`);
    }
  }
  // Warn on orphan applied entries
  for (const [f] of applied) {
    if (!files.includes(f)) {
      console.log(`  ⚠  ${f}  [applied but file missing from disk]`);
    }
  }
  const pending = files.filter(f => !applied.has(f)).length;
  console.log(`\n  Total: ${files.length} files, ${applied.size} applied, ${pending} pending\n`);
}

async function runBaseline(client) {
  await ensureTrackingTable(client);
  const files = listMigrationFiles();
  if (files.length === 0) {
    console.log('  (no migration files to baseline)');
    return;
  }
  console.log(`▶ Marking ${files.length} migration file(s) as applied (baseline mode)...`);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const cs = checksum(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, applied_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (filename) DO NOTHING`,
      [f, cs]
    );
    console.log(`  ✓ ${f}`);
  }
  console.log('\n✅ Baseline complete. Future runs will only apply new files.\n');
}

async function runUp(client) {
  await ensureTrackingTable(client);
  const applied = await getAppliedMap(client);
  const files = listMigrationFiles();
  const pending = files.filter(f => !applied.has(f));

  if (pending.length === 0) {
    console.log('✅ No pending migrations. Database is up to date.');
    return;
  }

  console.log(`▶ ${pending.length} pending migration(s) to apply${isDryRun ? ' (dry-run)' : ''}:`);
  for (const f of pending) console.log(`  · ${f}`);
  console.log('');

  for (const f of pending) {
    const filePath = path.join(MIGRATIONS_DIR, f);
    const sql = fs.readFileSync(filePath, 'utf8');
    const cs = checksum(sql);

    if (isDryRun) {
      console.log(`▶ [dry-run] would apply: ${f}  (checksum ${cs})`);
      continue;
    }

    console.log(`▶ Applying ${f} ...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
        [f, cs]
      );
      await client.query('COMMIT');
      console.log(`  ✓ ${f} applied.`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error(`\n❌ Migration failed: ${f}`);
      console.error(`   ${err.message}`);
      throw err;
    }
  }
  console.log(`\n✅ Applied ${pending.length} migration(s) successfully.\n`);
}

async function main() {
  console.log('▶ Connecting to database...');
  const client = await pool.connect();
  try {
    if (isStatus) {
      await runStatus(client);
    } else if (isBaseline) {
      await runBaseline(client);
    } else {
      await runUp(client);
    }
  } catch (err) {
    console.error('\n❌ Migration runner failed:', err.message);
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
