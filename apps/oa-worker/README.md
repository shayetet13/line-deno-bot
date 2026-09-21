# apps/oa-worker (Go) — stub

LINE OA connector (Messaging API). **ยังไม่ scaffold** — เริ่มเมื่อ Phase 0 ยืนยันว่ามีช่องทาง OA

ขอบเขต:

- webhook receiver + HMAC signature verification per shop
- reply / push ตามบริบท
- idempotent processing, dead-letter queue

แยกจาก selfbot worker: OA ใช้ channel credentials, selfbot ใช้ QR/challenge session — **ไม่ใช้แทนกัน**
