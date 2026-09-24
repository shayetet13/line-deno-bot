# Operations runbook

คู่มือหน้างานสำหรับ `line-first-response` — Phase 11 deliverable ตาม Phases §19

> **สิ่งที่ต้องรู้ก่อนแตะอะไร:** การ login มี 2 ชุดที่แยกขาดกัน: `.control/users.json` คือบัญชีผู้ใช้งานระบบ ส่วน
> `.sessions/<botId>.json` และ `.sessions/<botId>.linejs.json` คือ credential ของ LINE bot แต่ละตัว
> ไม่ใช่ cache. ห้าม commit ห้าม log ห้ามใส่ credential ลงใน release directory (`release.sh` symlink
> เข้ามา)
>
> ระบบใช้งานบน VPS เท่านั้น: ห้ามนำไฟล์ session ไปเปิดด้วย worker เครื่องอื่น เพราะ LINE อาจตัด session ทิ้ง
> (Playbook §9.2)

---

## 1. ดูสถานะระบบ

VPS เปิด public console หนึ่ง URL ผ่าน nginx (`0.0.0.0:80 → 127.0.0.1:8791`) และ worker bind loopback
เท่านั้น. มีสองชั้น login:

1. **ผู้ใช้งานระบบ** — เข้า `/account/login` ด้วยบัญชีของคน เพื่อยืนยันตัวตนและสิทธิ์
2. **LINE bot** — เข้า `/login` หรือ `/app` หลังจาก user login แล้ว เพื่อเชื่อม LINE account ของ bot ตัวนั้น

การ login ของคนไม่สร้างหรือเปลี่ยน LINE session และการ login ของ bot ไม่สร้างหรือเปลี่ยน web account

`lfr-worker.service` ต้องรัน `--multi-bot` เสมอ. เมื่อ admin สร้าง user แล้ว user นั้นเข้าเว็บครั้งแรก ระบบจะ
สร้าง `botId`/config ของคนนั้นและผูกไว้ถาวร. ทุก route หลัง login resolve ผ่าน user นี้ จึงไม่สามารถอ่านหรือแก้
LINE session, กฎ, ห้อง หรือ QR ของ user คนอื่นได้.

- admin คนแรกเป็นเจ้าของ `bot-1` เดิม เพื่อรักษา session ที่มีอยู่
- user คนถัดไปได้ bot ใหม่ของตนเอง; ห้ามใช้ username เดียวกันร่วมกัน เพราะเป็นเจ้าของ bot เดียวกันโดยเจตนา
- QR scan, logout และ recovery reconnect เฉพาะ BotHost นั้นโดยอัตโนมัติ ไม่ restart service
- ลบ user ปิด BotHost ของคนนั้น แต่ไม่ลบ config หรือ LINE session อัตโนมัติ

### Public ผ่าน nginx

`deploy/nginx-dashboard.conf` ตั้ง nginx เป็น reverse proxy ตัวเดียวที่เผชิญอินเทอร์เน็ต —
`0.0.0.0:80 → 127.0.0.1:8791`. การยืนยันตัวตนทำใน worker ที่ `/account/login`; ไม่มี nginx Basic Auth

```
http://<host-ip>/account/login
```

**ข้อจำกัดที่ต้องรู้:** เป็น **HTTP ธรรมดา ไม่มี TLS** เพราะมีแค่ IP ไม่มีโดเมน — username/password วิ่งเป็น
cleartext บนสาย ถ้ามีโดเมนแล้วค่อยเพิ่ม TLS (certbot) ทีหลัง ตอนนี้ถือว่า "กันคนเดินผ่านเห็น" ไม่ใช่ "กัน attacker ที่ดัก
traffic ได้"

| endpoint      | ใช้ตอนไหน                                                           |
| ------------- | ------------------------------------------------------------------ |
| `/`           | dashboard — lane badge, readiness, span, race                      |
| `/api/health` | **200 เฉพาะตอน ARMED** / 503 ตอนอื่น — ตัวนี้คือ health check ของ deploy |
| `/api/status` | snapshot ดิบทั้งก้อน + release manifest                                |
| `/api/alerts` | alert ที่กำลัง firing + ที่กำลังนับเวลาอยู่ (`pending`)                     |

`/api/health` เป็น 200 ก็ต่อเมื่อ bot หลัก ARMED ครบทั้ง 5 เงื่อนไข (session, receiver, rules, sender,
backlog). deploy ตรวจ `/account/login` ว่า public console เปิดอยู่แทน เพื่อให้ VPS ใหม่ที่รอสแกน QR ครั้งแรก
deploy ได้สำเร็จ.

---

## 2. รัน VPS multi-user service

```bash
# หลังติดตั้ง/อัปเดต unit file
install -m 0644 deploy/lfr-worker.service /etc/systemd/system/lfr-worker.service
systemctl daemon-reload
systemctl enable --now lfr-worker.service
journalctl -u lfr-worker.service -f -o cat
```

service เดียวใช้ `.control/users.json` เป็นทะเบียนคน และ `.sessions/<botId>.json` เป็น credential ของ
LINE แยกตาม bot. อย่าเปิด `lfr-worker@*.service` ควบคู่ เพราะมันใช้ topology คนละแบบกับ public multi-user
console.

รันมือเพื่อ debug:

```bash
cd /opt/line-first-response
deno task serve --config config/bots/bot-1.json --sessions-dir .sessions --users-file .control/users.json --multi-bot --port 8791
deno task serve --help
```

### DRY RUN กับ LIVE

`config/bots/<bot>.json` มี key `dryRun`:

| ค่า                  | พฤติกรรม                                                         |
| ------------------- | --------------------------------------------------------------- |
| `true` (หรือไม่มี key) | เดินครบทั้ง pipeline — dedupe, allowlist, กฎ, trace — แต่**ไม่โพสต์** |
| `false`             | **โพสต์ลงห้องจริง**                                                |

ไม่มี key = dry run โดยตั้งใจ บอทที่โพสต์เพราะคนลืม flag แย่กว่าบอทที่เงียบ

สลับโหมด: แก้ไฟล์ config ของ bot นั้น แล้ว `systemctl restart lfr-worker`. ยืนยันจาก log บรรทัด `mode :`
ตอนเริ่ม และจาก `"dryRun"` ใน log `worker armed`

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

| alert                       | แปลว่า                                          | ดูต่อที่ไหน                                |
| --------------------------- | ---------------------------------------------- | -------------------------------------- |
| `readiness-loss`            | ไม่ ARMED นานเกิน 30s                            | `/api/status` → `readiness.reason`     |
| `no-lane-available`         | ไม่มี lane ที่ route ได้เลย                         | `/api/status` → `lanes[].badge`        |
| `failure-rate`              | send ล้มเกิน 5% (critical เมื่อเกิน 20%)            | log `send failed` + `class`            |
| `first-response-regression` | p95 เกิน baseline × 1.5                         | เทียบ `release` ใน snapshot กับ baseline |
| `missed-events`             | receive path หนึ่งไม่ชนะเลย — น่าจะตายเงียบ ๆ       | `/api/status` → `race.wins`            |
| `host-cpu-starved`          | event loop ของ thread ช้า p99 > 10ms — CPU ไม่พอ | `/api/status` → `host` · §10           |

`missed-events` ปิดอยู่ถ้า `racedSources < 2` — path เดียวชนะทุกอันคือพฤติกรรมถูกต้อง ไม่ใช่ปัญหา

`host-cpu-starved` ไม่เรียก recovery ladder โดยเจตนา: reconnect ใช้ CPU เพิ่ม ไม่ได้ลด — แก้ด้วยเพิ่ม core หรือ
`BOT_SHARDS` (§10)

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

Console ที่เขียนได้อยู่หลัง account login ของ worker

### `/rules` — แก้คีย์เวิร์ด/คำตอบ

เพิ่ม/แก้/ลบกฎได้จากหน้านี้ตรง ๆ **apply กับ pipeline ที่กำลังรับงานจริงทันที ไม่ restart worker** — เขียนไฟล์
`config/bots/<bot>.json` (validate ผ่านตัวเดียวกับที่ worker ใช้ตอน boot) แล้ว hot-swap rule set
ในหน่วยความจำ กฎผิด (id ซ้ำ, pattern ว่าง ฯลฯ) จะถูกปฏิเสธพร้อมบอกจุดผิด ไม่ถูกเขียนลงไฟล์เลย

### `/login` — login ของ LINE bot ด้วย QR ผ่านเบราว์เซอร์

หน้านี้เป็น login ของ LINE bot เท่านั้น ไม่ใช่ login ของผู้ใช้งานระบบ. user เปิด `/app` หลัง login แล้วสแกน QR ของ
bot ที่ผูกกับตัวเองได้ทันที — รวมถึง bot ที่ยังไม่เคย login มาก่อน. หน้า `/login` โชว์ QR เป็นรูปจริง (เข้ารหัสฝั่ง server
ไม่พึ่ง CDN ภายนอก) ให้เวลาประมาณ 150 วินาที. เมื่อสแกนสำเร็จ session ถูกบันทึกแล้ว `BotHost` จะ reconnect เฉพาะ
bot นั้นอัตโนมัติ; ไม่ต้องกด restart และไม่กระทบ user/bot คนอื่น

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
- sendMessage (Square) ต่ำสุดที่วัดได้ **18.8ms** และ `writeThrift` จริงแค่ ~0.06ms (`docs/experiments.md`
  `native-encode-relay`) → เวลาส่งเกือบทั้งหมดคือ **เวลาประมวลผลฝั่ง LINE** ไม่ใช่ network หรือโค้ดเรา — ย้าย
  region หรือเขียน encoder ใหม่ไม่ช่วย. สิ่งที่ช่วยได้คือเลือก connection ที่ LINE map ไป backend เร็ว (reply scout,
  ADR-0010) และ edge IP ที่เร็ว (`pin-legy-fast-ips.sh`, §10)

---

## 9. ก่อนอัปเดต LINEJS หรือ protocol

`vendor/linejs` pin ไว้ที่ `ef6c3d9` (v3.4.2) เป็น git submodule

1. อัปเดตใน branch แยก
2. `deno task gate` + `deno task acceptance`
3. ทดสอบใน **ห้องทดสอบ** ก่อน — ไม่ใช่ห้องงาน
4. ค่อย deploy พร้อมดู `first-response-regression` เทียบ baseline เก่า

`assertDeployable()` จะปฏิเสธถ้า dependency ไหน pin เป็น `latest` หรือ `main`

---

## 10. รองรับ bot 20 ตัวพร้อมกันโดยไม่กระโดด

### ตัวเลขที่ลดได้ และที่ลดไม่ได้

| ค่าบน dashboard        | ส่วนที่เป็นของ LINE                          | ส่วนที่เราลดได้                                                               |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| SEND RPC (~19ms)      | ~18.5ms ประมวลผล sendMessage (ต่ำสุด 18.8) | หาง p95 — lane/connection ที่ช้า, CPU ไม่พอ                                   |
| LINE→เรา (~13ms)      | เวลาก่อน LINE เปิดให้เห็นข้อความ              | ช่วงที่ poll ยังมองไม่เห็น: `squarePollStagger: 2` ลดได้ ~2–3ms แลกกับ request ×2 |
| TRIGGER→REPLY (~25ms) | ผลรวมสองบรรทัดบนตามนาฬิกา LINE             | ผลรวมของสองช่องบน                                                          |

**ต่ำกว่า ~18ms ต่อการส่งเป็นไปไม่ได้ เพราะเป็นเวลาของ LINE เอง.** เป้าที่ทำได้จริงคือ "ทุกครั้งอยู่ใกล้ค่าต่ำสุด": p95 ใกล้
p50 และไม่มีครั้งไหนกระโดด

### ขนาดเครื่อง

CPU ขึ้นกับจำนวน poll ต่อวินาที (`pollIntervalMs: 0` ≈ 84 ครั้ง/วินาที/ห้อง) ไม่ใช่จำนวนข้อความ. จาก simulator
(ADR-0011) บน core ที่เร็วกว่า Linode shared vCPU:

| bot × ห้องที่ poll | บน 2 vCPU (จำลอง, 2026-09-24)                                           | แนะนำ                                 |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| 20 × 1          | ✅ `BOT_SHARDS=1` (ค่าเริ่มบน 2 core): CPU ~50% ของ 1 core, ช้าเพิ่ม p95 +4ms | 2 vCPU พอ; 4 dedicated ถ้ามี nginx/อื่น ๆ |
| 20 × 2          | ⚠️ ต้อง `BOT_SHARDS=2`: p95 +4ms แต่ CPU ~100% ของ 1 core — เหลือที่ว่างน้อย   | 4 dedicated vCPU, `BOT_SHARDS=3`      |
| 20 × 4          | ❌ p95 +12–15ms, สูงสุด +20ms ทั้ง 1 และ 2 shard                            | 8 dedicated vCPU, `BOT_SHARDS=6–7`    |

ตัวเลขนี้วัดบน core ที่เร็วกว่า shared vCPU ของ Linode และยังไม่รวม nginx, PUSH sidecar, payload จริง
ของจริงจะแย่กว่า จึงควรเผื่อไว้อีกหนึ่งระดับ. บนเครื่อง 2 vCPU: **ให้ bot แต่ละตัว poll แค่ห้องที่แข่งจริง 1 ห้อง**
(`"slotBudget": 1` ใน `config/bots/bot-1.json` ซึ่งเป็น template ของ bot ใหม่ และใน config ของ bot
ที่มีอยู่แล้ว) และคง `squarePollStagger: 1` ห้องที่ไม่ได้ poll ยังตอบได้ผ่าน PUSH แต่ inbound ช้ากว่ามาก (~126ms เทียบ
~13ms) — ห้องที่ต้องชนะต้องอยู่ใน slot

**1 vCPU รับ 20 bot ไม่ได้โดยไม่กระโดด** ไม่ว่าจะจูนโค้ดแค่ไหน — ตอนจำลอง 20 process บน 1 core คำตอบช้าเพิ่มถึง
+180ms. ใช้ **Dedicated CPU** ไม่ใช่ Shared: shared vCPU มี steal time ซึ่งคือการกระโดดที่เราคุมไม่ได้

### ตั้งค่าและตรวจ

```bash
# ใน /opt/line-first-response/.env  (ไม่ใส่ = core − 1 อัตโนมัติ, 0 = ทุก bot บน thread เดียวแบบเดิม)
BOT_SHARDS=3

# ครั้งเดียวหลัง release: sysctl สำหรับ RPC สั้น + timer เลือก edge IP เร็วสุดทุกชั่วโมง + unit ใหม่
APP_ROOT=/opt/line-first-response bash /opt/line-first-response/current/deploy/enable-latency-tuning.sh
bash deploy/tune-network.sh --check          # AES-NI, TLS 1.3 + HTTP/2 ไป LINE, steal time
systemctl list-timers legy-fast-ip-pin.timer
curl -s localhost:8791/api/status | jq '.host'   # shard ของ bot นี้ + loop lag
```

log ตอนเริ่มต้องมี `isolation : multi-user bot routing across N bot shard thread(s)`

### อ่านอาการกระโดด

| send RPC | CPU loop lag (`/app`, dashboard) | แปลว่า                                 | ทำอะไร                                |
| -------- | -------------------------------- | ------------------------------------- | ------------------------------------- |
| กระโดด   | กระโดดพร้อมกัน                     | เครื่องเรา CPU ไม่พอ                     | เพิ่ม core / `BOT_SHARDS` / ลดห้องที่ poll |
| กระโดด   | นิ่ง (< 2ms)                       | route หรือ LINE — scout จะย้าย lane เอง | ดู log `reply lane pinned by scout`    |
| นิ่ง       | สูง                               | ยังไม่กระทบ แต่ใกล้เต็ม                    | วางแผนเพิ่ม core                        |

### Lane: ยึดเส้นเร็ว สลับเมื่อเจอเส้นที่เร็วกว่า (ADR-0010)

- `replyProbeIntervalMs` (config ของ bot, ค่าเริ่ม 1000) — scout วัด reply lane ทีละเส้น; `0` = ปิด
- dashboard: 📌🔭 = lane ที่ scout ปักไว้, คอลัมน์ preflight = ค่าที่ใช้จัดอันดับ
- log: `reply lane pinned by scout` (ย้ายเพราะเจอเส้นเร็วกว่า),
  `reply lane re-rolled onto a new connection` (เปิด connection ใหม่ให้เส้นที่ช้า — ทำระหว่างซ่อนจาก reply)
- config แนะนำ: `"lanes": 7, "sendReservedLanes": 3, "sendSpareLanes": 1` → reply 3 เส้นให้เลือก, poll
  4 เส้น

### Docker

ถ้ารันใน Docker บน Debian:

- ใช้ `network_mode: host` เท่านั้น — bridge network เพิ่ม NAT/veth/conntrack ในทุก packet
- sysctl ต้องตั้งที่ **host** (`tune-network.sh`) — container ใน host network แก้เองไม่ได้
- bind-mount `/etc/hosts:/etc/hosts:ro` ไม่งั้น container ใช้สำเนาตอน start และไม่เห็น pin ใหม่ —
  `pin-legy-fast-ips.sh` เขียนทับแบบคง inode เดิมไว้แล้ว bind mount จึงเห็นค่าใหม่ทันที
- `BOT_SHARDS` ใส่ใน env ของ container; อย่าจำกัด `cpus:` ต่ำกว่าจำนวน shard + 1
