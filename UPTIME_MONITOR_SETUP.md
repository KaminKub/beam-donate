# External Uptime Monitor + Discord

ระบบนี้ตรวจสอบ `GET /health` จาก GitHub-hosted runner ทุก 5 นาที และส่งข้อความไป Discord เมื่อระบบล้มเหลวหรือกลับมาใช้งานได้ โดยไม่เพิ่มโปรเซสบน VPS และไม่แตะ route หรือข้อมูลการชำระเงิน

## ตั้งค่า

ใน GitHub repository ไปที่ `Settings → Secrets and variables → Actions` แล้วสร้าง **Repository secrets**:

- `HEALTHCHECK_URL` — เช่น `https://your-domain.example/health`
- `DISCORD_WEBHOOK_URL` — Discord Webhook URL ของห้องแจ้งเตือน
- `DISCORD_WATCHDOG_THREAD_ID` — Discord Thread ID ที่ต้องการให้แจ้งเตือนเข้าไป

จากนั้นนำ workflow นี้ขึ้นไปยัง default branch ที่ GitHub ใช้รัน scheduled workflows:

`.github/workflows/uptime-monitor.yml`

สามารถทดสอบทันทีจาก `Actions → External uptime monitor → Run workflow` ได้ด้วย

## พฤติกรรมการแจ้งเตือน

- ล้มเหลวครั้งแรก: เก็บสถานะไว้ ยังไม่แจ้ง เพื่อกัน false alarm
- ล้มเหลวต่อเนื่องครั้งที่สอง: แจ้ง `TipKub health alert` หนึ่งครั้ง
- ล้มเหลวต่อเนื่องต่อไป: ไม่ส่งซ้ำทุก 5 นาที
- กลับมาใช้งานได้: แจ้ง `TipKub recovered` หนึ่งครั้ง
- สถานะที่ใช้กันแจ้งซ้ำเก็บใน `.uptime-monitor-state.json` ผ่าน GitHub Actions cache เท่านั้น ไม่มีข้อมูลผู้ใช้ การบริจาค หรือข้อมูลชำระเงิน

## ขอบเขตและข้อจำกัด

`/health` เป็น liveness check: ตรวจว่าเว็บตอบ HTTP 200 และ JSON มี `status: "ok"` เท่านั้น ยังไม่ตรวจ Turso, R2 หรือ SlipOK เพราะการตรวจทุก 5 นาทีไม่ควรเพิ่ม dependency load โดยไม่จำเป็น

GitHub Actions schedule เป็น best-effort และอาจล่าช้าได้เล็กน้อย จึงเหมาะกับการแจ้งเตือน outage ทั่วไป ไม่ใช่ SLA แบบวินาทีต่อวินาที หากต้องการ latency ต่ำกว่านี้ภายหลังค่อยเปลี่ยนเป็น managed uptime monitor โดยไม่ต้องแก้แอป

ห้ามใส่ Webhook URL ใน source code, issue, log หรือไฟล์ `.env` ที่ commit เข้า Git และควร rotate Webhook ทันทีหาก URL รั่ว
