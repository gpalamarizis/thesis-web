// src/utils/protocol.js
// v2: Αριθμός πρωτοκόλλου με per-organization σειριακό πελάτη (client_no).
//
// Format:  <CLIENT_NO><Φ|Ν>/<αρ. υπόθεσης πελάτη>/<αρ. υπόθεσης γραφείου>
// Παράδειγμα:  2Φ/1/1
//   • 2   = ο 2ος φυσικός πελάτης ΑΥΤΟΥ του γραφείου (client_no, όχι το aa)
//   • Φ|Ν = Φυσικό / Νομικό πρόσωπο (ξεχωριστοί μετρητές)
//   • 1   = 1η υπόθεση αυτού του πελάτη
//   • 1   = 1η υπόθεση του γραφείου συνολικά
//
// ΑΛΛΑΓΕΣ από v1:
//   * Χρησιμοποιεί fysika_prosopa.client_no / nomika_prosopa.client_no
//     αντί για το παγκόσμιο aa. Νέο γραφείο ξεκινά από 1.
//   * Αν ο πελάτης δεν έχει ακόμα client_no, του ανατίθεται ο επόμενος
//     διαθέσιμος για τον τύπο του, μέσα στον οργανισμό (με κλείδωμα).
//   * orgCount = ΜΕΓΑΛΥΤΕΡΟ τρίτο πεδίο + 1 (ασφαλές σε διαγραφές).
//   * clientCount = MAX δεύτερου πεδίου + 1, ώστε να μην επαναλαμβάνεται
//     μετά από διαγραφή.

// Εξασφαλίζει ότι ο πελάτης έχει client_no. Αν λείπει, αναθέτει τον επόμενο.
// Δέχεται client (μπορεί να είναι pool ή transaction client).
async function ensureClientNo(client, { organizationId, clientType, clientId }) {
  const table = clientType === 'fysiko' ? 'fysika_prosopa' : 'nomika_prosopa';

  // Υπάρχει ήδη;
  const existing = await client.query(
    `SELECT client_no FROM ${table} WHERE aa = $1 AND organization_id = $2`,
    [clientId, organizationId]
  );
  if (existing.rows.length && existing.rows[0].client_no != null) {
    return existing.rows[0].client_no;
  }

  // Ανάθεση επόμενου. Κλείδωμα των γραμμών του org για αποφυγή race condition.
  await client.query(
    `SELECT 1 FROM ${table} WHERE organization_id = $1 FOR UPDATE`,
    [organizationId]
  );
  const maxR = await client.query(
    `SELECT COALESCE(MAX(client_no), 0)::int AS m FROM ${table} WHERE organization_id = $1`,
    [organizationId]
  );
  const next = maxR.rows[0].m + 1;

  await client.query(
    `UPDATE ${table} SET client_no = $1 WHERE aa = $2 AND organization_id = $3`,
    [next, clientId, organizationId]
  );
  return next;
}

async function computeProtocolNumber(client, {
  organizationId,
  clientType,   // 'fysiko' | 'nomiko'
  clientId,     // number (το aa του πελάτη)
}) {
  const prefix = clientType === 'fysiko' ? 'Φ' : 'Ν';
  const col    = clientType === 'fysiko' ? 'fysiko_prosopo_id' : 'nomiko_prosopo_id';

  const clientNo = await ensureClientNo(client, { organizationId, clientType, clientId });

  // clientCount = μεγαλύτερο δεύτερο πεδίο που έχει ήδη ο πελάτης, +1.
  // Διαβάζεται από τα υπάρχοντα πρωτόκολλα ώστε να μην επαναληφθεί μετά από διαγραφή.
  const perClient = await client.query(
    `SELECT COALESCE(MAX(
              NULLIF(regexp_replace(xeirokinito_id, '^[0-9]+[ΦΝ]/([0-9]+)/.*$', '\\1'), '')::int
            ), 0)::int AS m
       FROM ypotheseis
      WHERE organization_id = $1 AND ${col} = $2
        AND xeirokinito_id ~ '^[0-9]+[ΦΝ]/[0-9]+/'`,
    [organizationId, clientId]
  );
  const clientCount = perClient.rows[0].m + 1;

  // orgCount = πλήθος υποθέσεων του γραφείου + 1
  // orgCount = ΜΕΓΑΛΥΤΕΡΟΣ υπάρχων αριθμός γραφείου + 1.
  //
  // ΓΙΑΤΙ ΟΧΙ COUNT(*): αν διαγραφεί υπόθεση, το πλήθος μειώνεται και ο
  // επόμενος αριθμός θα ξαναδινόταν σε άλλη υπόθεση -> ΔΙΠΛΟ ΠΡΩΤΟΚΟΛΛΟ.
  // Με MAX, όσες κι αν διαγραφούν, αριθμός δεν επαναλαμβάνεται ποτέ.
  const orgR = await client.query(
    `SELECT COALESCE(MAX(
              NULLIF(regexp_replace(xeirokinito_id, '^[0-9]+[ΦΝ]/[0-9]+/([0-9]+)$', '\\1'), '')::int
            ), 0)::int AS m
       FROM ypotheseis
      WHERE organization_id = $1
        AND xeirokinito_id ~ '^[0-9]+[ΦΝ]/[0-9]+/[0-9]+$'`,
    [organizationId]
  );
  const orgCount = orgR.rows[0].m + 1;

  return `${clientNo}${prefix}/${clientCount}/${orgCount}`;
}

// Preview (read-only): ΔΕΝ αναθέτει client_no αν λείπει — δείχνει τι ΘΑ γίνει.
async function previewProtocolNumber(pool, { organizationId, clientType, clientId }) {
  const prefix = clientType === 'fysiko' ? 'Φ' : 'Ν';
  const col    = clientType === 'fysiko' ? 'fysiko_prosopo_id' : 'nomiko_prosopo_id';
  const table  = clientType === 'fysiko' ? 'fysika_prosopa' : 'nomika_prosopa';

  // client_no: το υπάρχον, αλλιώς πρόβλεψη του επόμενου (χωρίς εγγραφή)
  const cur = await pool.query(
    `SELECT client_no FROM ${table} WHERE aa = $1 AND organization_id = $2`,
    [clientId, organizationId]
  );
  let clientNo;
  if (cur.rows.length && cur.rows[0].client_no != null) {
    clientNo = cur.rows[0].client_no;
  } else {
    const maxR = await pool.query(
      `SELECT COALESCE(MAX(client_no), 0)::int AS m FROM ${table} WHERE organization_id = $1`,
      [organizationId]
    );
    clientNo = maxR.rows[0].m + 1;
  }

  const perClient = await pool.query(
    `SELECT COALESCE(MAX(
              NULLIF(regexp_replace(xeirokinito_id, '^[0-9]+[ΦΝ]/([0-9]+)/.*$', '\\1'), '')::int
            ), 0)::int AS m
       FROM ypotheseis
      WHERE organization_id = $1 AND ${col} = $2
        AND xeirokinito_id ~ '^[0-9]+[ΦΝ]/[0-9]+/'`,
    [organizationId, clientId]
  );
  const clientCount = perClient.rows[0].m + 1;

  // Ίδια λογική με το computeProtocolNumber — MAX, όχι COUNT
  const orgR = await pool.query(
    `SELECT COALESCE(MAX(
              NULLIF(regexp_replace(xeirokinito_id, '^[0-9]+[ΦΝ]/[0-9]+/([0-9]+)$', '\\1'), '')::int
            ), 0)::int AS m
       FROM ypotheseis
      WHERE organization_id = $1
        AND xeirokinito_id ~ '^[0-9]+[ΦΝ]/[0-9]+/[0-9]+$'`,
    [organizationId]
  );
  const orgCount = orgR.rows[0].m + 1;

  return `${clientNo}${prefix}/${clientCount}/${orgCount}`;
}

// Parse: "2Φ/1/1" → { clientNo: 2, type: 'fysiko', clientCount: 1, orgCount: 1 }
function parseProtocol(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)([ΦΝ])\/(\d+)\/(\d+)$/);
  if (!m) return null;
  return {
    clientNo:    parseInt(m[1], 10),
    type:        m[2] === 'Φ' ? 'fysiko' : 'nomiko',
    clientCount: parseInt(m[3], 10),
    orgCount:    parseInt(m[4], 10),
  };
}

module.exports = { computeProtocolNumber, previewProtocolNumber, parseProtocol, ensureClientNo };
