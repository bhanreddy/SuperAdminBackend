const crypto = require('crypto');
const { CrmError } = require('./errors');

function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function signIngress({ secret, timestamp, nonce, method, path, rawBody }) {
  const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('hex');
  const canonical = [String(timestamp), String(nonce), String(method || '').toUpperCase(), path, bodyHash].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function verifyIngress({ secret, timestamp, nonce, method, path, rawBody, signature, now = Date.now() }) {
  if (!secret || secret.length < 16) throw new CrmError(503, 'Tracking ingress is not configured', 'TRACK_UNCONFIGURED');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 1000) {
    throw new CrmError(401, 'Tracking signature expired', 'INGRESS_EXPIRED');
  }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(nonce || ''))) {
    throw new CrmError(401, 'Tracking signature is invalid', 'INGRESS_REJECTED');
  }
  const expected = signIngress({ secret, timestamp, nonce, method, path, rawBody });
  const got = String(signature || '');
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (!got || a.length !== b.length || a.length !== 32 || !crypto.timingSafeEqual(a, b)) {
    throw new CrmError(401, 'Tracking signature is invalid', 'INGRESS_REJECTED');
  }
  return true;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function browserKey(secret, raw) {
  if (!raw || !secret) return null;
  return crypto.createHmac('sha256', secret).update(String(raw)).digest('hex');
}

module.exports = { signIngress, verifyIngress, hashToken, browserKey, canonicalJson };
