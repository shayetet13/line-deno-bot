# line-first-response

LINE bot ที่ออกแบบให้ **ชนะด้วยคำตอบแรก** ของแต่ละงาน — รับคีย์เร็ว ตรวจถูก ส่งถึงจุดตัดสินก่อนคู่แข่ง

แนวทางที่ยึด: [`LINE-BOT-APPROACH-DECISION-TH.md`](./LINE-BOT-APPROACH-DECISION-TH.md) (ผสม
`LINE-BOT-LATENCY-PLAYBOOK.md` = ฐานเทคนิคที่พิสูจน์แล้ว +
`LINE-First-Response-Architecture-and-Phases-TH.md` = กระบวนการ/กติกา)

## Stack

| ส่วน                 | เครื่องมือ                                        | บทบาท                                                                 |
| ------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| Selfbot worker      | **Deno 2.9** + TypeScript + LINEJS (submodule) | hot path: receive → verify → match → send                             |
| Control service     | Go (`net/http`)                                | auth, users, ownership, supervisor, metrics — **ไม่อยู่ระหว่างคีย์กับคำตอบ** |
| OA worker           | Go                                             | LINE Messaging API                                                    |
| Frontend            | React + TypeScript                             | admin dashboard + user mobile UI                                      |
| Storage             | SQLite (WAL)                                   | config, session metadata, metrics rollups                             |
| Process supervision | systemd (Linux)                                | restart/resource แยกต่อบัญชี                                             |

Runtime เป็น Deno เพราะ LINEJS เป็น Deno-first — ดู [ADR-0005](./docs/decisions.md)

### Isolated worker budget

หนึ่ง bot ต้องมี worker process ของตัวเอง: `lanes: 6`, `sendReservedLanes: 2`, `sendSpareLanes: 1` (reply
หลัก 1, reply spare 1, poll 4). จึงไม่มี event loop, GC, reconnect หรือ log burst ของ bot หนึ่งตัวมาหยุดอีก
ตัว. สำหรับ 20 bot จะเป็น 20 worker + อย่างน้อย 140 LINE H2 connections (6 reply lanes + 1 PUSH ต่อ bot).
`CONNECTION_WARMUP_CONCURRENCY=2` จำกัดเฉพาะ reconnect ภายใน worker เดียว; ไม่ใช่ send queue และไม่มีผลต่อ
การส่งข้อความระหว่างแข่ง. Dashboard/alert ใช้ target p95 ของ LINE trigger→reply ที่ 30ms.

## Workspace layout

```
apps/
  worker/
    src/
      adapters/     # connector seam: types, mock, linejs/
      core/         # Phase 1 correctness core (connector-agnostic)
      pipeline/     # event -> core -> sender
      session/      # credential persistence
      cli/          # login + probe
      config/ errors/ lib/ logging/
    test/
  control/          # Go control API + supervisor        (stub)
  oa-worker/        # Go OA connector                     (stub)
packages/
  contracts/        # branded ids, surfaces, job states
vendor/
  linejs/           # git submodule @ ef6c3d9 (v3.4.2)
docs/
```

## เริ่มใช้งาน

```bash
git submodule update --init --recursive
deno task check          # type-check
deno task test           # unit tests + coverage
deno task gate           # fmt:check + lint + check + test + coverage
```

### Login บัญชี LINE (Phase 1b)

```bash
# QR: เปิด URL ที่พิมพ์ออกมา แล้วยืนยันในแอป LINE ของบัญชีนั้น
deno task login --bot-id bot-1 --method qr

# email + password (ใส่ PIN ที่ขึ้นบนหน้าจอลงในแอป)
LINE_EMAIL=... LINE_PASSWORD=... deno task login --bot-id bot-1 --method password

# มี auth token อยู่แล้ว
LINE_AUTH_TOKEN=... deno task login --bot-id bot-1 --method token

deno task login --help
```

### Probe: ดูว่า connector ส่งอะไรมาจริง (Phase 1b)

```bash
deno task probe --bot-id bot-1 --seconds 60      # หยุดเองใน 60 วิ
deno task probe --bot-id bot-1                   # รันจนกด Ctrl+C
deno task probe --bot-id bot-1 --show-text       # โชว์เนื้อข้อความ (ปิดไว้เป็นค่าเริ่มต้น)
deno task probe --bot-id bot-1 --no-talk         # ฟังเฉพาะ OpenChat
```

พิมพ์ trace ต่อ event (`surface`, `msg`, `room`, `from`, `len`, `inbound`) แล้วสรุป p50/p95 ตอนจบ — id
ถูกย่อและเนื้อข้อความไม่แสดง เว้นแต่สั่ง `--show-text`

การ login ถูกแยกเป็นคนละส่วนโดยตั้งใจ:

- บัญชีผู้ใช้งานระบบอยู่ที่ `.control/users.json` — ใช้สำหรับยืนยันตัวคนและสิทธิ์เท่านั้น
- credential ของ LINE bot อยู่ที่ `.sessions/<botId>.json` + `.sessions/<botId>.linejs.json` — แยกตาม
  bot

สองส่วนนี้ไม่ใช้ credential ร่วมกัน และการ login ของ bot หนึ่งตัวไม่ทำให้ user หรือ bot ตัวอื่น login ตาม
`.gitignore` กันไฟล์ credential ไว้แล้ว ห้าม commit / ห้าม log

**การแยก bot:** `deno task serve --config …` ทำงานเฉพาะ bot ใน config นั้นโดยค่าเริ่มต้น และไม่สร้าง/เปิด bot
อื่น. Production ใช้ `lfr-worker@<bot-id>.service` หนึ่ง unit ต่อ bot; session, config, console account
และ restart แยกกันหมด. `--multi-bot` มีไว้รองรับระบบเก่าเท่านั้นและห้ามใช้กับ worker ที่แข่ง latency.

## สถานะปัจจุบัน

| Phase                 | สถานะ                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 — นิยามสนามแข่ง | 🚧 field `TODO` รอข้อมูล workload จริง                                                                                                            |
| Phase 1–11            | ✅ correctness, connector proof, measurement, owned lanes, inbound race, readiness, isolation, observability, acceptance และ production core   |
| งานที่เหลือ              | Go control plane/OAuth callback, config-generation ACK loop และ recovery hooks ที่รัน action จริง — ดู [`docs/phase-plan.md`](./docs/phase-plan.md) |

ล่าสุด: `deno task gate` ผ่าน (format, lint, type-check, unit/acceptance tests และ coverage)

## Quality Gate (ต่อ phase)

ทุก phase ต้องผ่านก่อนไป phase ถัดไป (`CLAUDE .md` §11): `deno task gate` เขียว → code + security review →
docs อัปเดต → ปิด phase

Rule เชิงโครงสร้างที่ `deno lint` ไม่ครอบ (ฟังก์ชัน ≤20 บรรทัด, ไฟล์ ≤400/800, ห้าม raw `new Error`,
max-depth 4) เป็น **review checklist** — ดู [ADR-0006](./docs/decisions.md)
