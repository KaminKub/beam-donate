# TipKub — แพลตฟอร์มหน้าโดเนทสำหรับสตรีมเมอร์

แพลตฟอร์ม Multi-Tenant สำหรับสตรีมเมอร์ สร้างหน้ารับบริจาคส่วนตัวพร้อมระบบ Live Donation Alert บน OBS รองรับหลายช่องทางชำระเงิน ผ่านระบบตรวจสอบสลิปโอนเงินอัตโนมัติด้วย SlipOK API พร้อมรองรับ PromptPay QR และ TrueMoney Wallet

## คุณสมบัติหลัก

### ระบบรับบริจาค
- **SlipOK Slip Verification** — ระบบหลัก ตรวจสอบสลิปโอนเงินอัตโนมัติผ่าน SlipOK API (รองรับ JPG, PNG, WEBP, JFIF)
- **PromptPay Direct** — QR Code EMVCo โอนตรงเข้าบัญชีพร้อมเพย์ของผู้ใช้ (เบอร์โทร / เลขบัตร / e-Wallet ID)
- **TrueMoney Wallet** — รับเงินผ่านวอลเลท ตรวจสอบสลิปด้วย SlipOK API (เช่นเดียวกับพร้อมเพย์)

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
- **แท็บ Goal Bar** — ตั้งเป้าหมายการรับบริจาค, ปรับยอด, รีเซ็ต
- **แท็บตั้งค่าบัญชี** — เชื่อมต่อ Twitch/Streamlabs, ลบบัญชี, ออกจากระบบ
- **Dona Monitor** — หน้าต่าง Popup แสดง Donation แบบ Real-time (URL: `/:username/dona-monitor`)

### ระบบยืนยันตัวตน
- **Twitch OAuth** — ล็อกอิน/สมัครด้วย Twitch
- **Streamlabs OAuth** — ล็อกอิน/สมัครด้วย Streamlabs
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
| Payment | SlipOK API (ตรวจสอบสลิป) |
| File Storage | Cloudflare R2 (S3-compatible, Profile images) |
| Encryption | AES-256-GCM (Node.js `crypto`) |
| File Upload | Multer (Memory Storage) + Presigned URLs (R2) |
| Realtime | Server-Sent Events (SSE) |
| Rate Limiting | express-rate-limit |
| Deployment | VPS + PM2 + Nginx + SSL (Primary) |

## โครงสร้างโปรเจค

```
beam-donate/
├── src/
│   ├── server.js              # Express server + Routes + SSE + OAuth + Payment APIs
│   ├── database.js            # Turso/SQLite Database Manager + Migrations
│   ├── encryption.js          # AES-256-GCM encrypt/decrypt/censor
│   ├── auth-helpers.js        # determinePrimaryAuth() + auth utilities
│   ├── sessionStore.js        # Custom Turso-backed session store
│   └── streamlabs.js          # Streamlabs OAuth helper
├── public/
│   ├── assets/                # Shared static assets
│   │   ├── payment/           # ไอคอน/โลโก้ วิธีชำระเงิน (PromptPay, TrueMoney)
│   │   ├── overlays/          # Overlay decorative assets (GIF)
│   │   ├── audio/             # Default audio (my-sound.mp3)
│   │   ├── slipok-guide/      # รูปภาพคู่มือตั้งค่า SlipOK
│   │   ├── style.css          # สไตล์หลักของ site
│   │   ├── tipkub-loading.css # Loading screen styles
│   │   ├── tipkub-loading.js  # Loading screen logic
│   │   └── cookie-consent.js  # Cookie Consent Banner
│   ├── pages/                 # HTML pages (Express sendFile routes)
│   │   ├── auth/              # login, register, register-setup, login-failed, forbidden
│   │   ├── index.html         # Landing Page (GET /)
│   │   ├── alert-test.html    # หน้าทดสอบ Alert
│   │   ├── privacy.html       # นโยบายความเป็นส่วนตัว
│   │   └── terms-of-services.html  # ข้อกำหนดและเงื่อนไข
│   ├── overlay/               # OBS Browser Source overlay (self-contained)
│   │   ├── index.html         # Overlay page
│   │   ├── overlay.css        # สไตล์ Overlay
│   │   └── overlay.js         # SSE client + Alert queue
│   ├── dashboard/             # Dashboard (หน้าควบคุมสตรีมเมอร์)
│   │   ├── index.html         # Dashboard HTML
│   │   ├── dashboard.js       # Dashboard Logic
│   │   ├── admin.css          # Dashboard Styles
│   │   ├── dona-monitor.html  # Donation Monitor popup
│   │   ├── slipok-guide.js    # SlipOK setup guide helper
│   │   └── sound-cache.js     # Cache ระบบเสียง
│   ├── donate-template/       # หน้าโดเนทของแต่ละ User (Dynamic)
│   │   ├── index.html         # Donate page 3-step flow
│   │   ├── app.js             # Donate flow logic + Slip upload
│   │   └── thank-you.html     # หน้าขอบคุณหลังโอนเงินสำเร็จ
│   └── goal-bar/              # Standalone donation goal widget
│       ├── index.html
│       ├── goal-bar.js
│       ├── goal-bar.css
│       └── goal-bar-animation.js
├── scripts/
│   └── migrate.js             # Database migration script
├── .env                       # Environment variables (ไม่อัปโหลดขึ้น Git)
├── ecosystem.config.js        # PM2 configuration
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

# Streamlabs OAuth
STREAMLABS_CLIENT_ID=your_streamlabs_client_id
STREAMLABS_CLIENT_SECRET=your_streamlabs_client_secret
STREAMLABS_REDIRECT_URI=http://localhost:3000/auth/streamlabs/callback

# Cloudflare R2 (File Storage)
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET_NAME=your_bucket_name
R2_PUBLIC_URL=https://your-r2-public-url.r2.dev

# Cron Authentication
CRON_SECRET=your_cron_secret

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
| GET | `/:username/overlay` | Overlay ของ User (OBS Browser Source) |
| GET | `/:username/dashboard` | Dashboard ของ User (ต้องเป็นเจ้าของ) |
| GET | `/:username/dona-monitor` | Donation Monitor popup (ต้องเป็นเจ้าของ) |
| GET | `/health` | Health Check |

### ยืนยันตัวตน (Auth)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/auth/twitch` | เริ่ม Twitch OAuth |
| GET | `/auth/twitch/callback` | Twitch OAuth callback |
| GET | `/auth/streamlabs` | เริ่ม Streamlabs OAuth |
| GET | `/auth/streamlabs/callback` | Streamlabs OAuth callback |
| GET | `/auth/register/twitch` | สมัครผ่าน Twitch |
| GET | `/auth/register/streamlabs` | สมัครผ่าน Streamlabs |
| POST | `/api/register/complete` | สร้างบัญชีหลังตั้งค่า Profile |
| GET | `/api/register/pending` | เช็คว่ามี pending user หรือไม่ |
| POST | `/api/logout` | ออกจากระบบ |

### จัดการบัญชี (User)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/user/me` | ข้อมูล User ที่ล็อกอินอยู่ |
| DELETE | `/api/user/delete` | ลบบัญชี (ต้องเป็นเจ้าของ) |
| POST | `/api/connections/disconnect` | ยกเลิกการเชื่อมต่อ Twitch/Streamlabs |
| POST | `/api/feedback` | ส่ง Feedback (Auth required) |
| GET | `/api/csrf-token` | ดึง CSRF Token (Auth required) |

### ชำระเงิน (Payment)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| POST | `/api/create-promptpay-qr` | สร้าง QR Code PromptPay (EMVCo) |
| POST | `/api/verify-slip` | อัพโหลดและตรวจสอบสลิปผ่าน SlipOK API |
| POST | `/api/verify-promptpay-slip` | ตรวจสอบสลิปพร้อมเพย์ (Rate Limited) |
| GET | `/api/payment/settings` | ดึงค่าตั้งค่าการรับเงิน (Auth required) |
| POST | `/api/payment/settings` | บันทึกค่าตั้งค่าการรับเงิน (Auth required) |
| POST | `/api/payment/test-slipok` | ทดสอบเชื่อมต่อ SlipOK API (Auth required) |
| GET | `/api/payment/slipok-quota` | ดึงโควต้า SlipOK คงเหลือ (Auth required) |
| GET | `/api/page/:username/payment-methods` | ดึงวิธีชำระเงินที่เปิดใช้ของ User (สาธารณะ) |

### อัพโหลดไฟล์ (Upload)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| POST | `/api/upload/presign` | สร้าง Presigned URL สำหรับอัพโหลดไฟล์ไป R2 (Auth required) |
| POST | `/api/upload/delete-file` | ลบไฟล์จาก R2 (Auth required) |

### Overlay & Alert

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/overlay/settings` | ดึงค่าตั้งค่า Overlay |
| POST | `/api/overlay/settings` | บันทึกค่าตั้งค่า Overlay + SSE Sync (Auth required) |
| GET | `/api/overlay/status` | เช็คสถานะ Overlay ของตัวเอง (Auth required) |
| GET | `/api/overlay/status/:username` | เช็คสถานะ Overlay ของ User (สาธารณะ) |
| GET | `/api/overlay/token` | ดึง Overlay Token (Auth required) |
| GET | `/api/alerts/stream` | SSE Stream สำหรับ Overlay/Goal-Bar/Dona-Monitor |
| POST | `/api/alerts/test` | ส่ง Test Alert (Auth required) |
| GET | `/api/page/:username/settings` | ดึงค่าตั้งค่าหน้าโดเนท (สาธารณะ) |
| POST | `/api/page/settings` | บันทึกค่าตั้งค่าหน้าโดเนท (Auth required) |

### Goal Bar

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/page/:username/goal` | ดึงข้อมูล Goal ของ User (สาธารณะ) |
| POST | `/api/goal/adjust` | ปรับยอด Goal (Auth required) |
| POST | `/api/goal/reset` | รีเซ็ต Goal (Auth required) |

### ธุรกรรม (Transactions)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/transactions/:username` | ดึงประวัติธุรกรรมของ User (Auth required) |
| GET | `/api/transactions/:username/download` | ดาวน์โหลดประวัติเป็น CSV (Auth required) |
| POST | `/api/transactions/:id/status` | บังคับเปลี่ยนสถานะธุรกรรม (Auth required) |

### ระบบเสริม

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/myinstants/search` | ค้นหาเสียงจาก MyInstants.com (Auth required) |
| GET | `/api/myinstants/proxy` | ยุติ HTML proxy: คืน 410 JSON (Auth required) |
| GET | `/api/myinstants/pages` | รายการหมวดหมู่ MyInstants (Auth required) |
| GET | `/api/tts` | Text-to-Speech proxy |

MyInstants catalog ใช้ manual fallback เป็นค่าเริ่มต้น: search ทั้ง authenticated/public คืน 503 พร้อม `code: CATALOG_DISABLED` และ `fallbackDirectUrl` โดยไม่เรียก upstream ผู้ใช้ยังเปิดเว็บ MyInstants และวาง Download MP3 URL ได้ใน Dashboard/Donate

ตั้ง `MYINSTANTS_CATALOG_ENABLED=true` เฉพาะหลังบันทึก permission ของผู้ให้บริการและผ่าน Legal review แล้วเท่านั้น; ไม่ต้องตั้งค่านี้เพื่อใช้งาน manual fallback เมื่อเปิดแล้ว upstream failure คืน 503 พร้อม `UPSTREAM_*` และ `Retry-After` 30–300 วินาที (busy ขณะมีคำขออื่น: 1 วินาที) ผลค้นหาสำเร็จ/ว่างจริงคืน 200 ห้ามเปิดเพื่อทดลองหลบ Cloudflare ต้องผ่าน release gate ตามปกติเมื่อเปลี่ยน production environment

### Demo (ทดลองใช้งาน)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/demo/dashboard` | Demo Dashboard (Rate Limited) |
| GET | `/demo/overlay` | Demo Overlay |
| GET | `/demo/goal-bar` | Demo Goal Bar |
| GET | `/demo/dona-monitor` | Demo Dona Monitor |
| GET | `/api/demo/settings` | ดึงการตั้งค่า Demo |
| GET | `/api/demo/overlay/settings` | ดึงการตั้งค่า Overlay Demo |
| GET | `/api/demo/alerts/stream` | SSE Stream Demo |
| GET | `/api/demo/transactions` | ดึง Transaction Demo |
| POST | `/api/demo/alerts/test` | ส่ง Test Alert Demo (Rate Limited) |
| POST | `/api/demo/goal/test` | ส่ง Test Goal Demo (Rate Limited) |

### Cron Jobs (Protected)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| POST | `/api/cron/cleanup-expired` | ลบธุรกรรมหมดอายุ |
| POST | `/api/cron/cleanup-quarterly` | ลบข้อมูลรายไตรมาส |
| POST | `/api/cron/cleanup-r2-orphans` | ลบไฟล์ R2 ที่ไม่มี record ใน DB |

## ระบบชำระเงิน

### SlipOK Slip Verification (ระบบหลัก)
ใช้ตรวจสอบสลิปโอนเงินทั้ง **PromptPay** และ **TrueMoney Wallet** ผ่าน SlipOK API เดียวกัน

1. Backend สร้าง QR Code (PromptPay EMVCo หรือ TrueMoney Wallet) พร้อมระบุจำนวนเงิน
2. User สแกน QR ด้วยแอปธนาคาร/TrueMoney → โอนเงิน
3. User อัพโหลดสลิปโอนเงิน (JPG/PNG/WEBP)
4. Backend ส่งสลิปไปตรวจสอบที่ SlipOK API (`POST /api/verify-slip`)
5. SlipOK คืนข้อมูลธุรกรรม (จำนวนเงิน, ธนาคาร, ผู้โอน, ผู้รับ)
6. ระบบตรวจสอบยอดเงิน + บัญชีผู้รับ → ยืนยันการบริจาค + ยิง Alert

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
รัน script `scripts/migrate.js` เพื่อสร้าง/อัปเดต schema — ห้ามรัน migration บน request path (จะ timeout)

## Deployment

### VPS (Primary)
- Ubuntu 24.04 + PM2 + Nginx reverse proxy + SSL (Certbot)
- รองรับทุกฟีเจอร์ (SSE, File Upload, Real-time Alert)
- PM2 ecosystem config: `ecosystem.config.js`

Environment Variables ที่ต้องตั้งค่า:
```
TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
SESSION_SECRET, MASTER_ENCRYPTION_KEY, ENCRYPTION_SALT
TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_CALLBACK_URL
STREAMLABS_CLIENT_ID, STREAMLABS_CLIENT_SECRET, STREAMLABS_REDIRECT_URI
R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL
CRON_SECRET
PORT
```

## License

MIT

---

Original project by TBDEV
Muti-user Project TipKub by KaminKub
