/**
 * Generate PromptPay EMVCo QR payload
 * Based on Thai PromptPay standard (Tag 30: Merchant Account Info)
 */
function generatePromptPayPayload(phoneNumber, amount) {
  const phone = phoneNumber.replace(/[^0-9]/g, '');
  if (phone.length < 10) throw new Error('เบอร์โทรศัพท์ไม่ถูกต้อง (ต้องมีอย่างน้อย 10 หลัก)');

  const amountStr = amount ? amount.toFixed(2) : '';
  let normalizedPhone = phone;
  if (phone.startsWith('0')) {
    normalizedPhone = '66' + phone.substring(1);
  } else if (!phone.startsWith('66')) {
    normalizedPhone = '66' + phone;
  }
  const phoneInfo = `00${normalizedPhone}`;

  const tags = [];
  tags.push({ id: '00', value: '01' });
  tags.push({ id: '01', value: amount ? '12' : '11' });
  tags.push({ id: '29', value: `0016A00000067701011101${phoneInfo.length.toString().padStart(2, '0')}${phoneInfo}` });
  tags.push({ id: '58', value: 'TH' });
  tags.push({ id: '53', value: '764' });
  if (amountStr) tags.push({ id: '54', value: amountStr });

  let payload = '';
  tags.forEach(tag => {
    const len = tag.value.length.toString().padStart(2, '0');
    payload += `${tag.id}${len}${tag.value}`;
  });

  payload += '6304';
  const crc = crc16(payload);
  payload += crc.toString(16).toUpperCase().padStart(4, '0');

  return payload;
}

function generatePromptPayIdCardPayload(idCardNumber, amount) {
  const cleaned = idCardNumber.replace(/[^0-9]/g, '');
  if (cleaned.length !== 13) throw new Error('เลขบัตรประชาชนต้องมี 13 หลัก');

  const amountStr = amount ? amount.toFixed(2) : '';
  const idLen = cleaned.length.toString().padStart(2, '0');

  const tags = [];
  tags.push({ id: '00', value: '01' });
  tags.push({ id: '01', value: amount ? '12' : '11' });
  tags.push({ id: '29', value: `0016A00000067701011102${idLen}${cleaned}` });
  tags.push({ id: '58', value: 'TH' });
  tags.push({ id: '53', value: '764' });
  if (amountStr) tags.push({ id: '54', value: amountStr });

  let payload = '';
  tags.forEach(tag => {
    const len = tag.value.length.toString().padStart(2, '0');
    payload += `${tag.id}${len}${tag.value}`;
  });

  payload += '6304';
  const crc = crc16(payload);
  payload += crc.toString(16).toUpperCase().padStart(4, '0');

  return payload;
}

function generatePromptPayEWalletPayload(eWalletId, amount) {
  const cleaned = eWalletId.replace(/[^0-9]/g, '');
  if (cleaned.length !== 15) throw new Error('e-Wallet ID ต้องมี 15 หลัก');

  const amountStr = amount ? amount.toFixed(2) : '';
  const idLen = cleaned.length.toString().padStart(2, '0');

  const tags = [];
  tags.push({ id: '00', value: '01' });
  tags.push({ id: '01', value: amount ? '12' : '11' });
  tags.push({ id: '29', value: `0016A00000067701011103${idLen}${cleaned}` });
  tags.push({ id: '58', value: 'TH' });
  tags.push({ id: '53', value: '764' });
  if (amountStr) tags.push({ id: '54', value: amountStr });

  let payload = '';
  tags.forEach(tag => {
    const len = tag.value.length.toString().padStart(2, '0');
    payload += `${tag.id}${len}${tag.value}`;
  });

  payload += '6304';
  const crc = crc16(payload);
  payload += crc.toString(16).toUpperCase().padStart(4, '0');

  return payload;
}

function crc16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
  }
  return (crc & 0xFFFF);
}

module.exports = { generatePromptPayPayload, generatePromptPayIdCardPayload, generatePromptPayEWalletPayload, crc16 };
