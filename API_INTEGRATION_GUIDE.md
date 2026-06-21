# API Integration Guide — TipKub

เอกสารแนะนำสถาปัตยกรรม API และการวางโค้ดสำหรับระบบ TipKub ครอบคลุม SlipOK API, PromptPay QR, และ Internal API Endpoints

---

## สารบัญ
1. [สถาปัตยกรรม API โดยรวม](#1-สถาปัตยกรรม-api-โดยรวม)
2. [SlipOK API (ระบบหลัก)](#2-slipok-api-ระบบหลัก)
3. [PromptPay QR Generation](#3-promptpay-qr-generation)
4. [การวางโค้ด API ในโปรเจค](#4-การวางโค้ด-api-ในโปรเจค)
5. [Environment Variables](#5-environment-variables)
6. [ระบบเข้ารหัสข้อมูล](#6-ระบบเข้ารหัสข้อมูล)
7. [Error Handling Patterns](#7-error-handling-patterns)
8. [Security Best Practices](#8-security-best-practices)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. สถาปัตยกรรม API โดยรวม

### Flow Diagram
```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Donate Page │────▶│  Backend (Express)│────▶│  Database (Turso) │
│  (Frontend)  │◀────│  src/server.js   │◀────│  src/database.js  │
└─────────────┘     └────────┬─────────┘     └──────────────────┘
                             │
                    ┌────────┼────────┐
                    │        │        │
              ┌─────▼──┐ ┌──▼──────────┐
              │ SlipOK │ │ MyInstants  │
              │ API    │ │ (Scraping)  │
              └────────┘ └─────────────┘
```

### ประเภท API ในระบบ

| ประเภท | คำอธิบาย | ตัวอย่าง |
|--------|----------|---------|
| **External Payment API** | API ของผู้ให้บริการชำระเงินภายนอก | SlipOK |
| **Internal API** | API ที่ Backend ให้บริการ Frontend | `/api/payment/settings`, `/api/overlay/settings` |
| **Proxy API** | Backend เป็นตัวกลางเรียก API ภายนอกแทน Frontend | `/api/myinstants/search`, `/api/payment/test-slipok` |
| **Dynamic Routes** | Route ที่สร้างหน้าตาม username | `/:username`, `/:username/dashboard` |

---

## 2. SlipOK API (ระบบหลัก)

### 2.1 ภาพรวม
SlipOK API ใช้สำหรับ**ตรวจสอบสลิปโอนเงิน**อัตโนมัติ รองรับทั้ง PromptPay QR และ TrueMoney Wallet

### 2.2 System Flow
```
1. User สแกน QR → โอนเงิน → ถ่าย/แคปสลิป
2. User อัพโหลดสลิป → Frontend (donate-template/app.js)
3. Frontend → POST /api/verify-slip (multipart/form-data)
4. Backend → POST https://api.slipok.com/api/line/apikey/<BRANCH_ID>
5. SlipOK → คืน JSON ผลการตรวจสอบ
6. Backend → ตรวจสอบยอดเงิน + บัญชีผู้รับ
7. Backend → บันทึก DB + ยิง Alert SSE
8. Frontend → Redirect ไป /thank-you
```

### 2.3 ตำแหน่งโค้ด

| ไฟล์ | หน้าที่ | บรรทัดโดยประมาณ |
|------|---------|-----------------|
| `src/server.js` | Route `POST /api/verify-slip` | ~1869 |
| `src/server.js` | Route `POST /api/verify-promptpay-slip` | ~2016 |
| `src/server.js` | Route `POST /api/payment/test-slipok` | ~1619 |
| `src/server.js` | Route `GET /api/payment/settings` | ~1550 |
| `src/server.js` | Route `POST /api/payment/settings` | ~1589 |
| `src/encryption.js` | เข้ารหัส/ถอดรหัส SlipOK API Key | ทั้งหมด |
| `src/database.js` | Schema: `slipok_api_encrypted`, `slipok_api_key_encrypted` | ~166-179 |
| `public/donate-template/app.js` | Frontend: อัพโหลดสลิป + แสดงผล | ใน `verifySlip()` |
| `public/dashboard/dashboard.js` | Dashboard: กรอก API + ทดสอบเชื่อมต่อ | ใน `testSlipOkConnection()` |

### 2.4 SlipOK API Configuration

| Config | Value |
|--------|-------|
| **Base URL (Check Slip)** | `https://api.slipok.com/api/line/apikey/<BRANCH_ID>` |
| **Base URL (Check Quota)** | `https://api.slipok.com/api/line/apikey/<BRANCH_ID>/quota` |
| **Auth Header** | `x-authorization: <API_KEY>` |
| **Method (Verify)** | `POST` |
| **Content-Type** | `multipart/form-data` (ไฟล์) หรือ `application/json` (data/url) |

### 2.5 Request Body (ตรวจสอบสลิป)
```json
{
  "files": "<base64_image หรือ multipart file>",
  "amount": 100,
  "log": false
}
```

**พารามิเตอร์:**
| ฟิลด์ | ประเภท | จำเป็น | คำอธิบาย |
|-------|--------|--------|----------|
| `files` | File/base64 | เลือก 1 | ไฟล์รูปภาพสลิป (JPG, PNG, WEBP, JFIF) |
| `data` | string | เลือก 1 | ข้อมูล QR Code ที่อ่านได้ |
| `url` | string | เลือก 1 | URL รูปภาพสลิป |
| `amount` | number | ไม่จำเป็น | ยอดเงินเพื่อเทียบกับสลิป |
| `log` | boolean | ไม่จำเป็น | `true` = บันทึก+ตรวจสลิปซ้ำ, `false` = ตรวจทั่วไป |

### 2.6 Response (สำเร็จ)
```json
{
  "success": true,
  "data": {
    "transRef": "เลขที่อ้างอิง",
    "sendingBank": "004",
    "receivingBank": "014",
    "amount": 100,
    "transDate": "20260621",
    "transTime": "14:30:00",
    "sender": {
      "displayName": "ชื่อผู้โอน",
      "proxy": { "type": "MSISDN", "value": "XXX-X-XX123-4" },
      "account": { "type": "BANKAC", "value": "XXX-X-XX456-7" }
    },
    "receiver": {
      "displayName": "ชื่อผู้รับ",
      "proxy": { "type": "MSISDN", "value": "XXX-X-XX789-0" }
    }
  }
}
```

### 2.7 Error Codes ที่ต้องจัดการ

| Code | ความหมาย | การจัดการในโค้ด |
|------|----------|-----------------|
| 1000 | ไม่มีข้อมูล QR | แจ้ง user อัพโหลดรูปใหม่ |
| 1002 | Auth header ไม่ถูกต้อง | API Key ผิด → แจ้ง user ตรวจสอบ |
| 1003 | Package หมดอายุ | แจ้ง user ต่ออายุ SlipOK |
| 1005 | ไฟล์ไม่ใช่รูปภาพ | แจ้งอัพโหลดไฟล์ JPG/PNG |
| 1007 | รูปไม่มี QR Code | แจ้งให้ถ่ายสลิปใหม่ |
| 1009 | ธนาคารขัดข้องชั่วคราว | รอ 15 นาทีแล้ว retry (ไม่เสียโควต้า) |
| 1010 | Delay Slip (BBL/SCB) | หน่วงเวลาตามฟิลด์ `delay` แล้ว retry |
| 1011 | QR หมดอายุ/ไม่มีรายการ | สลิปปลอมหรือรายการยกเลิก |
| 1012 | สลิปซ้ำ | สลิปถูกใช้แล้ว → แจ้ง user |
| 1013 | ยอดเงินไม่ตรง | amount ไม่ตรงกับสลิป |

### 2.8 การตรวจสอบใน Backend (หลังได้ Response จาก SlipOK)
```javascript
// src/server.js — ใน route /api/verify-slip
// 1. ตรวจสอบว่า success === true
// 2. ตรวจสอบ amount ตรงกับที่เรียกเก็บ
// 3. ตรวจสอบ receiver account ตรงกับ streamer
// 4. ตรวจสอบว่าสลิปไม่ซ้ำ (transRef ไม่เคยใช้)
// 5. บันทึกธุรกรรมลง DB
// 6. ยิง Alert SSE ไป OBS
```

### 2.9 Quota Check (ตรวจสอบโควต้า)
```
GET https://api.slipok.com/api/line/apikey/<BRANCH_ID>/quota
Header: x-authorization: <API_KEY>

Response:
{
  "success": true,
  "data": {
    "quota": 150,
    "overQuota": 0,
    "specialQuota": 50,
    "endDate": "2026-12-31"
  }
}
```

---

## 3. PromptPay QR Generation

### 3.1 ภาพรวม
ระบบสร้าง QR Code PromptPay แบบ EMVCo ที่ล็อคจำนวนเงินและเลขพร้อมเพย์ของผู้รับ

### 3.2 ตำแหน่งโค้ด

| ไฟล์ | หน้าที่ | บรรทัดโดยประมาณ |
|------|---------|-----------------|
| `src/server.js` | Route `POST /api/create-promptpay-qr` | ~1797 |
| `public/donate-template/app.js` | Frontend: แสดง QR + นับถอยหลัง | ใน `createPromptPayQR()` |

### 3.3 QR Data Flow
```
1. Frontend → POST /api/create-promptpay-qr { promptpayId, amount, promptpayType }
2. Backend ดึง promptpay_value_encrypted จาก DB → ถอดรหัส
3. Backend สร้าง EMVCo payload (PromptPay format)
4. Backend → สร้าง QR Code image (Google Chart API หรือ library)
5. Frontend → แสดง QR + เริ่ม countdown 10 นาที
6. User สแกน QR → โอนเงิน → อัพโหลดสลิป
```

---

## 4. การวางโค้ด API ในโปรเจค

### 4.1 โครงสร้างไฟล์ Backend
```
src/
├── server.js          # Route definitions + Middleware + SSE
├── database.js        # DB connection + queries + migrations
├── encryption.js      # AES-256-GCM encrypt/decrypt/censor
├── sessionStore.js    # Custom session store (Turso-backed)
└── streamlabs.js      # Streamlabs OAuth helper
```

### 4.2 กฎการวางโค้ด

| ประเภทโค้ด | วางไว้ที่ | ตัวอย่าง |
|------------|----------|---------|
| **API Route (Express)** | `src/server.js` | `app.post('/api/verify-slip', ...)` |
| **External API Wrapper** | ไฟล์แยก `src/<service>.js` | (ถ้ามี API ภายนอกเพิ่ม) |
| **Database Query** | `src/database.js` | `getStreamerByUsername()`, `saveTransaction()` |
| **Encryption Logic** | `src/encryption.js` | `encrypt()`, `decrypt()`, `censor()` |
| **Session Logic** | `src/sessionStore.js` | TursoStore class |
| **Frontend API Call** | `public/*/app.js` หรือ `dashboard.js` | `fetch('/api/verify-slip', ...)` |
| **SSE Broadcast** | `src/server.js` | `broadcastAlert(username, data)` |
| **Rate Limiter** | `src/server.js` (ประกาศก่อน route) | `const verifySlipLimiter = rateLimit(...)` |

### 4.3 การเพิ่ม API Endpoint ใหม่

**ขั้นตอน:**
1. **ประกาศ Rate Limiter** (ถ้าจำเป็น) — ก่อน route
2. **สร้าง Route** — `app.get/post/put/delete('/api/...', ...)`
3. **ใส่ Authentication** — `ensureAuthenticated` middleware (ถ้าต้องล็อกอิน)
4. **ดึงข้อมูลจาก DB** — เรียกใช้ `db` functions จาก `database.js`
5. **เรียก External API** (ถ้าจำเป็น) — ใช้ `axios` + `try-catch`
6. **เข้ารหัส/ถอดรหัส** (ถ้าเกี่ยวกับข้อมูลอ่อนไหว) — ใช้ `encrypt()/decrypt()`
7. **Return JSON Response** — `{ success: true, data: ... }` หรือ `{ error: '...' }`
8. **Update Frontend** — เพิ่ม `fetch()` call ใน `dashboard.js` หรือ `app.js`

**ตัวอย่าง Pattern:**
```javascript
// src/server.js

// Rate Limiter
const myApiLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 5,
  message: { error: 'มากเกินไป กรุณาลองใหม่' }
});

// Route
app.post('/api/my-new-endpoint', ensureAuthenticated, myApiLimiter, async (req, res) => {
  try {
    const { username } = req.session.streamer;
    const { inputData } = req.body;

    // 1. Validate input
    if (!inputData) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

    // 2. Get data from DB
    const streamer = await db.getStreamerByUsername(username);

    // 3. Decrypt sensitive data (if needed)
    const decryptedKey = decrypt(streamer.slipok_api_key_encrypted);

    // 4. Call external API
    const response = await axios.post('https://api.example.com/endpoint', {
      headers: { 'Authorization': `Bearer ${decryptedKey}` }
    });

    // 5. Save to DB
    await db.saveResult(username, response.data);

    // 6. Return response
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('Error in /api/my-new-endpoint:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'เกิดข้อผิดพลาด' });
  }
});
```

### 4.4 การเพิ่ม External API Service ใหม่

ถ้าต้องเชื่อมต่อกับ API ใหม่ (เช่น Feel Free Pay) ให้สร้างไฟล์แยก:

```
src/
├── slipok.js          # SlipOK API (ถ้าแยกออกมา — ปัจจุบันอยู่ใน server.js)
└── ffp.js             # Feel Free Pay API (อนาคต)
```

**Template สำหรับ API Wrapper Module:**
```javascript
// src/ffp.js
const axios = require('axios');

const FFP_BASE_URL = 'https://api.feelfreepay.com/v1';

async function createCharge(apiKey, merchantId, amount, description) {
  try {
    const response = await axios.post(`${FFP_BASE_URL}/charges`, {
      amount,
      description,
      currency: 'THB'
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Merchant-ID': merchantId
      }
    });
    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message
    };
  }
}

module.exports = { createCharge };
```

### 4.5 ตำแหน่งโค้ด Frontend

| ไฟล์ | หน้าที่ | API ที่เรียก |
|------|---------|-------------|
| `public/donate-template/app.js` | หน้าโดเนท: สร้าง QR, อัพโหลดสลิป, เลือกวิธีชำระ | `/api/create-promptpay-qr`, `/api/verify-slip`, `/api/page/:username/payment-methods` |
| `public/dashboard/dashboard.js` | Dashboard: บันทึกค่าตั้งค่า, ทดสอบ API | `/api/payment/settings`, `/api/payment/test-slipok`, `/api/overlay/settings`, `/api/page/settings` |
| `public/overlay.js` | Overlay: รับ SSE, แสดง Alert | `/api/alerts/stream` (SSE) |
| `public/dashboard/sound-cache.js` | Cache เสียงจาก MyInstants | `/api/myinstants/search` |

---

## 5. Environment Variables

### จำเป็น (Required)

| Key | คำอธิบาย | ใช้กับ |
|-----|----------|--------|
| `TURSO_DATABASE_URL` | URL เชื่อมต่อ Turso Cloud SQLite | Database |
| `TURSO_AUTH_TOKEN` | JWT Token สำหรับ Turso | Database |
| `SESSION_SECRET` | Secret สำหรับ encrypt session | Session |
| `MASTER_ENCRYPTION_KEY` | Key หลักสำหรับ AES-256-GCM | Encryption |
| `TWITCH_CLIENT_ID` | Twitch App Client ID | OAuth |
| `TWITCH_CLIENT_SECRET` | Twitch App Secret | OAuth |
| `TWITCH_CALLBACK_URL` | Callback URL สำหรับ Twitch OAuth | OAuth |

### Encryption (Optional)

| Key | คำอธิบาย |
|-----|----------|
| `ENCRYPTION_SALT` | Salt สำหรับ derive key (เปลี่ยนใน production) |

### Streamlabs OAuth (ถ้ามี)

| Key | คำอธิบาย |
|-----|----------|
| `STREAMLABS_CLIENT_ID` | Streamlabs App Client ID |
| `STREAMLABS_CLIENT_SECRET` | Streamlabs App Secret |
| `STREAMLABS_REDIRECT_URI` | Redirect URI |

---

## 6. ระบบเข้ารหัสข้อมูล

### Algorithm: AES-256-GCM
- **Key Derivation**: `crypto.scryptSync(MASTER_ENCRYPTION_KEY, SALT, 32)`
- **Format**: `iv:authTag:encryptedData` (Base64)
- **IV Length**: 12 bytes (random)
- **Auth Tag**: 16 bytes

### ฟิลด์ที่ต้องเข้ารหัส

| ฟิลด์ DB | ข้อมูล | Censor Display |
|----------|--------|----------------|
| `promptpay_value_encrypted` | เบอร์พร้อมเพย์/เลขบัตร | `081****3456` |
| `slipok_api_encrypted` | SlipOK Branch URL | `https://.../****` |
| `slipok_api_key_encrypted` | SlipOK API Key | `****abcd` |
| `truemoney_phone_encrypted` | เบอร์ TrueMoney | `081****3456` |
| `truemoney_slipok_api_encrypted` | SlipOK API (TrueMoney) | `https://.../****` |
| `truemoney_slipok_api_key_encrypted` | SlipOK Key (TrueMoney) | `****abcd` |

### วิธีใช้ (ใน `src/server.js`)
```javascript
const { encrypt, decrypt, censor } = require('./encryption');

// เข้ารหัสก่อนบันทึก
const encrypted = encrypt(userInput);  // → "iv:authTag:data"
await db.saveSetting(username, 'slipok_api_key_encrypted', encrypted);

// ถอดรหัสเมื่อต้องเรียก API
const decrypted = decrypt(storedEncrypted);  // → plain text
// ใช้ decrypted เรียก SlipOK API...

// แสดงผลแบบเซ็นเซอร์
const display = censor(decrypted);  // → "xxxxabcd"
res.json({ slipokApiKey: display });
```

---

## 7. Error Handling Patterns

### Pattern 1: External API Call (try-catch + user-friendly error)
```javascript
try {
  const response = await axios.post(slipokUrl, formData, { headers });
  if (!response.data.success) {
    return res.status(400).json({
      error: 'SLIP_CHECK_FAILED',
      message: mapSlipOkError(response.data.errorCode)
    });
  }
} catch (err) {
  console.error('SlipOK API Error:', err.message);
  res.status(502).json({
    error: 'SLIPOK_UNAVAILABLE',
    message: 'ระบบเช็คสลิปไม่ทำงานชั่วคราว โปรดรอสักครู่แล้วลองใหม่'
  });
}
```

### Pattern 2: Database Query (fallback values)
```javascript
try {
  const result = await db.getStreamerSettings(username);
  res.json(result);
} catch (err) {
  console.error('DB Error:', err);
  // Return default values แทน crash
  res.json(getDefaultSettings());
}
```

### Pattern 3: SSE Broadcast (safe filter)
```javascript
function broadcastAlert(username, alertData) {
  sseClients = sseClients.filter(client => {
    if (client.username === username) {
      try {
        client.res.write(`data: ${JSON.stringify(alertData)}\n\n`);
        return true;
      } catch (e) {
        return false; // ลบ client ที่ error
      }
    }
    return true;
  });
}
```

---

## 8. Security Best Practices

### 8.1 ข้อมูลที่ต้องเข้ารหัสเสมอ
- เบอร์โทรศัพท์/เลขบัตรพร้อมเพย์
- API Key / API Secret ทั้งหมด
- เลขบัญชี TrueMoney
- OAuth tokens (Streamlabs access/refresh token)

### 8.2 Rate Limiting
```javascript
// ป้องกันการเรียก SlipOK API ซ้ำๆ
const verifySlipLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 นาที
  max: 10,               // 10 ครั้ง
  message: { error: 'ตรวจสอบสลิปบ่อยเกินไป กรุณาลองใหม่' }
});

// ป้องกัน MyInstants scraping abuse
const myinstantsLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10,
  message: { error: 'ค้นหาบ่อยเกินไป' }
});
```

### 8.3 Authentication Middleware
```javascript
function ensureAuthenticated(req, res, next) {
  if (req.session && req.session.streamer) return next();
  res.status(401).json({ error: 'UNAUTHORIZED' });
}

function ensureUserOwner(req, res, next) {
  const { username } = req.params;
  if (req.session.streamer?.username === username) return next();
  res.status(403).json({ error: 'FORBIDDEN' });
}
```

### 8.4 Input Validation
- ตรวจสอบ `username` ด้วย regex (ป้องกัน path traversal)
- จำกัดขนาดไฟล์อัพโหลด (5 MB ผ่าน Multer)
- Validate จำนวนเงิน (≥ 10 บาท)
- Validate รูปแบบเบอร์โทร (10 หลัก)

### 8.5 PDPA Compliance
- ไม่เก็บข้อมูลธุรกรรมเกิน 30 วัน (Auto-delete)
- เข้ารหัสข้อมูลอ่อนไหวทั้งหมดก่อนบันทึก
- ไม่ทำเป็นตัวกลางรับเงิน (เงินเข้าบัญชีผู้ใช้โดยตรง)
- มีหน้า Privacy Policy + Terms of Service

---

## 9. Troubleshooting

### SlipOK API

| ปัญหา | สาเหตุ | วิธีแก้ |
|-------|--------|---------|
| Error 1002 | API Key ผิด | ตรวจสอบ `x-authorization` header |
| Error 1010 (Delay Slip) | BBL/SCB ต้องรอ | ตั้ง timer ตามฟิลด์ `delay` แล้ว retry |
| Error 1012 (สลิปซ้ำ) | สลิปถูกใช้แล้ว | แจ้ง user ว่าสลิปนี้ถูกใช้ไปแล้ว |
| Error 1013 (ยอดไม่ตรง) | amount ไม่ตรง | ตรวจสอบว่าส่ง amount ถูกต้อง |
| Connection timeout | SlipOK ล่ม | แจ้ง "ระบบเช็คสลิปไม่ทำงานชั่วคราว" |

### Database (Turso)

| ปัญหา | สาเหตุ | วิธีแก้ |
|-------|--------|---------|
| `no such column` | ยังไม่ได้ migrate | รัน `npm run migrate` |
| 502 / Connection error | Turso ล่มชั่วคราว | ระบบมี fallback values + retry |
| Cold Start timeout | รัน migration ใน initDB | ห้ามรัน migration บน request path |

### Vercel Deployment

| ปัญหา | สาเหตุ | วิธีแก้ |
|-------|--------|---------|
| Session หายทุก request | ใช้ Memory Store | ใช้ TursoStore (Turso-backed) |
| `EROFS` read-only error | เขียนไฟล์ลง disk | ใช้ Turso DB เท่านั้น |
| Cookie ไม่ส่ง | `secure: true` บน HTTP proxy | ตั้ง `app.set('trust proxy', 1)` |

---

## การทดสอบ API

### ทดสอบ SlipOK
```bash
# ทดสอบเชื่อมต่อ (จาก Dashboard)
curl -X POST http://localhost:3000/api/payment/test-slipok \
  -H "Cookie: connect.sid=..." \
  -H "Content-Type: application/json" \
  -d '{"api": "https://api.slipok.com/api/line/apikey/xxx", "apiKey": "your-key"}'

# ตรวจสอบสลิป
curl -X POST http://localhost:3000/api/verify-slip \
  -F "slip=@slip.jpg" \
  -F "username=streamer_username" \
  -F "amount=100"
```

### ทดสอบ Alert
```bash
# ส่ง Test Alert
curl -X POST http://localhost:3000/api/alerts/test \
  -H "Cookie: connect.sid=..." \
  -H "Content-Type: application/json" \
  -d '{"donor": "Tester", "amount": 50, "message": "Test alert!"}'
```

---

Made by TBDEV