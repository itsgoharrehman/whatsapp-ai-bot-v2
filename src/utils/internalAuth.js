import crypto from 'crypto';

class NonceCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.nonces = new Map();
  }

  hasAndAdd(nonce) {
    if (!nonce) return true;
    const now = Date.now();
    this.cleanup(now);

    if (this.nonces.has(nonce)) {
      return true; // Replay detected
    }
    this.nonces.set(nonce, now);
    return false;
  }

  cleanup(now) {
    const cutoff = now - this.ttlMs;
    for (const [nonce, ts] of this.nonces.entries()) {
      if (ts < cutoff) {
        this.nonces.delete(nonce);
      }
    }
  }
}

const nonceCache = new NonceCache();

export function normalizeBody(body, method = 'GET') {
  if (method && ['GET', 'HEAD', 'DELETE'].includes(method.toUpperCase()) && (!body || (typeof body === 'object' && Object.keys(body).length === 0))) {
    return '';
  }
  if (!body) return '';
  if (typeof body === 'object') {
    if (Object.keys(body).length === 0) return '';
    return JSON.stringify(body);
  }
  return String(body);
}

export function createSignature(secret, method, path, timestamp, nonce, body = '') {
  const normBody = normalizeBody(body, method);
  const canonicalString = `${method.toUpperCase()}|${path}|${timestamp}|${nonce}|${normBody}`;
  return crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
}

export function verifySignature(secret, method, path, timestamp, nonce, body, signature) {
  if (!secret || !signature || !timestamp || !nonce) return false;
  try {
    const expected = createSignature(secret, method, path, timestamp, nonce, body);
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch (err) {
    return false;
  }
}

export function createSignedHeaders(secret, method, path, body = '') {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = createSignature(secret, method, path, timestamp, nonce, body);
  return {
    'x-internal-key': secret,
    'x-internal-timestamp': timestamp,
    'x-internal-nonce': nonce,
    'x-internal-signature': signature,
    'Content-Type': 'application/json'
  };
}

export function requireInternalAuth(secret) {
  return (req, res, next) => {
    const key = req.headers['x-internal-key'];
    const timestamp = req.headers['x-internal-timestamp'];
    const nonce = req.headers['x-internal-nonce'];
    const signature = req.headers['x-internal-signature'];

    if (!key || key !== secret) {
      return res.status(401).json({ error: 'Unauthorized: Invalid internal secret' });
    }

    if (!timestamp || !nonce || !signature) {
      return res.status(401).json({ error: 'Unauthorized: Missing internal security headers' });
    }

    const reqTime = parseInt(timestamp, 10);
    const now = Date.now();
    const maxDriftMs = 5 * 60 * 1000; // 5 minutes

    if (isNaN(reqTime) || Math.abs(now - reqTime) > maxDriftMs) {
      return res.status(401).json({ error: 'Unauthorized: Request timestamp expired or invalid clock drift' });
    }

    if (nonceCache.hasAndAdd(nonce)) {
      return res.status(401).json({ error: 'Unauthorized: Duplicate nonce detected (replay attack rejected)' });
    }

    const isValid = verifySignature(secret, req.method, req.path || req.url, timestamp, nonce, req.body, signature);
    if (!isValid) {
      return res.status(401).json({ error: 'Unauthorized: Invalid HMAC signature' });
    }

    next();
  };
}
