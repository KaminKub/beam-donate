const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts text using AES-256-GCM
 * @param {string} text - Plain text to encrypt
 * @returns {string} - Encrypted string in format iv:authTag:encryptedData (base64)
 */
function encrypt(text) {
  if (!text) return null;

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  const salt = process.env.ENCRYPTION_SALT || 'default-salt-change-in-production';

  if (!masterKey) {
    throw new Error('MASTER_ENCRYPTION_KEY is not defined in environment variables');
  }

  // Ensure key is 32 bytes using the salt
  const key = crypto.scryptSync(masterKey, salt, 32);
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

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  const salt = process.env.ENCRYPTION_SALT || 'default-salt-change-in-production';

  if (!masterKey) {
    throw new Error('MASTER_ENCRYPTION_KEY is not defined in environment variables');
  }

  const [ivBase64, authTagBase64, encryptedBase64] = encryptedText.split(':');
  if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error('Invalid encrypted text format');
  }

  const key = crypto.scryptSync(masterKey, salt, 32);
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
  decrypt
};
