// Migration runner για v3.
//
// Χρήση:
//   node scripts/migrate.js              → μόνο schema (safe, IF NOT EXISTS)
//   node scripts/migrate.js --drop-v2    → drop όλων των v2 tables + apply schema
//   node scripts/migrate.js --reset      → drop everything + apply schema (ΠΡΟΣΟΧΗ)
//
// Απαιτεί: DATABASE_URL στο environment

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const dropV2 = args.includes('--drop-v2') || args.includes('--reset');
const reset  = args.includes('--reset');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL δεν έχει οριστεί.');
  process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production' || /railway|neon|supabase|amazonaws/i.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15_000,
});

async function readSql(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

async function main() {
  console.log('▶ Connecting to database...');
  const client = await pool.connect();

  try {
    if (reset) {
      console.log('⚠  --reset: dropping public schema...');
      await client.query('DROP SCHEMA public CASCADE;');
      await client.query('CREATE SCHEMA public;');
      console.log('   ✅ schema recreated.');
    } else if (dropV2) {
      console.log('▶ Running sql/drop_v2.sql ...');
      const dropSql = await readSql('sql/drop_v2.sql');
      await client.query(dropSql);
      console.log('   ✅ v2 tables dropped.');
    }

    console.log('▶ Running sql/schema.sql ...');
    const schema = await readSql('sql/schema.sql');
    await client.query(schema);
    console.log('   ✅ v3 schema applied.');

    // Επαλήθευση
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    console.log(`\n✅ Migration ολοκληρώθηκε. Πίνακες στο public schema: ${r.rows[0].c}`);

    const list = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'
        ORDER BY table_name`
    );
    console.log('\nΠίνακες:');
    for (const row of list.rows) console.log(`  • ${row.table_name}`);

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
