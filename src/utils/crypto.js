import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const SECRET_FILE = path.join(ROOT_DIR, '.encryption_secret');

function getOrGenerateSecret() {
  const secret = process.env.ENCRYPTION_SECRET || process.env.APP_SECRET;
  if (secret && secret.length >= 16) {
    return crypto.createHash('sha256').update(secret).digest();
  }
  
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[FATAL] ENCRYPTION_SECRET environment variable is REQUIRED in production (minimum 16 characters). Startup aborted to prevent data loss or silent key invalidation.');
  }

  // Development fallback: persist a local file outside db.json
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (stored) {
        return crypto.createHash('sha256').update(stored).digest();
      }
    }
    const newSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, newSecret, { encoding: 'utf8', mode: 0o600 });
    return crypto.createHash('sha256').update(newSecret).digest();
  } catch (err) {
    return crypto.createHash('sha256').update('dev-fallback-whatsapp-bot-internal-secret-2026').digest();
  }
}

const MASTER_KEY = getOrGenerateSecret();

export function encrypt(plainText, key = MASTER_KEY) {
  if (!plainText || typeof plainText !== 'string') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(cipherText, key = MASTER_KEY) {
  if (!cipherText || typeof cipherText !== 'string') return '';
  const parts = cipherText.split(':');
  if (parts.length !== 3) return '';
  const [ivHex, authTagHex, encryptedHex] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return '';
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return {
    salt,
    hash: derivedKey.toString('hex')
  };
}

export function verifyPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const storedBuf = Buffer.from(storedHash, 'hex');
    return crypto.timingSafeEqual(derivedKey, storedBuf);
  } catch (err) {
    return false;
  }
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function generateRandomPassword(length = 16) {
  return crypto.randomBytes(length).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, length);
}
