# 🚀 TipKub Development Checklist

This file tracks the progress, bugs, and future ideas for the TipKub project.

## ⏳ To Do (แผนที่จะทำต่อไป)
- [x] ได้เวลาเขียน README.md ใหม่สำหรับทั้ง Project TipKub และแก้ API_INTEGRATION_GUIDE.md ให้เป็นแนะนำการวางโค๊ตการทำงานให้ API ใช้ได้กับโปรเจค รวมถึง API ของ SlipOK ด้วย
- [x] ติดตั้งระบบ Honeypot + Timestamp Block Bot ป้องกันการสแปม endpoint สาธารณะ (ไม่เสียโควต้า SlipOK)
  - [x] Step 1: `src/server.js` — `generatePageToken()` + `verifyPageToken()` + inject `{{page_token}}` ใน template + ตรวจจับใน 3 route (`/api/verify-slip`, `/api/verify-promptpay-slip`, `/api/create-promptpay-qr`)
  - [x] Step 2: `public/donate-template/index.html` — เพิ่ม `<meta name="page-token">` + honeypot input (`name="contact_email"`)
  - [x] Step 3: `public/donate-template/app.js` — `getAntiBotPayload()` อ่าน token จาก meta + ส่ง `page_token` และ `contact_email: ""` ในทุก POST request
  - [x] Step 4: ทดสอบ — syntax check ทุกไฟล์ + `npm run dev` + ทดสอบหน้า donate ว่า User จริง submit ได้ปกติ
- [x] เพิ่มด่านป้องกันสแปมสลิปซ้ำ 3 ชั้น (ใน `src/server.js` — `/api/verify-slip`):
  - [x] ชั้น 1: `verifySlipLimiter` rate limit — 30 req/60s ต่อ IP (จากเดิมไม่ได้ apply)
  - [x] ชั้น 2: Transaction status guard — ถ้า transaction `status === 'successful'` แล้ว → ปัดทิ้ง ไม่เรียก SlipOK
  - [x] ชั้น 3: In-memory slip hash dedup (SHA256) — สลิปเดิมถูกส่งซ้ำภายใน 5 นาที → ปัดทิ้ง
  - [x] ชั้น 4: SlipOK `log: true` — ฝั่ง API ตรวจจับสลิปซ้ำ ไม่กินเครดิต (มีอยู่แต่เดิม)
- [ ] ทำให้สามารถปรับเปลียนภาพปก Header และพื้นหลังจางๆได้ โดยใช้ URL และให้ User กำหนดเองได้
- [ ] เขียนระบบเช็คหลังบ้านว่ามี user คนไหนบ้างที่กำลังเปิดใช้ Active Overlay อยู่ โดยก่อนทำต้องตรวจให้แน่ใจก่อนว่าจะไม่กระทบกับ Versel เพราะว่าใช้ระบบฟรี กังวลว่ามันจะไปหนักเซิฟ
- [x] ปรับยอดโดเนทขั้นต่ำ 10 บาทขึ้นไป พร้อมทำป้ายกำกับเล็กๆใต้ปุ่ม customAmount 
- [x] ตรงปุ่ม amount-options หาก User ตั้งขั้นต่ำระหว่าง 1 บาท - 10 บาท ให้แสดงค่าเดียวกันกับตอนตั้งขั้นต่ำที่ 10 บาท เมื่อตั้งขั้นต่ำมากกว่า 10 บาท ให้ปรับไปตามระบบได้เลย
- [x] ลบบรรทัดนี้ออกจากหน้า Donate <div id="minAmountLabel" class="min-amount-label">ขั้นต่ำ ฿1</div>
- [x] เพิ่มปุ่ม Sound alert โดยลิ้งกับหน้า `www.myinstants.com` (พยายามหาวิธีดึง API มาเพื่อดึงมาเฉพาะเสียงแล้วเลือกเสียงได้) > ปุ่มๆนี้จะปรากฏออกมาก็ต่อเมื่อเลือกเสียงแบบ Custom sound url เท่านั้น > เอาเสียงจากเว็บนี้มาทำเป็นลิส popup ให้เลือกเสียงและมีปุ่มกด Play ให้ทดลองเล่นเสียงได้ตามใจชอบ แล้วจะเอาเสียงนั้นๆมาใส่ระบบ Alert เราในรูปแบบ URL
  - ✅ **เสร็จแล้ว** (2026-06-20):
    - Backend: `/api/myinstants/search` พร้อม rate limiting (10 req/10s) และ cache (10 นาที)
    - Frontend: ปุ่ม "🔍 เลือกเสียงจาก myinstants.com" ใน customSoundUrlContainer
    - Modal popup พร้อม search, multi-page (Thailand, Global, US, Japan, Germany, Brazil, France, UK)
    - Infinite scroll / pagination
    - Sound caching system (sound-cache.js) - Cache API ใน browser
    - Attribution: "Sounds provided by Myinstants.com"
    - Warning: แนะนำให้อัพโหลดเสียงเป็น URL ส่วนตัว เนื่องจากเสียงจาก MyInstants อาจไม่เล่นบน Overlay
- [ ] เปลี่ยนมาใช้ระบบ Feel Free pay จากระบบเดิมที่เป็น Beam Checkout แต่ยังคงคอนเซ็ปต์เดิมในเรื่องการเข้ารหัสก่อนเก็บข้อมูล API หรือ Secret ข้อมูล FFP ของผู้ใช้ ทำให้ปลอดภัยให้มากที่สุด
- [x] เพิ่มวิธีรับเงินทางเลือก คือวิธีรับเงินผ่าน Promtpay ของผู้ใช้โดยตรงเลย โดยให้ผู้ใช้กรอกหมายเลขโทรศัพท์ที่เชื่อมกับพร้อมเพย์ เพื่อรับเงินและตรวจสอบการโอนเงินเพื่อให้ Alert ทำงานโดยใช้ระบบของ TFP - Thailand Developer Open API ในการเช็คสลิปโอนเงินเพื่อตรวจสอบ Mini QR ที่อยู่บนสลิป และตอนที่คนที่จะโดเนทกดสร้าง QR Code แสกนจ่ายเงินระบุจำนวน ต้องตรวจสอบเสมอว่าเชื่อมต่อ API สำเร็จหรือไม่ หากไม่จะทำการแจ้งเตือนว่า "ระบบเช็คสลิปไม่ทำงานชั่วคราว โปรดรอสักครู่แล้วลองใหม่"
- [x] อัพเดทนโยบาทความเป็นส่วนตัว และ  ข้อกำหนดและเงื่อนไขการให้บริการ ให้สอดคล้องกับฟีเจอร์ที่เพิ่มมาล่าสุด อย่างระบบ API ของ SlipOK โดยยังเน้นย้ำเรื่องการเข้ารหัสก่อนเก็บข้อมูลเข้า DataBase เพื่อความปลอดภัยของข้อมูล User เหมือนเดิม


## 🔍 Need re-check (รอตรวจสอบซ้ำ)
- [x] แก้ไขปัญหา Overlay Status บน Vercel ที่สถานะค้างเป็น Online หรือสลับไปมาแม้จะปิดหน้า Overlay ไปแล้ว
- [x] แก้ภาพ Favicon ของหน้า donate ของแต่ละ user ให้มี Favicon เป็นของตัวเองโดยอ้างอิงจากภาพโปรไฟล์ของตัวเองในแต่ละ User
- [x] ในหน้า Donate ต้องการปรับตำแหน่งและขนาดปุ่มกดเลือกจำนวนเงินให้เล็กลงเพื่อให้เพียงพอที่จะย้ายมาอยู่ตำแหน่งแทนคำว่า "หรือระบุจำนวนเงินด้วยตนเอง" โดยปุ่มทั้ง 4 ปุ่มจะเรียงเป็นแถวเดียว ปรับขนาดให้เหมาะสม
- [x] ใส่ส่วนของหน้า Donate-template ส่วนของ id="pageTitle" ช่วยเปลี่ยนจาก "เลี้ยงกาแฟ KaminKub" เป็นให้อ้างอิงจาก inputPageTitle ของแต่ละ User ที่ตั้งค่าใน Dashboard
- [ ] เพิ่มหน้า "บัญชีผู้ใช้" เพื่อตั้งค่าบัญชี โดยในขั้นตอนนี้จะเพิ่มวิธีการล็อกอินโดยใช้ Streamlabs 
เข้ามาให้ผู้ใช้กดเชื่อม ID เพื่อที่จะสามารถล็อกอินผ่าน Streamlabs ได้เป็นอีกทางเลือก และเป็นอีกทางเลือกสำหรับ user ใหม่ที่จะมาสมัคร ให้สามารถสมัครด้วย Streamlabs ได้ด้วย
สรุปคือ จะให้ช่วยทำการตรวจสอบโค้ดในระบบ Login ของ Twitch เดิม (เช่น ในไฟล์เราต์หลัก หรือ Passport/OAuth configuration ของระบบ) แล้วเพิ่มตัวเลือกการทำ OAuth2 สำหรับ Streamlabs เข้ามาคู่กัน
เงื่อนไขคือ:
1.เส้นทาง (Route) สำหรับการกด Login ให้แยกกันชัดเจน เช่น /auth/twitch และ /auth/streamlabs
2.เมื่อผูกสิทธิ์ผ่าน OAuth สำเร็จ ให้ดึงค่า Username(ถ้ามี) และภาพโปรไฟล์มาอัปเดตลงตารางผู้ใช้ใน Turso DB เหมือนกับตอนที่ Login ด้วย Twitch"
3.ในหน้าตั้งค่าบัญชี จะแสดงให้เห็นว่าบัญชีนี้มีการเชื่อมต่อกับบัญชี Twitch และ Streamlabs อยู่หรือไม่ หากเชื่อมต่อแล้วจะแสดงสัญลักษณ์หรือปุ่มว่า "เชื่อมแล้ว" เป็นสถานะสีเขียว แต่หากยังจะมีปุ่มให้กดเชื่อมต่อเพื่อเข้าสู่หน้าล็อกอินผ่าน OAuth ไม่ว่าจะเป็นของ Twitch หรือ Streamlabs เมื่อเชื่อมต่อแล้วจะส่งข้อมูล ID ไปยัง Turso DB
4.เมื่อผู้ใช้มี ID ของ Twitch กับ Streamlabs แล้ว ผู้ใช้จะสามารถล็อกอินเพื่อเข้าหน้า Dashboard ได้ทั้ง 2 ช่องทาง
5.ในหน้า Login ก็ให้เพิ่มปุ่มล็อกอินด้วย Streamlabs เพิ่มมาอีกปุ่มโดยกำหนดรูปแบบให้คล้ายคลึงกับปุ่มล็อกอินด้วย Twitch และปรับสีให้เข้ากับ Streamlabs
6.ให้ AI ช่วยแนะนำว่าควรเพิ่มเติมอะไรนอกเหนือจากนี้ไหม

## ✅ Completed (ดำเนินการเสร็จสิ้นแล้ว)
- [ยกเลิกไม่แก้ไขแล้ว] ใน dashbord (dashbord/index.html)ใน class custom-colors-container เปลี่ยนให้เป็นแบบ Colorpick Eyedropper และให้สามารถปรับค่า  transparent ได้ในตัวเลย
- [x] <h2><a href="https://tipkub.me"><span class="highlight-amount">TipKub</span></a></h2> ทั้งในหน้า Dashboard และ ในหน้า donate-template ต้องการให้เปลี่ยนจาก https://tipkub.me ให้กลายเป็นหน้าแรก index.html ของ public
- [x] ใน dashbord ในส่วนของ <div class="brand-logo">😺</div> ให้เปลี่ยนจาก 😺 เป็นรูปภาพโปรไฟล์ของแต่ละ User โดยภาพโปรไฟล์ให้ทำ border-radius : 50%; และต้องมีขนาดเท่ากับค่าเดิมตอนที่ยังเป็น 😺 อยู่
- [x] Icon Social Link กำหนดเงื่อนไขว่า หากผู้ใช้กำหนดลิงก์ไม่เกิน 3 ปุ่ม ปุ่มนั้นๆจะมีข้อความชื่อแพลตฟอร์มนั้นๆข้างใน
- [x] ลบตัวแจ้ง Debug [API] ออกจาก server.js
- [x] Dashboard: เปลี่ยนระบบแจ้งเตือนเป็น Animation (Fade-in/out)
- [x] แก้หน้าแรก เลเอาต์กึ่งกลางมือถือ และลบปุ่ม "+สร้างหน้าโดเนทส่วนตัว"
- [x] ลบไฟล์ `PENDING_FEATURES.md`
- [x] Dashboard Mobile: เพิ่ม Hamburger Menu, Sticky Header และ Floating Buttons
- [x] Dashboard: ลบปุ่ม `btn-edit-avatar` และแสดงช่อง URL โปรไฟล์ตลอดเวลา
- [x] แก้ไข Database ให้ Save ได้แบบไม่ติดขัด
- [x] แก้ไขปัญหา Twitch_ID ใน Database ถูกลบเมื่อกดบันทึกปรับแต่งในหน้า Dashboard
- [x] เพิ่มจุดเปลี่ยนสีเรืองแสงในหน้าตั้งค่าโดเนท
- [x] ปรับให้หน้า `thank-you.html` แยกเป็นของแต่ละ user
- [x] ทำแถบหน้า Pay out Setting ("ตั้งค่าการรับเงิน") แทนที่ปุ่มลิ้งโดเนทด้านซ้าย
- [x] ออกแบบหน้า register
- [x] แก้ไข Quick Alert ให้ทำงานในหน้า Overlay ปกติ (ไม่ใช่แค่ `token=ready1`)
- [x] ออกแบบหน้าสร้างหน้าโดเนท
- [x] แก้ไขปัญหาการโหลดข้อมูลจาก Database เมื่อ Deploy บน Vercel
- [x] เข้ารหัส Beamkey ของแต่ละ User เพื่อความปลอดภัย
- [x] เพิ่ม `ALLOWED_TWITCH_USERNAME`
- [x] บังคับให้ URL หน้า Overlay มี `?token={overlay_token}` ต่อท้ายเสมอ
- [x] ทำระบบ Overlay Status เช็คสถานะแยกแต่ละ User (`updateOverlayStatus`)

## 💡 Ideas (ไอเดียเพิ่มเติม)
- [~] ~~สร้างหน้าโดเนทสำหรับผู้พัฒนาโดยเฉพาะ โดยตั้ง Username ว่า TipKub~~ (ยกเลิก)
- [~] ~~ระบบเก็บไฟล์เสียง Alert ไว้ใน GitHub หรือ Discord~~ (ยกเลิก)
- [ ] หน้า Home: นำโปรไฟล์ User มาแสดงแบบลอยๆ และสามารถคลิกได้ (มีปุ่ม "อนุญาตนำภาพขึ้นโปรโมทหน้า TipKub")
