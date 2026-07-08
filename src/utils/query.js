// Μικρά helpers για routes

function pickAllowed(body, allowed) {
  const out = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

// Χτίζει INSERT ($1, $2, ...) από object + organization_id
function buildInsert(table, orgId, data, extraCols = {}) {
  const merged = { organization_id: orgId, ...data, ...extraCols };
  const cols   = Object.keys(merged);
  const vals   = Object.values(merged);
  const ph     = cols.map((_, i) => `$${i + 1}`).join(', ');
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
    vals,
  };
}

// Χτίζει UPDATE ... SET col = $n, ... WHERE aa = $N AND organization_id = $N+1
function buildUpdate(table, orgId, id, data, pk = 'aa') {
  const cols = Object.keys(data);
  if (cols.length === 0) return null;
  const set  = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const vals = [...Object.values(data), id, orgId];
  return {
    sql: `UPDATE ${table} SET ${set}
           WHERE ${pk} = $${cols.length + 1} AND organization_id = $${cols.length + 2}
       RETURNING *`,
    vals,
  };
}

module.exports = { pickAllowed, buildInsert, buildUpdate };
