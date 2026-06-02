const axios = require('axios');

const BEAM_ENV = process.env.BEAM_ENV || 'sandbox';
const BASE_URL = BEAM_ENV === 'production'
  ? 'https://api.beamcheckout.com'
  : 'https://playground.api.beamcheckout.com';

/**
 * สร้าง Basic Auth header (MerchantID : APIKey)
 */
const getAuthHeader = (merchantId, apiKey) => {
  if (!merchantId || !apiKey) {
    console.error('❌ Missing Beam Credentials');
    return '';
  }
  const credentials = Buffer.from(`${merchantId}:${apiKey}`).toString('base64');
  return `Basic ${credentials}`;
};

/**
 * สร้าง Axios instance สำหรับ request เฉพาะครั้ง
 */
const getBeamClient = (merchantId, apiKey) => {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(merchantId, apiKey)
    }
  });
};

/**
 * สร้าง PromptPay Charge
 * @param {Object} options
 * @param {string} options.merchantId - Merchant ID ของ User
 * @param {string} options.apiKey - API Key ของ User
 * @param {number} options.amount - จำนวนเงิน (satang)
 * @param {string} options.currency - สกุลเงิน (THB)
 * @param {string} options.description - คำอธิบาย
 * @param {Object} options.metadata - ข้อมูลเพิ่มเติม
 */
async function createPromptPayCharge({ merchantId, apiKey, amount, currency = 'THB', description, metadata = {} }) {
  const client = getBeamClient(merchantId, apiKey);
  const response = await client.post('/api/charges', {
    amount,
    currency,
    description,
    paymentMethod: {
      paymentMethodType: 'QR_PROMPT_PAY',
      qrPromptPay: {}
    },
    metadata
  });

  return response.data;
}

/**
 * สร้าง Payment Link
 * @param {Object} options
 * @param {string} options.merchantId - Merchant ID ของ User
 * @param {string} options.apiKey - API Key ของ User
 */
async function createPaymentLink({ merchantId, apiKey, amount, currency = 'THB', description, referenceId, redirectUrl }) {
  const client = getBeamClient(merchantId, apiKey);
  
  // Beam กำหนดขั้นต่ำบัตรเครดิต 200 บาท (20000 satang)
  const CARD_MIN_AMOUNT = 20000;
  const isCardEnabled = amount >= CARD_MIN_AMOUNT;

  const response = await client.post('/api/v1/payment-links', {
    order: {
      currency,
      netAmount: amount, // หน่วย satang
      description,
      referenceId: referenceId || `order-${Date.now()}`
    },
    linkSettings: {
      qrPromptPay: { isEnabled: true },
      card: { isEnabled: isCardEnabled },
      mobileBanking: { isEnabled: true },
      eWallets: { isEnabled: true }
    },
    redirectUrl: redirectUrl || process.env.SITE_URL || 'http://localhost:3000/thank-you'
  });

  return response.data;
}

/**
 * ดึงข้อมูล Charge
 * @param {string} merchantId
 * @param {string} apiKey
 * @param {string} chargeId 
 */
async function getCharge(merchantId, apiKey, chargeId) {
  const client = getBeamClient(merchantId, apiKey);
  const response = await client.get(`/api/v1/charges/${chargeId}`);
  return response.data;
}

/**
 * ดึงรายการ Charges
 * @param {string} merchantId
 * @param {string} apiKey
 * @param {Object} options
 */
async function listCharges(merchantId, apiKey, { limit = 10, starting_after } = {}) {
  const client = getBeamClient(merchantId, apiKey);
  const params = { limit };
  if (starting_after) params.starting_after = starting_after;

  const response = await client.get('/api/v1/charges', { params });
  return response.data;
}

module.exports = {
  createPromptPayCharge,
  createPaymentLink,
  getCharge,
  listCharges
};
