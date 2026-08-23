'use strict';

const MIN_TRUE_MONEY_SECRET_LENGTH = 32;

function looksLikeUrl(value) {
  if (/^(?:https?|ftp):\/\//i.test(value) || /^\/\//.test(value) || /^www\./i.test(value)) {
    return true;
  }

  // Also catch a profile URL pasted without a scheme, such as tipkub.com/user.
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:[\/:?#]|$)/i.test(value);
}

// TrueMoney provides a raw HS256 shared secret, not a URL or a JWT to parse.
function parseTrueMoneyToken(raw) {
  const value = String(raw || '').trim();
  const compact = value.replace(/\s+/g, '');

  if (compact.length < MIN_TRUE_MONEY_SECRET_LENGTH) return { secret: null, reason: 'length' };
  if (looksLikeUrl(compact)) return { secret: null, reason: 'url' };

  return { secret: compact };
}

module.exports = { MIN_TRUE_MONEY_SECRET_LENGTH, parseTrueMoneyToken };
