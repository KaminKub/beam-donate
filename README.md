# TipKub — แพลตฟอร์มหน้าโดเนทสำหรับสตรีมเมอร์

แพลตฟอร์ม Multi-Tenant สำหรับสตรีมเมอร์ สร้างหน้ารับบริจาคส่วนตัวพร้อมระบบ Live Donation Alert บน OBS รองรับหลายช่องทางชำระเงิน ผ่านระบบตรวจสอบสลิปโอนเงินอัตโนมัติด้วย SlipOK API พร้อมรองรับ PromptPay QR และ TrueMoney Wallet

## คุณสมบัติหลัก

### ระบบรับบริจาค
- **SlipOK Slip Verification** — ระบบหลัก ตรวจสอบสลิปโอนเงินอัตโนมัติผ่าน SlipOK API (รองรับ JPG, PNG, WEBP, JFIF)
- **PromptPay Direct** — QR Code EMVCo โอนตรงเข้าบัญชีพร้อมเพย์ของผู้ใช้ (เบอร์โทร / เลขบัตร / e-Wallet ID)
- **TrueMoney Wallet** — รับเงินผ่านวอลเลท ตรวจสอบสลิปด้วย SlipOK API (เช่นเดียวกับพร้อมเพย์)
- ~~**Feel Free Pay (FFP)** — ระบบรับเงินทางเลือก~~ **ยกเลิกแล้ว (2026-06-30)**: FFP ไม่อนุมัติ API โค้ดถูกเก็บไว้ดู `.agents/guides/FFP_REACTIVATION_GUIDE.md`

### Live Donation Alert (OBS Overlay)
- แสดง Alert แบบ Real-time บน OBS/Stream ผ่าน Server-Sent Events (SSE)
- ปรับแต่งธีม (Glassmorphism, Cyberpunk, Minimalist, Custom)
- เลือกแบบอักษรภาษาไทย (Noto Sans Thai, Kanit, Mitr, Chakra Petch, Sarabun)
- แอนิเมชันเข้า (Slide Down/Up, Fade, Zoom)
- ระบบเสียงเตือน (Classic Chime, Retro Arcade, Modern Synth, Soft Bell, Custom URL)
- เลือกเสียงจาก **MyInstants.com** ผ่าน Sound Browser ใน Dashboard
- **TTS Engine** — อ่านข้อความออกเสียงภาษาไทย/อังกฤษ ด้วย Web Speech API
- ตัวกรองคำหยาบ (Profanity Filter)
- Real-time Live Sync — เปลี่ยน skin สี/แอนิเมชัน/เสียงบน OBS ทันทีโดยไม่ต้อง Refresh
- Live Preview — Iframe ตัวอย่างแบบ Interactive

### Dashboard (หน้าควบคุมสตรีมเมอร์)
- **แท็บประวัติธุรกรรม** — ดูสถิติ, ค้นหา, Force Pay, Test Alert, Raw Inspect, ดาวน์โหลด CSV
- **แท็บตั้งค่าหน้าโดเนท** — ชื่อหน้า, คำบรรยาย, Social Links, ภาพโปรไฟล์, สีเรืองแสง
- **แท็บปรับแต่ง Overlay** — ธีม, ฟอนต์, แอนิเมชัน, เสียง, TTS, สี, ขนาดอักษร
- **แท็บตั้งค่าการรับเงิน** — เลือกเปิด/ปิด PromptPay + TrueMoney Wallet, กรอก SlipOK API
- **แท็บตั้งค่าบัญชี** — เชื่อมต่อ Twitch/Streamlabs, ลบบัญชี, ออกจากระบบ

### ระบบยืนยันตัวตน
- **Twitch OAuth** — ล็อกอิน/สมัครด้วย Twitch
- **Streamlabs OAuth** — ล็อกอิน/สมัครด้วย Streamlabs (กำลังพัฒนา)
- หน้า Register แยกสำหรับผู้ใช้ใหม่ พร้อมยอมรับข้อกำหนดและเงื่อนไข
- Session เก็บใน **Turso DB** (รองรับ Serverless)

### ระบบความปลอดภัย
- **AES-256-GCM Encryption** — เข้ารหัสข้อมูลสำคัญก่อนบันทึกลง DB (เบอร์พร้อมเพย์, API Key, เลขบัญชี)
- **Censor Display** — แสดงข้อมูลแบบเซ็นเซอร์ เช่น `081****3456`
- **Rate Limiting** — ป้องกันการเรียก API ซ้ำๆ (SlipOK, MyInstants)
- **PDPA Compliance** — นโยบายความเป็นส่วนตัวสอดคล้องกับ พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5 + CSS3 + Vanilla JavaScript |
| Backend | Node.js + Express 4 |
| Database | Turso Cloud SQLite (`@libsql/client`) + In-Memory Fallback |
| Authentication | Passport.js (Twitch OAuth, Streamlabs OAuth) |
| Session Store | TursoStore (Custom Turso-backed session store) |
| Payment | SlipOK API (ตรวจสอบสลิป) + Feel Free Pay (กำลังพัฒนา) |
| Encryption | AES-256-GCM (Node.js `crypto`) |
| File Upload | Multer (Memory Storage) |
| Realtime | Server-Sent Events (SSE) |
| Rate Limiting | express-rate-limit |
| Deployment | Vercel (Serverless) |

## โครงสร้างโปรเจค

```
beam-donate/
├── src/
│   ├── server.js              # Express server + Routes + SSE + OAuth + SlipOK API
│   ├── database.js            # Turso/SQLite Database Manager + Migrations
│   ├── encryption.js          # AES-256-GCM encrypt/decrypt/censor
│   ├── sessionStore.js        # Custom Turso-backed session store
│   └── streamlabs.js          # Streamlabs OAuth helper
├── public/
│   ├── index.html             # Landing Page (หน้าแรก)
│   ├── login.html             # หน้าล็อกอิน (Twitch + Streamlabs)
│   ├── register.html          # หน้าสมัครสมาชิก
│   ├── register-setup.html    # หน้าตั้งค่าหลังสมัคร (Username, Profile)
│   ├── privacy.html           # นโยบายความเป็นส่วนตัว
│   ├── terms-of-services.html # ข้อกำหนดและเงื่อนไข
│   ├── login-failed.html      # หน้าล็อกอินล้มเหลว
│   ├── style.css              # สไตล์หลักของหน้าโดเนท
│   ├── overlay.html           # Live Donation Alert Overlay (OBS Browser Source)
│   ├── overlay.css            # สไตล์ Overlay
│   ├── overlay.js             # SSE client + Alert queue
│   ├── alert-test.html        # หน้าทดสอบ Alert
│   ├── thank-you.html         # หน้าขอบคุณหลังโอนเงินสำเร็จ
│   ├── cookie-consent.js      # Cookie Consent Banner
│   ├── Image/                 # ไอคอน/โลโก้ วิธีชำระเงิน
│   │   ├── FFP-logo.png  (เก็บไว้ — FFP decommissioned)
│   │   ├── QR-PromptPay.png
│   │   ├── TrueWallate.png
│   │   └── icon-thaiqr.png
│   ├── dashboard/             # Dashboard (หน้าควบคุมสตรีมเมอร์)
│   │   ├── index.html         # Dashboard HTML
│   │   ├── dashboard.js       # Dashboard Logic
│   │   ├── admin.css          # Dashboard Styles
│   │   └── sound-cache.js     # Cache ระบบเสียง
│   └── donate-template/       # หน้าโดเนทของแต่ละ User (Dynamic)
│       ├── index.html         # Donate page 3-step flow
│       └── app.js             # Donate flow logic + Slip upload
├── scripts/
│   └── migrate.js             # Database migration script
├── .env                       # Environment variables (ไม่อัปโหลดขึ้น Git)
├── vercel.json                # Vercel deployment config
├── package.json
└── README.md
```

## การติดตั้งและใช้งาน

### 1. Clone & Install

```bash
git clone https://github.com/KaminKub/beam-donate.git
cd beam-donate
npm install
```

### 2. สร้างไฟล์ `.env`

```env
# Database — Turso Cloud SQLite
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_turso_jwt_token

# Session
SESSION_SECRET=your_session_secret

# Encryption (AES-256-GCM)
MASTER_ENCRYPTION_KEY=your_master_encryption_key
ENCRYPTION_SALT=your_encryption_salt

# Twitch OAuth
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
TWITCH_CALLBACK_URL=http://localhost:3000/auth/twitch/callback

# Streamlabs OAuth (ถ้ามี)
STREAMLABS_CLIENT_ID=your_streamlabs_client_id
STREAMLABS_CLIENT_SECRET=your_streamlabs_client_secret
STREAMLABS_REDIRECT_URI=http://localhost:3000/auth/streamlabs/callback

# Server
PORT=3000
```

### 3. Setup Database

```bash
npm run migrate
```

### 4. รัน Server

```bash
# Development (Watch mode)
npm run dev

# Production
npm start
```

### 5. เปิดเว็บ

```
http://localhost:3000
```

## API Endpoints

### หน้าสาธารณะ (Public)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/` | Landing Page |
| GET | `/login` | หน้าล็อกอิน |
| GET | `/register` | หน้าสมัครสมาชิก |
| GET | `/register/setup` | หน้าตั้งค่าหลังสมัคร |
| GET | `/:username` | หน้าโดเนทของ User (Dynamic) |
| GET | `/:username/thank-you` | หน้าขอบคุณของ User |
| GET | `/:username/overlay` | Overlay ของ User |
| GET | `/:username/dashboard` | Dashboard ของ User (ต้องเป็นเจ้าของ) |

### ยืนยันตัวตน (Auth)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/auth/twitch` | เริ่ม Twitch OAuth |
| GET | `/auth/twitch/callback` | Twitch OAuth callback |
| GET | `/auth/streamlabs` | เริ่ม Streamlabs OAuth |
| GET | `/auth/streamlabs/callback` | Streamlabs OAuth callback |
| GET | `/auth/register/twitch` | สมัครผ่าน Twitch (ข้าม OAuth ถ้ามี pending user) |
| GET | `/auth/register/streamlabs` | สมัครผ่าน Streamlabs (ข้าม OAuth ถ้ามี pending user) |
| POST | `/api/register/complete` | สร้างบัญชีหลังตั้งค่า Profile |
| GET | `/api/register/pending` | เช็คว่ามี pending user หรือไม่ |
| POST | `/api/logout` | ออกจากระบบ |

### จัดการบัญชี (User)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/user/me` | ข้อมูล User ที่ล็อกอินอยู่ |
| DELETE | `/api/user/delete` | ลบบัญชี (ต้องเป็นเจ้าของ) |

### ชำระเงิน (SlipOK + PromptPay)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| POST | `/api/create-promptpay-qr` | สร้าง QR Code PromptPay (EMVCo) |
| POST | `/api/verify-slip` | อัพโหลดและตรวจสอบสลิปผ่าน SlipOK API |
| POST | `/api/verify-promptpay-slip` | ตรวจสอบสลิปพร้อมเพย์ (Rate Limited) |
| GET | `/api/payment/settings` | ดึงค่าตั้งค่าการรับเงิน (เข้ารหัสแล้ว) |
| POST | `/api/payment/settings` | บันทึกค่าตั้งค่าการรับเงิน (เข้ารหัสก่อนเก็บ) |
| POST | `/api/payment/test-slipok` | ทดสอบเชื่อมต่อ SlipOK API |
| GET | `/api/page/:username/payment-methods` | ดึงวิธีชำระเงินที่เปิดใช้ของ User |

### Overlay & Alert

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/overlay/settings` | ดึงค่าตั้งค่า Overlay |
| POST | `/api/overlay/settings` | บันทึกค่าตั้งค่า Overlay + SSE Sync |
| GET | `/api/overlay/status` | เช็คสถานะ Overlay (Online/Offline) |
| GET | `/api/overlay/token` | ดึง Overlay Token |
| GET | `/api/alerts/stream` | SSE Stream สำหรับ Overlay |
| POST | `/api/alerts/test` | ส่ง Test Alert |
| GET | `/api/page/:username/settings` | ดึงค่าตั้งค่าหน้าโดเนท (สาธารณะ) |
| POST | `/api/page/settings` | บันทึกค่าตั้งค่าหน้าโดเนท |

### ธุรกรรม (Transactions)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/transactions/:username` | ดึงประวัติธุรกรรมของ User |
| GET | `/api/transactions/:username/download` | ดาวน์โหลดประวัติเป็น CSV |
| POST | `/api/transactions/:id/status` | บังคับเปลี่ยนสถานะธุรกรรม |

### ระบบเสริม

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/myinstants/search` | ค้นหาเสียงจาก MyInstants.com (Rate Limited) |
| GET | `/api/myinstants/proxy` | Proxy ดึงข้อมูลเสียงจาก MyInstants |
| GET | `/api/myinstants/pages` | รายการหน้าหมวดหมู่ MyInstants |
| GET | `/api/tts` | Text-to-Speech proxy |
| GET | `/health` | Health Check |

### Cron Jobs

| Method | Path | คำอธิบาย |
|--------|------|----------|
| POST | `/api/cron/cleanup-expired` | ลบธุรกรรมหมดอายุ |
| POST | `/api/cron/cleanup-quarterly` | ลบข้อมูลรายไตรมาส |

## ระบบชำระเงิน

### SlipOK Slip Verification (ระบบหลัก)
ใช้ตรวจสอบสลิปโอนเงินทั้ง **PromptPay** และ **TrueMoney Wallet** ผ่าน SlipOK API เดียวกัน

1. Backend สร้าง QR Code (PromptPay EMVCo หรือ TrueMoney Wallet) พร้อมระบุจำนวนเงิน
2. User สแกน QR ด้วยแอปธนาคาร/TrueMoney → โอนเงิน
3. User อัพโหลดสลิปโอนเงิน (JPG/PNG/WEBP)
4. Backend ส่งสลิปไปตรวจสอบที่ SlipOK API (`POST /api/verify-slip`)
5. SlipOK คืนข้อมูลธุรกรรม (จำนวนเงิน, ธนาคาร, ผู้โอน, ผู้รับ)
6. ระบบตรวจสอบยอดเงิน + บัญชีผู้รับ → ยืนยันการบริจาค + ยิง Alert

### ~~Feel Free Pay (FFP)~~ — ยกเลิกแล้ว (2026-06-30)
FFP ไม่อนุมัติให้ใช้ API กับโปรเจคนี้ โค้ดทั้งหมดถูก comment/skip ไว้ (ไม่ลบ)  
หากต้องการกลับมาเปิดใช้งานอีกครั้ง อ่าน `.agents/guides/FFP_REACTIVATION_GUIDE.md`

### การเข้ารหัสข้อมูล
ข้อมูลสำคัญทั้งหมดเข้ารหัสด้วย **AES-256-GCM** ก่อนบันทึกลงฐานข้อมูล:

| ประเภทข้อมูล | รูปแบบที่แสดง |
|--------------|---------------|
| เบอร์พร้อมเพย์ / เลขบัตร | `081****3456` |
| SlipOK API Endpoint | `https://api.slipok.com/.../****` |
| SlipOK API Key | `****abcd` |
| เบอร์ TrueMoney Wallet | `081****3456` |

## ฐานข้อมูล

### ตาราง `streamers`
เก็บข้อมูล User และการตั้งค่าทั้งหมด (Overlay, Payment, Profile, Social Links)

### ตาราง `transactions`
เก็บประวัติธุรกรรมการบริจาค (Auto-delete หลัง 30 วัน)

### การ Migration
```bash
npm run migrate
```
รัน script `scripts/migrate.js` เพื่อสร้าง/อัปเดต schema — **ห้าม** รัน migration บน request path (Vercel Cold Start จะ timeout)

## Deployment

### VPS (แนะนำ)
- เสปกขั้นต่ำ: 1 vCPU / 1 GB RAM / 15 GB SSD (Ubuntu 24.04)
- รองรับทุกฟีเจอร์ (SSE, File Upload, Real-time Alert)
- PM2 + Nginx + SSL + Cloudflare DNS Failover

### Vercel (สำรอง)
Environment Variables ที่ต้องตั้งค่าบน Vercel:
- `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (Database)
- `SESSION_SECRET` (Session)
- `MASTER_ENCRYPTION_KEY` + `ENCRYPTION_SALT` (Encryption)
- `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` + `TWITCH_CALLBACK_URL` (OAuth)

ข้อควรระวัง:
- SSE ใช้ไม่ได้บน Vercel Free (Function timeout 10 วิ)
- ไม่ต้องรัน `npm run migrate` — รันแยกก่อน deploy

## License

MIT

---

Original project by TBDEV
Muti-user Project TipKub by KaminKub
