const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeProtocolNumber, previewProtocolNumber } = require('../utils/protocol');

const router = express.Router();
router.use(requireAuth);

// GET /api/cases/preview-protocol?clientType=fysiko&clientId=5
router.get('/preview-protocol', async (req, res) => {
  try {
    const { clientType, clientId } = req.query;
    if (!clientType || !clientId) return res.status(400).json({ error: 'clientType + clientId required' });
    if (!['fysiko', 'nomiko'].includes(clientType)) return res.status(400).json({ error: 'clientType must be fysiko|nomiko' });

    const proto = await previewProtocolNumber(pool, {
      organizationId: req.user.organization_id,
      clientType,
      clientId: parseInt(clientId, 10),
    });
    res.json({ xeirokinito_id: proto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cases?ekkremis=true&q=...&page=1&pageSize=20
router.get('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const page      = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize  = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  const offset    = (page - 1) * pageSize;

  const filters = ['y.organization_id = $1'];
  const params  = [orgId];
  let i = 2;

  if (req.query.ekkremis === 'true')  { filters.push(`y.ekkremis = TRUE`); }
  if (req.query.ekkremis === 'false') { filters.push(`y.ekkremis = FALSE`); }
  if (req.query.q) {
    filters.push(`(y.xeirokinito_id ILIKE $${i} OR y.perilipsi ILIKE $${i} OR y.onomasia_fakelou ILIKE $${i})`);
    params.push(`%${req.query.q}%`); i++;
  }
  if (req.query.fysiko_prosopo_id) {
    filters.push(`y.fysiko_prosopo_id = $${i}`);
    params.push(parseInt(req.query.fysiko_prosopo_id, 10)); i++;
  }
  if (req.query.nomiko_prosopo_id) {
    filters.push(`y.nomiko_prosopo_id = $${i}`);
    params.push(parseInt(req.query.nomiko_prosopo_id, 10)); i++;
  }

  const where = filters.join(' AND ');
  try {
    const countR = await pool.query(`SELECT COUNT(*)::int AS c FROM ypotheseis y WHERE ${where}`, params);
    const rowsR = await pool.query(
      `SELECT y.*,
              yo.name AS onomasia_name,
              th.name AS thesi_name,
              ta.name AS thesi_arxeiothetisis_name,
              a.eponymo AS antidikos_eponymo,
              fp.eponymo || ' ' || COALESCE(fp.onoma,'') AS fysiko_full_name,
              np.eponymia AS nomiko_eponymia
         FROM ypotheseis y
    LEFT JOIN ypotheseis_onomasies yo ON yo.aa = y.onomasia_id
    LEFT JOIN thesi                  th ON th.aa = y.thesi
    LEFT JOIN theseis_arxeiothetisis ta ON ta.aa = y.thesi_arxeiothetisis_id
    LEFT JOIN antidikoi              a  ON a.aa  = y.diadikos_id
    LEFT JOIN fysika_prosopa         fp ON fp.aa = y.fysiko_prosopo_id
    LEFT JOIN nomika_prosopa         np ON np.aa = y.nomiko_prosopo_id
        WHERE ${where}
        ORDER BY y.date_eisagogis DESC NULLS LAST, y.aa DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({ data: rowsR.rows, total: countR.rows[0].c, page, pageSize });
  } catch (err) {
    console.error('[cases GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cases/:id
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT y.*,
              yo.name AS onomasia_name,
              th.name AS thesi_name,
              ta.name AS thesi_arxeiothetisis_name,
              a.eponymo AS antidikos_eponymo,
              fp.eponymo || ' ' || COALESCE(fp.onoma,'') AS fysiko_full_name,
              np.eponymia AS nomiko_eponymia
         FROM ypotheseis y
    LEFT JOIN ypotheseis_onomasies yo ON yo.aa = y.onomasia_id
    LEFT JOIN thesi                  th ON th.aa = y.thesi
    LEFT JOIN theseis_arxeiothetisis ta ON ta.aa = y.thesi_arxeiothetisis_id
    LEFT JOIN antidikoi              a  ON a.aa  = y.diadikos_id
    LEFT JOIN fysika_prosopa         fp ON fp.aa = y.fysiko_prosopo_id
    LEFT JOIN nomika_prosopa         np ON np.aa = y.nomiko_prosopo_id
        WHERE y.aa = $1 AND y.organization_id = $2`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const caseRow = r.rows[0];

    // Χειριστές (case-lawyers)
    const lawyersR = await pool.query(
      `SELECT dg.aa, dg.eponymo, dg.onoma
         FROM xeiristes_dikigoroi xd
         JOIN dikigoroi_grafeiou  dg ON dg.aa = xd.dikigoroi_grafeiou_id
        WHERE xd.ypotheseis_id = $1 AND xd.organization_id = $2`,
      [req.params.id, req.user.organization_id]
    );

    res.json({ ...caseRow, xeiristes: lawyersR.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cases
router.post('/', async (req, res) => {
  const orgId = req.user.organization_id;
  const b = req.body || {};

  if (!b.clientType || !b.clientId) {
    return res.status(400).json({ error: 'clientType (fysiko|nomiko) + clientId required' });
  }
  if (!['fysiko', 'nomiko'].includes(b.clientType)) {
    return res.status(400).json({ error: 'clientType must be fysiko|nomiko' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const xeirokinito_id = b.xeirokinito_id_override
      || (await computeProtocolNumber(client, {
        organizationId: orgId,
        clientType: b.clientType,
        clientId: b.clientId,
      }));

    const insert = await client.query(
      `INSERT INTO ypotheseis (
         organization_id, xeirokinito_id, onomasia_id, date_eisagogis, date_telous,
         onomasia_fakelou, ekkremis, perilipsi,
         fysiko_prosopo_id, nomiko_prosopo_id,
         thesi, diadikos_id, thesi_arxeiothetisis_id,
         arithmos_apofasis, dekti, merikos_dekti, aporriptea, old_kod, prosvalomeni
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        orgId,
        xeirokinito_id,
        b.onomasia_id || null,
        b.date_eisagogis || null,
        b.date_telous   || null,
        b.onomasia_fakelou || null,
        b.ekkremis !== false,
        b.perilipsi || null,
        b.clientType === 'fysiko' ? b.clientId : null,
        b.clientType === 'nomiko' ? b.clientId : null,
        b.thesi || null,
        b.diadikos_id || null,
        b.thesi_arxeiothetisis_id || null,
        b.arithmos_apofasis || null,
        !!b.dekti,
        !!b.merikos_dekti,
        !!b.aporriptea,
        b.old_kod || null,
        b.prosvalomeni || null,
      ]
    );
    const caseId = insert.rows[0].aa;

    // Χειριστές δικηγόροι
    if (Array.isArray(b.xeiristes_ids)) {
      for (const dgId of b.xeiristes_ids) {
        await client.query(
          `INSERT INTO xeiristes_dikigoroi (organization_id, ypotheseis_id, dikigoroi_grafeiou_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [orgId, caseId, dgId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[cases POST]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/cases/:id
router.put('/:id', async (req, res) => {
  const orgId = req.user.organization_id;
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `UPDATE ypotheseis SET
         onomasia_id             = COALESCE($1, onomasia_id),
         date_eisagogis          = COALESCE($2, date_eisagogis),
         date_telous             = COALESCE($3, date_telous),
         onomasia_fakelou        = COALESCE($4, onomasia_fakelou),
         ekkremis                = COALESCE($5, ekkremis),
         perilipsi               = COALESCE($6, perilipsi),
         thesi                   = COALESCE($7, thesi),
         diadikos_id             = COALESCE($8, diadikos_id),
         thesi_arxeiothetisis_id = COALESCE($9, thesi_arxeiothetisis_id),
         arithmos_apofasis       = COALESCE($10, arithmos_apofasis),
         dekti                   = COALESCE($11, dekti),
         merikos_dekti           = COALESCE($12, merikos_dekti),
         aporriptea              = COALESCE($13, aporriptea),
         old_kod                 = COALESCE($14, old_kod),
         prosvalomeni            = COALESCE($15, prosvalomeni),
         updated_at              = NOW()
       WHERE aa = $16 AND organization_id = $17
       RETURNING *`,
      [
        b.onomasia_id ?? null,
        b.date_eisagogis ?? null,
        b.date_telous ?? null,
        b.onomasia_fakelou ?? null,
        typeof b.ekkremis === 'boolean' ? b.ekkremis : null,
        b.perilipsi ?? null,
        b.thesi ?? null,
        b.diadikos_id ?? null,
        b.thesi_arxeiothetisis_id ?? null,
        b.arithmos_apofasis ?? null,
        typeof b.dekti === 'boolean' ? b.dekti : null,
        typeof b.merikos_dekti === 'boolean' ? b.merikos_dekti : null,
        typeof b.aporriptea === 'boolean' ? b.aporriptea : null,
        b.old_kod ?? null,
        b.prosvalomeni ?? null,
        id, orgId,
      ]
    );

    if (r.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    if (Array.isArray(b.xeiristes_ids)) {
      await client.query(
        `DELETE FROM xeiristes_dikigoroi WHERE ypotheseis_id = $1 AND organization_id = $2`,
        [id, orgId]
      );
      for (const dgId of b.xeiristes_ids) {
        await client.query(
          `INSERT INTO xeiristes_dikigoroi (organization_id, ypotheseis_id, dikigoroi_grafeiou_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [orgId, id, dgId]
        );
      }
    }

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/cases/:id
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM ypotheseis WHERE aa = $1 AND organization_id = $2 RETURNING aa`,
      [req.params.id, req.user.organization_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: r.rows[0].aa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// =============================================================================
// ADD THIS TO src/routes/cases.js (BACKEND)
// Paste anywhere before the `module.exports = router;` at the end
// =============================================================================

// GET /api/cases/:id/same-client  →  other cases of the same client (fysiko or nomiko)
router.get('/:id/same-client', async (req, res) => {
  const orgId = req.user.organization_id;
  const caseId = parseInt(req.params.id, 10);
  try {
    const cur = await pool.query(
      `SELECT fysiko_prosopo_id, nomiko_prosopo_id
         FROM ypotheseis
        WHERE aa = $1 AND organization_id = $2`,
      [caseId, orgId]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const { fysiko_prosopo_id, nomiko_prosopo_id } = cur.rows[0];
    if (!fysiko_prosopo_id && !nomiko_prosopo_id) return res.json({ data: [] });

    const params = [orgId, caseId];
    let clientFilter;
    if (fysiko_prosopo_id) {
      params.push(fysiko_prosopo_id);
      clientFilter = `y.fysiko_prosopo_id = $${params.length}`;
    } else {
      params.push(nomiko_prosopo_id);
      clientFilter = `y.nomiko_prosopo_id = $${params.length}`;
    }

    const r = await pool.query(
      `SELECT y.aa, y.xeirokinito_id, y.perilipsi, y.date_eisagogis, y.date_telous, y.ekkremis,
              y.onomasia_fakelou
         FROM ypotheseis y
        WHERE y.organization_id = $1
          AND y.aa != $2
          AND ${clientFilter}
        ORDER BY y.date_eisagogis DESC NULLS LAST
        LIMIT 100`,
      params
    );
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[cases/same-client]', err);
    res.status(500).json({ error: err.message });
  }
});
// =============================================================================
// ADD THIS TO src/routes/cases.js (BACKEND)
// Paste anywhere before the `module.exports = router;` at the end.
//
// Requires pg_trgm extension. Auto-enabled on first call.
// =============================================================================

let suggestionsInitialized = false;
async function ensureSuggestionsSchema() {
  if (suggestionsInitialized) return;
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE TABLE IF NOT EXISTS case_suggestion_feedback (
      aa                  BIGSERIAL PRIMARY KEY,
      organization_id     BIGINT NOT NULL,
      ypothesi_id         BIGINT NOT NULL,
      suggested_case_id   BIGINT NOT NULL,
      feedback            SMALLINT NOT NULL,
      created_by          BIGINT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (organization_id, ypothesi_id, suggested_case_id)
    );
    CREATE INDEX IF NOT EXISTS idx_csf_case ON case_suggestion_feedback (ypothesi_id);
  `);
  suggestionsInitialized = true;
}

// GET /api/cases/:id/suggestions
router.get('/:id/suggestions', async (req, res) => {
  await ensureSuggestionsSchema();
  const orgId = req.user.organization_id;
  const caseId = parseInt(req.params.id, 10);

  try {
    const curR = await pool.query(
      `SELECT aa, fysiko_prosopo_id, nomiko_prosopo_id, diadikos_id, perilipsi
         FROM ypotheseis
        WHERE aa = $1 AND organization_id = $2`,
      [caseId, orgId]
    );
    if (curR.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const cur = curR.rows[0];

    const connR = await pool.query(
      `SELECT CASE WHEN ypothesi_id = $1 THEN related_ypothesi_id ELSE ypothesi_id END AS other_id
         FROM case_related_cases
        WHERE ypothesi_id = $1 OR related_ypothesi_id = $1`,
      [caseId]
    );
    const connectedIds = connR.rows.map(r => Number(r.other_id));

    const rejR = await pool.query(
      `SELECT suggested_case_id
         FROM case_suggestion_feedback
        WHERE organization_id = $1 AND ypothesi_id = $2 AND feedback = -1`,
      [orgId, caseId]
    );
    const rejectedIds = rejR.rows.map(r => Number(r.suggested_case_id));

    // Learning signal: features common to already-connected cases
    let learnedFysika = [], learnedNomika = [], learnedDiadikoi = [];
    if (connectedIds.length > 0) {
      const feats = await pool.query(
        `SELECT fysiko_prosopo_id, nomiko_prosopo_id, diadikos_id
           FROM ypotheseis
          WHERE aa = ANY($1::bigint[])`,
        [connectedIds]
      );
      feats.rows.forEach(f => {
        if (f.fysiko_prosopo_id) learnedFysika.push(f.fysiko_prosopo_id);
        if (f.nomiko_prosopo_id) learnedNomika.push(f.nomiko_prosopo_id);
        if (f.diadikos_id)       learnedDiadikoi.push(f.diadikos_id);
      });
    }

    const excludeIds = [caseId, ...rejectedIds, ...connectedIds];
    const useText = cur.perilipsi && cur.perilipsi.trim().length > 5;

    const candR = await pool.query(
      `SELECT y.aa, y.xeirokinito_id, y.perilipsi, y.date_eisagogis, y.ekkremis,
              y.fysiko_prosopo_id, y.nomiko_prosopo_id, y.diadikos_id,
              COALESCE(fp.eponymo || ' ' || COALESCE(fp.onoma, ''), np.eponymia) AS pelatis,
              ${useText ? 'similarity(y.perilipsi, $3)::float' : '0::float'} AS text_sim
         FROM ypotheseis y
         LEFT JOIN fysika_prosopa fp ON fp.aa = y.fysiko_prosopo_id
         LEFT JOIN nomika_prosopa np ON np.aa = y.nomiko_prosopo_id
        WHERE y.organization_id = $1
          AND y.aa <> ALL($2::bigint[])
        LIMIT 500`,
      useText ? [orgId, excludeIds, cur.perilipsi] : [orgId, excludeIds]
    );

    const scored = candR.rows.map(y => {
      let score = 0;
      const reasons = [];

      if (cur.fysiko_prosopo_id && y.fysiko_prosopo_id === cur.fysiko_prosopo_id) {
        score += 50; reasons.push('Ίδιος πελάτης');
      } else if (cur.nomiko_prosopo_id && y.nomiko_prosopo_id === cur.nomiko_prosopo_id) {
        score += 50; reasons.push('Ίδιος πελάτης');
      }
      if (cur.diadikos_id && y.diadikos_id === cur.diadikos_id) {
        score += 30; reasons.push('Ίδιος αντίδικος');
      }
      if (y.text_sim > 0.15) {
        score += Math.round(y.text_sim * 40);
        reasons.push(`Παρόμοια περίληψη (${Math.round(y.text_sim * 100)}%)`);
      }
      let boost = 0;
      if (y.fysiko_prosopo_id && learnedFysika.includes(y.fysiko_prosopo_id)) boost += 10;
      if (y.nomiko_prosopo_id && learnedNomika.includes(y.nomiko_prosopo_id)) boost += 10;
      if (y.diadikos_id       && learnedDiadikoi.includes(y.diadikos_id))     boost += 5;
      if (boost > 0) {
        score += boost;
        reasons.push('Παρόμοιο μοτίβο με ήδη συνδεδεμένες');
      }

      return {
        aa: y.aa,
        xeirokinito_id: y.xeirokinito_id,
        perilipsi: y.perilipsi,
        date_eisagogis: y.date_eisagogis,
        ekkremis: y.ekkremis,
        pelatis: y.pelatis,
        score,
        reasons,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter(s => s.score > 0).slice(0, 10);
    res.json({ data: top });
  } catch (err) {
    console.error('[cases/suggestions]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cases/:id/suggestions/feedback
// body: { suggested_case_id, feedback: 1 (accepted) | -1 (rejected) }
router.post('/:id/suggestions/feedback', async (req, res) => {
  await ensureSuggestionsSchema();
  const orgId = req.user.organization_id;
  const caseId = parseInt(req.params.id, 10);
  const { suggested_case_id, feedback } = req.body || {};
  if (!suggested_case_id || (feedback !== 1 && feedback !== -1)) {
    return res.status(400).json({ error: 'suggested_case_id and feedback (+1 or -1) required' });
  }
  try {
    await pool.query(
      `INSERT INTO case_suggestion_feedback (organization_id, ypothesi_id, suggested_case_id, feedback, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, ypothesi_id, suggested_case_id) DO UPDATE SET feedback = EXCLUDED.feedback, created_at = NOW()`,
      [orgId, caseId, parseInt(suggested_case_id, 10), feedback, req.user.sub || req.user.id || null]
    );
    res.status(204).end();
  } catch (err) {
    console.error('[cases/suggestions/feedback]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
