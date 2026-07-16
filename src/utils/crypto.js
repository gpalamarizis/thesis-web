// src/utils/crypto.js
// Symmetric encryption for stored client credentials (TAXIS/ΔΕΗ/ΓΕΜΗ passwords).
// AES-256-GCM με 32-byte key από την env var THESIS_CREDENTIALS_KEY.
//
// Format αποθήκευσης: "enc:v1:<base64(iv|tag|ciphertext)>"
// Αν κάτι δεν έχει το prefix θεωρείται plain (backward compat για ό,τι υπάρχει από τη βάση).
//
// Σε production: πρέπει να έχεις set το THESIS_CREDENTIALS_KEY σε ένα random 32-byte value.
// Δείγμα key generation:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Και μετά στο Railway → Variables → THESIS_CREDENTIALS_KEY = <το output>

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.THESIS_CREDENTIALS_KEY;
  if (!raw) {
    // Fallback: derive from JWT_SECRET so app δεν κρασάρει σε missing config
    // (θα λογιθεί warning ώστε να το φτιάξει ο admin)
    const j = process.env.JWT_SECRET || 'insecure-dev-key';
    console.warn('[crypto] THESIS_CREDENTIALS_KEY not set — using JWT_SECRET-derived fallback. SET IT IN PRODUCTION.');
    return crypto.createHash('sha256').update(j + '::thesis-credentials-v1').digest();
  }
  // Accept base64 (44 chars for 32 bytes) or hex (64 chars) or raw
  if (/^[A-Za-z0-9+/=]{40,}$/.test(raw) && raw.length <= 48) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  // Otherwise SHA-256 hash the raw string to get 32 bytes
  return crypto.createHash('sha256').update(raw).digest();
}

let KEY;
function key() {
  if (!KEY) KEY = getKey();
  return KEY;
}

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  if (typeof plain !== 'string') plain = String(plain);
  if (plain.startsWith(PREFIX)) return plain; // already encrypted, don't double-encrypt
  const iv = crypto.randomBytes(12); // GCM standard
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ct]).toString('base64');
  return PREFIX + payload;
}

function decrypt(stored) {
  if (stored == null || stored === '') return null;
  if (typeof stored !== 'string') return stored;
  if (!stored.startsWith(PREFIX)) return stored; // plain value (legacy)
  try {
    const payload = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv  = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ct  = payload.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[crypto] decrypt failed:', e.message);
    return null; // επιστρέφουμε null αντί να σκάσει
  }
}

/**
 * Apply encrypt/decrypt σε πολλά πεδία ενός row.
 * @param {object} row       — DB row (mutated in place ή shallow-copied)
 * @param {string[]} fields  — τα πεδία που περιέχουν sensitive data
 * @param {'encrypt'|'decrypt'} mode
 */
function transformFields(row, fields, mode) {
  if (!row) return row;
  const fn = mode === 'encrypt' ? encrypt : decrypt;
  const out = { ...row };
  for (const f of fields) {
    if (f in out) out[f] = fn(out[f]);
  }
  return out;
}

module.exports = {
  encrypt,
  decrypt,
  transformFields,
  ENCRYPTED_FIELDS_FYSIKA: ['taxis_password', 'dei_password', 'adt'],
  ENCRYPTED_FIELDS_NOMIKA: ['taxis_password', 'dei_password', 'gemi_password'],
};
