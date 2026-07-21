const { Pool } = require('pg');
const p = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const q = async (t) => {
    const r = await p.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
      [t]
    );
    console.log('\n=== ' + t + ' ===');
    if (r.rows.length === 0) {
      console.log('(table does not exist)');
    } else {
      console.table(r.rows);
    }
  };

  await q('energeies');
  await q('ypotheseis_xeiristes');
  await q('energeies_xeiristes');
  await q('xeiristes');

  const x = await p.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%xeirist%' OR table_name ILIKE '%dikigor%' OR table_name ILIKE '%energei%') ORDER BY table_name"
  );
  console.log('\n=== related tables ===');
  console.table(x.rows);

  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
