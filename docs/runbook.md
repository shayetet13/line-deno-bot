# Operations runbook

คู่มือหน้างานสำหรับ `line-first-response` — Phase 11 deliverable ตาม Phases §19

> **สิ่งที่ต้องรู้ก่อนแตะอะไร:** การ login มี 2 ชุดที่แยกขาดกัน: `.control/users.json` คือบัญชีผู้ใช้งานระบบ ส่วน
> `.sessions/<botId>.json` และ `.sessions/<botId>.linejs.json` คือ credential ของ LINE bot แต่ละตัว
> ไม่ใช่ cache. ห้าม commit ห้าม log ห้ามใส่ credential ลงใน release directory (`release.sh` symlink
> เข้ามา)
>
> **ห้ามรัน worker ที่ local กับที่ server พร้อมกันด้วยบัญชีเดียวกัน** — LINE อาจตัด session ทิ้ง (Playbook §9.2)

---

## 1. ดูสถานะระบบ

Worker แต่ละตัว bind loopback port ของตัวเองเท่านั้น (Playbook §14.3: shard port ห้ามออก public). `bot-1`
ใช้ 8791 ได้ แต่ bot อื่นต้องมี port คนละหมายเลขใน `.control/instances/<bot-id>.env`. มีสองชั้น login:

1. **ผู้ใช้งานระบบ** — เข้า `/account/login` ด้วยบัญชีของคน เพื่อยืนยันตัวตนและสิทธิ์
2. **LINE bot** — เข้า `/login` หรือ `/app` หลังจาก user login แล้ว เพื่อเชื่อม LINE account ของ bot ตัวนั้น

การ login ของคนไม่สร้างหรือเปลี่ยน LINE session และการ login ของ bot ไม่สร้างหรือเปลี่ยน web account

**1 bot = 1 worker process** แต่ละ instance มี LINE account, ไฟล์กฎ, รายการห้อง, QR login, event loop
และ console account ของตัวเอง. จึงไม่มี reconnect, GC หรือ log burst ของ bot หนึ่งตัวมาทำให้ bot อื่นช้า. ห้ามใช้
`--multi-bot` กับ worker ที่แข่ง latency.

- สร้าง bot ก่อนเริ่ม service เสมอ: ใช้ `deno task provision-bot --name <slug>` สำหรับ local หรือสร้าง
  `config/bots/<bot-id>.json` แล้วใช้ `enable-bot-instance.sh` สำหรับ production. การเพิ่ม user ใน
  console ของ bot หนึ่ง **ไม่** สร้างหรือให้สิทธิ์เข้าถึง bot อื่น
- ปุ่ม restart / logout / QR ของคนหนึ่ง reconnect เฉพาะ bot ของคนนั้น ไม่ exit ทั้ง process และไม่กระทบคนอื่น
- ลบผู้ใช้ปิดเฉพาะ console account ของ worker นั้น; config และ LINE session ไม่ถูกลบอัตโนมัติ
- `/api/health` และ deploy health check ตรวจทุก `lfr-worker@*.service` ที่ active
- แต่ละ bot เปิด lane/connection ไปหา LINE ของตัวเอง (`lanes` ตาม template) — ผู้ใช้เยอะ = connection เยอะ
  ดู CPU/FD ก่อนเพิ่มคน

`--multi-bot` และ `--primary-owner` เป็น compatibility mode สำหรับ shared process เก่าเท่านั้น; ไม่ใช้ใน
`lfr-worker@<bot-id>.service` และไม่ควรใช้กับงานที่แข่ง latency.

หลังจากนั้นมีสองทางเข้า:

### ทางที่ 1 — public ผ่าน nginx (มี password)

`deploy/nginx-dashboard.conf` ตั้ง nginx เป็น reverse proxy ตัวเดียวที่เผชิญอินเทอร์เน็ต —
`0.0.0.0:80 → 127.0.0.1:8791` พร้อม HTTP Basic Auth (`/etc/nginx/.htpasswd`) worker เองไม่รู้เรื่องนี้ เลย
ยัง bind loopback เหมือนเดิม

```
http://<host-ip>/          -- ต้อง login (username/password ดูใน memory หรือถามคนตั้ง)
```

**ข้อจำกัดที่ต้องรู้:** เป็น **HTTP ธรรมดา ไม่มี TLS** เพราะมีแค่ IP ไม่มีโดเมน — username/password วิ่งเป็น
cleartext บนสาย ถ้ามีโดเมนแล้วค่อยเพิ่ม TLS (certbot) ทีหลัง ตอนนี้ถือว่า "กันคนเดินผ่านเห็น" ไม่ใช่ "กัน attacker ที่ดัก
traffic ได้"

เปลี่ยนรหัสผ่าน: `htpasswd /etc/nginx/.htpasswd lfr` บน server แล้ว `systemctl reload nginx`

### ทางที่ 2 — SSH tunnel (ไม่ต้องพึ่ง nginx)

```bash
ssh -L 8791:127.0.0.1:8791 root@<host>
# แล้วเปิด http://localhost:8791/
```

บนเครื่อง Windows: ดับเบิลคลิก `start.bat` แล้วเลือกข้อ 1 (ต่อ tunnel + เปิดเบราว์เซอร์ให้)

> `start.bat` เป็น shim ASCII ล้วนที่เรียก `start.ps1` — **ห้ามใส่ข้อความที่ไม่ใช่ ASCII ลงใน .bat** cmd.exe
> parse ไฟล์ .bat ตาม byte offset พอเจอ UTF-8 หลายไบต์ (ภาษาไทย) parser จะหลุด แล้วไปรัน เศษกลางบรรทัดแทน
> UI ทั้งหมดจึงอยู่ใน `.ps1` ซึ่งต้องมี UTF-8 BOM ด้วย ไม่งั้น PowerShell 5.1 จะอ่านเป็น ANSI
>
> ค่า host/port/รหัสผ่านอยู่ใน `start.local.ps1` (gitignored)

| endpoint      | ใช้ตอนไหน                                                           |
| ------------- | ------------------------------------------------------------------ |
| `/`           | dashboard — lane badge, readiness, span, race                      |
| `/api/health` | **200 เฉพาะตอน ARMED** / 503 ตอนอื่น — ตัวนี้คือ health check ของ deploy |
| `/api/status` | snapshot ดิบทั้งก้อน + release manifest                                |
| `/api/alerts` | alert ที่กำลัง firing + ที่กำลังนับเวลาอยู่ (`pending`)                     |

`/api/health` เป็น 200 ก็ต่อเมื่อ readiness = ARMED ครบทั้ง 5 เงื่อนไข (session, receiver, rules, sender,
backlog) — process ขึ้นแต่ยังไม่ ARMED **ไม่นับว่า deploy สำเร็จ**

---

## 2. รัน worker แยก instance

```bash
# ย้ายจาก legacy service ครั้งเดียว (ห้ามให้สอง service ใช้ LINE session เดียวกัน)
systemctl stop --now lfr-worker.service

# สร้าง/เริ่มหนึ่ง service ต่อ bot; port ต้องไม่ซ้ำกัน
bash deploy/enable-bot-instance.sh bot-1 8791
bash deploy/enable-bot-instance.sh shop-b 8792

systemctl restart lfr-worker@bot-1.service
journalctl -u lfr-worker@bot-1.service -f -o cat
```

`enable-bot-instance.sh` เก็บ port ไว้ที่ `.control/instances/<bot-id>.env`, เก็บ console users แยกที่
`.control/bot-users/<bot-id>.json` และใช้ session ของ bot นั้นเท่านั้น. หลัง deploy, `release.sh` restart
และ health-check ทุก template instance ที่ active.

รันมือเพื่อ debug:

```bash
cd /opt/line-first-response
deno task serve --config config/bots/bot-1.json --port 8791
deno task serve --help
```

### DRY RUN กับ LIVE

`config/bots/<bot>.json` มี key `dryRun`:

| ค่า                  | พฤติกรรม                                                         |
| ------------------- | --------------------------------------------------------------- |
| `true` (หรือไม่มี key) | เดินครบทั้ง pipeline — dedupe, allowlist, กฎ, trace — แต่**ไม่โพสต์** |
| `false`             | **โพสต์ลงห้องจริง**                                                |

ไม่มี key = dry run โดยตั้งใจ บอทที่โพสต์เพราะคนลืม flag แย่กว่าบอทที่เงียบ

สลับโหมด: แก้ไฟล์แล้ว `systemctl restart lfr-worker` (หรือใช้ `start.bat` เมนูข้อ 3 — โหมด LIVE ต้องพิมพ์
`LIVE` ยืนยันอีกชั้น) ยืนยันจาก log บรรทัด `mode :` ตอนเริ่ม และจาก `"dryRun"` ใน log `worker armed`

### แก้กฎ / ห้อง / allowlist

ทั้งหมดอยู่ในไฟล์ config เดียวกัน ไม่ต้อง deploy ใหม่ แค่แก้แล้ว restart config ผิดจะ**ไม่ start**
และบอกทุกจุดที่ผิดพร้อมกัน:

```
worker failed: invalid bot config (config/bots/bot-1.json):
- ownerId: expected a non-empty string
- rules: expected an array
```

`allowedSenders`: ไม่ใส่ key หรือใส่ `null` = ใครก็ได้; `[]` = ปิดสนิท; `["p123…"]` = เฉพาะ id นั้น **จับที่ ID
เท่านั้น ไม่ดู display name** (ADR-0007)

---

## 3. Deploy

```bash
deploy/release.sh <git-ref>     # deploy commit นั้น
deploy/release.sh --status      # ดูว่าอะไรอยู่ live
deploy/release.sh --rollback    # ย้อนกลับ release ก่อนหน้า
```

สคริปต์ทำตาม Playbook §16 ครบสิบข้อ จุดที่ต้องเข้าใจ:

- **build เข้า directory ใหม่** — release ที่ live อยู่ไม่ถูกแตะจนกว่าจะถึงจุด swap
- **`deno task gate` + `deno task acceptance` รันก่อน swap** — พังตรงนี้แปลว่าไม่มีอะไรเปลี่ยนเลย
- **symlink swap คือ commit point** — `ln -sfn` ลงชื่อชั่วคราวแล้ว `mv -Tf` ไม่มีช่วงที่ `current` หายไป
- **health check ไม่ผ่าน = ย้อนทั้ง transaction อัตโนมัติ** แล้ว exit non-zero
- **เก็บ 5 release ล่าสุด** (`KEEP_RELEASES`) เพื่อให้ rollback มีที่ให้ไป

สคริปต์ปฏิเสธ deploy จาก working tree ที่แก้ค้าง และปฏิเสธ ref ที่ไม่ resolve เป็น commit hash — build ที่
ทำซ้ำไม่ได้ก็ rollback ไปหาไม่ได้

### หลัง deploy: ตั้ง baseline ใหม่

alert เรื่อง first-response regression เทียบกับ baseline ของ release นั้น ๆ ถ้า release ใหม่นิ่งแล้วให้
`setBaseline({ sendP95Ms, releaseLabel })` ไม่งั้นจะเทียบกับตัวเลขของโค้ดชุดเก่าไปเรื่อย ๆ

---

## 4. Alert แต่ละตัวหมายถึงอะไร

ทุก rule ต้อง "จริงต่อเนื่อง" ถึงจะยิง (ค่าตั้งต้น 60s, readiness 30s) — spike เดียวไม่ใช่ alert โดยตั้งใจ

| alert                       | แปลว่า                                    | ดูต่อที่ไหน                                |
| --------------------------- | ---------------------------------------- | -------------------------------------- |
| `readiness-loss`            | ไม่ ARMED นานเกิน 30s                      | `/api/status` → `readiness.reason`     |
| `no-lane-available`         | ไม่มี lane ที่ route ได้เลย                   | `/api/status` → `lanes[].badge`        |
| `failure-rate`              | send ล้มเกิน 5% (critical เมื่อเกิน 20%)      | log `send failed` + `class`            |
| `first-response-regression` | p95 เกิน baseline × 1.5                   | เทียบ `release` ใน snapshot กับ baseline |
| `missed-events`             | receive path หนึ่งไม่ชนะเลย — น่าจะตายเงียบ ๆ | `/api/status` → `race.wins`            |

`missed-events` ปิดอยู่ถ้า `racedSources < 2` — path เดียวชนะทุกอันคือพฤติกรรมถูกต้อง ไม่ใช่ปัญหา

---

## 5. Recovery ladder

**อย่า restart worker เป็นอย่างแรก** ลำดับตาม Playbook §16 และตาม `RecoveryPlanner`:

```
เลี่ยง lane ช้า
  → reconnect lane เดียว
    → rearm room poll
      → reconnect session ของ bot เดียว
        → restart worker  (เมื่อ state ภายในเสียจริงเท่านั้น)
```

แต่ละขั้นได้เวลาพิสูจน์ตัวเอง (ค่าตั้งต้น 120s) ก่อนจะขึ้นขั้นถัดไป และต้องสะอาดติดกัน 3 ครั้งถึงจะถือว่าหาย

ทำมือ:

| ขั้น                | คำสั่ง                                                          |
| ----------------- | ------------------------------------------------------------- |
| ดู lane            | `curl -s localhost:8791/api/status \| jq '.lanes'`            |
| reconnect session | restart service — ยังไม่มี endpoint แยก (รวมกับ worker main loop) |
| restart worker    | `systemctl restart lfr-worker`                                |
| ย้อน release       | `deploy/release.sh --rollback`                                |

---

## 6. แก้กฎ / re-auth session ผ่านเบราว์เซอร์

Console มีสองหน้าที่ "เขียน" ได้ — ต่างจาก `/` ที่อ่านอย่างเดียว ทั้งคู่อยู่หลัง nginx basic auth เดียวกัน

### `/rules` — แก้คีย์เวิร์ด/คำตอบ

เพิ่ม/แก้/ลบกฎได้จากหน้านี้ตรง ๆ **apply กับ pipeline ที่กำลังรับงานจริงทันที ไม่ restart worker** — เขียนไฟล์
`config/bots/<bot>.json` (validate ผ่านตัวเดียวกับที่ worker ใช้ตอน boot) แล้ว hot-swap rule set
ในหน่วยความจำ กฎผิด (id ซ้ำ, pattern ว่าง ฯลฯ) จะถูกปฏิเสธพร้อมบอกจุดผิด ไม่ถูกเขียนลงไฟล์เลย

### `/login` — login ของ LINE bot ด้วย QR ผ่านเบราว์เซอร์

หน้านี้เป็น login ของ LINE bot เท่านั้น ไม่ใช่ login ของผู้ใช้งานระบบ ใช้แทน SSH+terminal เมื่อ session
เดิมหมดอายุหรือถูกปฏิเสธ **ไม่ใช่การตั้งบอทใหม่ตั้งแต่ต้น** — บอทที่ยัง ไม่เคย login เลยต้องใช้ CLI ก่อน เพราะยังไม่มี
worker รันให้เปิดหน้านี้:

```bash
cd /opt/line-first-response/current
deno task login --bot-id bot-1 --method qr
```

หน้า `/login` โชว์ QR เป็นรูปจริง (เข้ารหัสฝั่ง server ไม่พึ่ง CDN ภายนอก) ให้เวลาประมาณ 150 วินาที
เข้าสู่ระบบสำเร็จแล้ว **ต้องกด "Restart worker ตอนนี้"** ถึงจะใช้ session ใหม่จริง — login ผ่านหน้านี้ บันทึก session
ใหม่ลงไฟล์ แต่ไม่ได้สลับ connection ของ worker ที่รันอยู่ให้อัตโนมัติ (เหมือนขั้น `reconnect-session` ใน recovery
ladder ข้อ 5) ปุ่ม restart สั่ง exit ตัวเอง แล้วให้ systemd (`Restart=always`) ดึงกลับมาพร้อม session ใหม่

ถ้าเจอ `410 Gone` แปลว่าหน้าต่าง pairing หมดเวลา ไม่ใช่ credential ผิด — เริ่มใหม่แล้วสแกนให้เร็วขึ้น

secret มาจาก environment variable เท่านั้น (`LINE_EMAIL`, `LINE_PASSWORD`, `LINE_PINCODE`,
`LINE_AUTH_TOKEN`) **ห้ามส่งผ่าน CLI flag** — flag โผล่ใน `ps` และใน shell history

### การแยกไฟล์ credential

- `.control/users.json`: บัญชีคนและ HMAC secret สำหรับ web session ใช้ร่วมกันได้ทุก bot worker บนเครื่องเดียวกัน
- `.sessions/<botId>.json`: auth/refresh token ของ LINE bot ตาม `botId`
- `.sessions/<botId>.linejs.json`: storage ภายในของ LINEJS ตาม `botId`

หากมีหลาย bot ห้าม copy ไฟล์ session ข้าม bot และห้ามวาง user account ไว้ใน `.sessions` การรัน worker รองรับ
`--users-file` หากต้องการระบุที่เก็บบัญชีคนเอง; ค่าเริ่มต้นคือ `.control/users.json`

---

## 7. Database

- SQLite + WAL, migration แบบมี version — รันเองตอน start
- **backup ต้องใช้วิธีที่รองรับ live database** (`sqlite3 .backup` หรือ `VACUUM INTO`) ห้าม `cp` ไฟล์ตรง ๆ ตอน
  WAL ยัง active
- **ทดสอบ restore ด้วย** backup ที่ไม่เคย restore คือ backup ที่ไม่รู้ว่ามีจริงไหม
- retention: raw event เก็บ 7 วัน, rollup รายชั่วโมงเก็บถาวร (`persistence/retention.ts`)
- raw row จะถูกลบ **ก็ต่อเมื่อมี rollup ครอบแล้ว** — prune คือการบีบอัด ไม่ใช่การทำลาย

---

## 8. เปลี่ยน region / connection strategy

เปลี่ยนจากข้อมูล ไม่ใช่เปลี่ยนทุกครั้งที่ ping แกว่ง (Phases §19) ตัวเลขอ้างอิงปัจจุบัน:

- RTT จาก Tokyo host ไป `legy.line-apps.com` = **0.37ms**
- lane-level HTTP RTT = **7.6ms** แต่ full send RTT = **~30ms** → ส่วนต่าง ~22ms คือ thrift encode/parse
  ใน TypeScript ไม่ใช่ปัญหา network → **ย้าย region แก้ตรงนี้ไม่ได้** ดู experiment `native-encode-relay` ใน
  `docs/experiments.md`

---

## 9. ก่อนอัปเดต LINEJS หรือ protocol

`vendor/linejs` pin ไว้ที่ `ef6c3d9` (v3.4.2) เป็น git submodule

1. อัปเดตใน branch แยก
2. `deno task gate` + `deno task acceptance`
3. ทดสอบใน **ห้องทดสอบ** ก่อน — ไม่ใช่ห้องงาน
4. ค่อย deploy พร้อมดู `first-response-regression` เทียบ baseline เก่า

`assertDeployable()` จะปฏิเสธถ้า dependency ไหน pin เป็น `latest` หรือ `main`
