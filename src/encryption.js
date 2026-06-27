const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// SEC-011: Derive key once at startup — scryptSync is ~200ms, calling it on every
// encrypt/decrypt causes CPU saturation under concurrent requests.
let _derivedKey = null;
function getDerivedKey() {
  if (_derivedKey) return _derivedKey;
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  const salt = process.env.ENCRYPTION_SALT;
  if (!masterKey) throw new Error('MASTER_ENCRYPTION_KEY is not defined in environment variables');
  if (!salt) throw new Error('ENCRYPTION_SALT is not defined in environment variables');
  _derivedKey = crypto.scryptSync(masterKey, salt, 32);
  return _derivedKey;
}

function encrypt(text) {
  if (!text) return null;

  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag().toString('base64');

  return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts text using AES-256-GCM
 * @param {string} encryptedText - Encrypted string in format iv:authTag:encryptedData (base64)
 * @returns {string} - Decrypted plain text
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;

  const [ivBase64, authTagBase64, encryptedBase64] = encryptedText.split(':');
  if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error('Invalid encrypted text format');
  }

  const key = getDerivedKey();
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedBase64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = {
  encrypt,
  decrypt,
  censor: (text, showFirst = 3, showLast = 4) => {
    if (!text || text.length <= showFirst + showLast) return text ? '*'.repeat(text.length) : '';
    return text.substring(0, showFirst) + '*'.repeat(text.length - showFirst - showLast) + text.substring(text.length - showLast);
  }
};
