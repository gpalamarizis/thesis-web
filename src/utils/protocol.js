// Λογική αριθμού πρωτοκόλλου από VB.NET Common.GetNewProtocolNumber
//
// Format:  <CLIENT_ID><Φ ή Ν>/<αριθμός_υπόθεσης_πελάτη>/<συνολικός_αρ_γραφείου>
// Παράδειγμα:  5Φ/3/127
//   • 5   = ID πελάτη (fysiko_prosopo.aa ή nomiko_prosopo.aa)
//   • Φ|Ν = Φυσικό / Νομικό πρόσωπο
//   • 3   = 3η υπόθεση αυτού του πελάτη
//   • 127 = συνολικά η 127η υπόθεση του γραφείου

async function computeProtocolNumber(client, {
  organizationId,
  clientType,   // 'fysiko' | 'nomiko'
  clientId,     // number
}) {
  const prefix = clientType === 'fysiko' ? 'Φ' : 'Ν';
  const col    = clientType === 'fysiko' ? 'fysiko_prosopo_id' : 'nomiko_prosopo_id';

  const totalPerClient = await client.query(
    `SELECT COUNT(*)::int AS c FROM ypotheseis
      WHERE organization_id = $1 AND ${col} = $2`,
    [organizationId, clientId]
  );

  const totalOrg = await client.query(
    `SELECT COALESCE(MAX(aa),0)::int AS m FROM ypotheseis
      WHERE organization_id = $1`,
    [organizationId]
  );

  const clientCount = totalPerClient.rows[0].c + 1;
  const orgCount    = totalOrg.rows[0].m + 1;

  return `${clientId}${prefix}/${clientCount}/${orgCount}`;
}

// Δημόσιο endpoint για preview (χωρίς commit)
async function previewProtocolNumber(pool, { organizationId, clientType, clientId }) {
  return computeProtocolNumber(pool, { organizationId, clientType, clientId });
}

// Parse: "5Φ/3/127" → { clientId: 5, type: 'fysiko', clientCount: 3, orgCount: 127 }
function parseProtocol(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)([ΦΝ])\/(\d+)\/(\d+)$/);
  if (!m) return null;
  return {
    clientId:    parseInt(m[1], 10),
    type:        m[2] === 'Φ' ? 'fysiko' : 'nomiko',
    clientCount: parseInt(m[3], 10),
    orgCount:    parseInt(m[4], 10),
  };
}

module.exports = { computeProtocolNumber, previewProtocolNumber, parseProtocol };
