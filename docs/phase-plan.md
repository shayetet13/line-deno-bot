# แผน Phase (canonical)

ยกมาจาก `LINE-BOT-APPROACH-DECISION-TH.md` §8 — ผสม roadmap ของ Playbook (เทคนิคพิสูจน์แล้ว) กับ Phases
(กระบวนการ)

ทุก phase ปิดด้วย `GATE: P<n>` = `deno task gate` เขียว + code/security review + docs อัปเดต
(`CLAUDE .md` §11)

| Phase  | ชื่อ                              | ที่มา                         | งานหลัก                                                                                                                                                                                        | สถานะ                            |
| ------ | ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **0**  | นิยามสนามแข่ง                     | Phases P0                   | นิยามผู้ชนะ + job identity contract + workload profile → `docs/phase-0-winner-definition.md`                                                                                                     | 🚧 โครงเสร็จ รอข้อมูลจริง            |
| **1**  | Correctness core                | Playbook §17 P1 + Phases P1 | message-id dedupe, exactly-once reply claim, owner/room claim, rule cache, rate limiter (drop ไม่ queue), timeout/AbortSignal, error classification, job identity + registry                   | ✅ GATE ผ่าน                      |
| **1b** | Connector proof                 | Phases P1                   | pin LINEJS + runtime, login/session flow, `client.listen()` Talk vs Square, push = notification-only?, นับ fetch/event, transport/HTTP2/ALPN, session recovery ไม่ทำงานเก่าเป็นงานใหม่             | 🚧 ดูตารางย่อยด้านล่าง               |
| **2**  | Measurement                     | Playbook §17 P2 + Phases §5 | 12 trace points, phase breakdown, p50/95/99 ring, per-lane stats, worker ID, source winner, เก็บ first-attempt เสมอ, วัด instrumentation overhead แยก — **เมตริกหลักต้องวัดบนนาฬิกาเดียว (ดูหัวข้อ 3b)** | 🚧 core เสร็จ + วัด baseline แล้ว   |
| **3**  | Warm transport                  | Playbook P3                 | shared HTTP client, keep-alive, TLS session ticket, startup readiness warm, TCP NoDelay, compact protocol                                                                                     | 🚧 infra เสร็จ + วัดแล้ว            |
| **4**  | Owned H2 lanes                  | Playbook P4 / §7            | lane lifecycle, GOAWAY draining, application RTT, sub-23 crossover, 0.10ms soft switch, background repair, age recycle, per-bot route key + cooldown                                          | 🚧 กลไกเสร็จ+เทสต์ · ดูข้างล่าง       |
| **5**  | Fast inbound race               | Playbook P5                 | dedicated room poll, startup drain, single cursor, slot budget, push/poll dedupe                                                                                                              | ✅ GATE ผ่าน · วัดแล้ว inbound ~ครึ่ง |
| **6**  | Warm scheduling + readiness FSM | Phases P5                   | readiness = subscription + sender + config + session/key; warm ตาม timezone/interval/count; yield to real jobs                                                                                | ✅ GATE ผ่าน                      |
| **7**  | Sharding + multi-user isolation | Playbook §14 + Phases P6    | owner-scoped worker, control-plane proxy, disjoint topology validation, WAL/write-behind, transactional deploy/rollback, LINE Login (auth code + PKCE) แยกจาก selfbot session                 | ✅ GATE ผ่าน (core)               |
| **8**  | UI / Observability              | Phases P7 + Playbook §13    | dashboard: HOT/COOL/WAIT จาก backend เดียว, sample age, worker ID, in-flight; score/history แยก live state; mobile-first                                                                       | ✅ GATE ผ่าน                      |
| **9**  | Advanced experiments            | Phases P8                   | receiver diversity → single sender, read-only fetch race, prepared request slot, CPU affinity/IRQ — เปิดทีละตัว มี hypothesis/baseline/rollback                                                   | ✅ GATE ผ่าน · registry + 7 นิยาม  |
| **10** | Acceptance                      | Phases P9                   | ตารางเคสการแข่งจริง (คีย์แรกหลัง idle, คีย์เดิม job ใหม่, ผู้ส่งนอก allowlist, ชื่อซ้ำคนละ ID, หลายกฎ, หลายงาน, reconnect+backlog, ACK timeout → UNKNOWN)                                                    | ✅ GATE ผ่าน · 12/12              |
| **11** | Production + monitoring         | Playbook §16 + Phases P10   | release pin versions/hash, rollout กลุ่มเล็ก, alert (missed events / first-response regression / readiness loss), recovery ladder                                                                | ✅ GATE ผ่าน · core               |

## Phase 1b — รายละเอียด

| งาน                                                               | สถานะ | หมายเหตุ                                                                                |
| ----------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| Pin LINEJS revision                                               | ✅    | submodule `vendor/linejs` @ `ef6c3d9` (v3.4.2)                                         |
| เลือก runtime + พิสูจน์ว่า LINEJS รันได้                                 | ✅    | Deno 2.9.6 — import สำเร็จ, `deno check` ผ่าน ([ADR-0005](./decisions.md))               |
| Adapter seam (`InboundEvent` / `InboundAdapter` / `Sender`)       | ✅    | `src/adapters/types.ts` — connector-agnostic                                           |
| Mock adapter + sender                                             | ✅    | `src/adapters/mock.ts` + tests                                                         |
| Session store (memory + file, chmod 600)                          | ✅    | `src/session/store.ts` + tests                                                         |
| Pipeline: event → core → sender                                   | ✅    | `src/pipeline/process-inbound.ts` + 8 tests                                            |
| Login (QR / password / authToken) + resume                        | ✅    | `src/adapters/linejs/login.ts` + `deno task login`                                     |
| **Login จริงกับบัญชี LINE**                                           | ✅    | สำเร็จ — session เก็บ authToken + refreshToken + expire, device DESKTOPWIN               |
| Session resume จาก stored token                                   | ✅    | probe รันจริง: `line session resumed` ไม่ต้อง login ซ้ำ                                     |
| Normalize `TalkMessage` / `SquareMessage` → `InboundEvent`        | ✅    | `adapters/linejs/normalize.ts` + 8 tests (Int64/string/bigint/`toNumber()` → epoch ms) |
| `LinejsInboundAdapter` (emitter → async iterable + startup drain) | ✅    | `inbound ready drainMs=1500` ยืนยันแล้ว; queue มี bound + นับ drop                          |
| `LinejsSender` (`sendCompactMessage` / `square.sendMessage`)      | ✅    | **ยิงจริงแล้ว 12/12 สำเร็จ** (Talk compact) — ดูผล send RTT ใน Phase 2                      |
| Capability probe CLI                                              | ✅    | `deno task probe` — resume + listen + summary (p50/p95 inbound) ทำงาน                  |
| **ยืนยันกับทราฟฟิกจริง**                                               | ✅    | Square event จริง — field map ถูก, push มี body, push ไม่ใช่ poll (ดูหัวข้อถัดไป)               |
| Clock skew estimator                                              | ✅    | `src/cli/clock-skew.ts` — วัดได้ `+1151ms` บน dev host                                   |
| วัดซ้ำหลาย sample ดู spread                                          | ✅    | jitter ≤ 8ms; absolute inbound วัดไม่ได้ที่ความละเอียด HTTP `Date` (ดูหัวข้อ 3b)                |
| Deploy + วัดบน Tokyo server                                        | ✅    | `172.237.14.170` — RTT ถึง LINE 0.4ms, chrony ±1.7ms, **inbound p50 126ms** (ดูท้ายไฟล์)   |
| Clock source ใช้ chrony ก่อน HTTP `Date`                            | ✅    | `clock-skew.ts` — HTTP `Date` ให้ `-416ms` ทั้งที่ chrony บอก 42µs (false alarm)            |

## Phase 1b — ผลที่ยืนยันกับทราฟฟิกจริงแล้ว

sample แรกจากห้อง Square จริง (ผู้ใช้พิมพ์ `"T"`):

```
[square] msg=63116518… room=mbfdcf56… from=pe52c46e… len=1 inbound=772ms text="T"
```

### 1. Square push มี body มาด้วย — แก้ข้อกังวล Phases §3.1

`client.listen()` emit `square:message` จาก `square:event` ที่ `type === 'NOTIFICATION_MESSAGE'` โดย
payload มี `squareMessage` ครบ **ไม่ต้อง `fetchMyEvents()` เพิ่มเพื่อเอาเนื้อข้อความ** (ยืนยันแล้ว: `text="T"`
มาพร้อม event) — ยังไม่ได้วัดว่ามี fetch ซ้อนอยู่ภายใน LINEJS หรือไม่ (Phase 2)

### 2. `client.listen()` ใช้ LEGY push ไม่ใช่ polling — แก้ข้อกังวล Phases §3.2

`_listenSquareEvents` / `_listenTalkEvents` ที่มี `await sleep(1000)` ถูกมาร์ค **`@deprecated`** และ
`client.listen()` **ไม่ได้เรียก** ตัวที่ถูกเรียกคือ:

```ts
listenSquareEvents(): ReadableStream<SquareEvent> {
  this.client.push.sqStream.renew();
  this.#startLegyPusher();   // push.initializeConn() + push.InitAndRead()
  return this.client.push.sqStream.stream;
}
```

→ เป็น push stream จริง (`base/push/h2_fetch.ts` = HTTP/2) ส่วน `sleep(4000)` ใน `initLegyPusher` เป็น
reconnect backoff ไม่ใช่หน่วงต่อข้อความ **เป้า inbound 11ms จึงไม่ถูกบล็อกด้วย poll interval**

### 3b. วัดซ้ำ 2 sample: **jitter ≤ 8ms** — และ absolute inbound วัดไม่ได้ที่ความละเอียดนี้

```
inbound=755ms / 747ms   min 747 / p50 755 / max 755   spread 8ms
clock offset vs LINE: +408…+852ms (±566ms)
```

- **spread 8ms คือค่าที่เชื่อได้** — เป็นผลต่างระหว่าง sample ค่า offset คงที่หักล้างกันเอง ⇒ ส่วนที่แปรผันของ Square
  push อยู่ระดับหลักหน่วย ms **ยังไม่ขัดกับ budget 11ms**
- **absolute inbound เชื่อไม่ได้**: `750 − offset` = ช่วง `−100…+350ms` ที่ ±566ms HTTP `Date` มี
  granularity 1 วินาที → **หยาบกว่า budget 11ms ราว 50 เท่า** วัดยังไงก็ไม่ได้

> **บทเรียนเชิงสถาปัตยกรรมสำหรับ Phase 2:** เมตริกหลักต้องเป็นค่าที่วัดบน **นาฬิกาเดียว** เท่านั้น
>
> - **send RTT** (`transport_submit → ack_complete`) — monotonic ใน process เรา แม่นยำ ไม่มี skew
> - **code time** — monotonic ล้วน
> - **inbound race** (Phase 5: push vs poll vs dedicated-poll) — สังเกตด้วยนาฬิกาเราทั้งคู่ skew หักล้าง
>   และนี่คือ inbound ที่ **มีผลต่อการตัดสินใจจริง** (เส้นไหนเห็นก่อน)
> - **absolute inbound** ต้องรอ NTP-grade sync บน prod Linux (chrony) จึงจะมีความหมาย บน Windows dev
>   ด้วย `w32tm` ได้แค่ระดับ ~±100ms — ไม่พอสำหรับ 11ms

### 3a. `inbound=772ms` sample แรกเป็น artifact ของนาฬิกา ไม่ใช่ latency

วัด clock offset ของ dev host เทียบ LINE ได้ **`+1151ms` (±563ms)** (5 sample, เลือก RTT ต่ำสุด, ผ่าน
`obs.line-apps.com`) — `772 − 1151 = −379ms` คือ **อยู่ในช่วง 0 ภายในความคลาดเคลื่อน**

> **บล็อก Phase 2:** ตราบใดที่ host clock ยังเพี้ยนระดับวินาที ตัวเลข inbound ทุกตัวใช้ไม่ได้ ต้อง sync นาฬิกาก่อน
> (`w32tm /resync` บน Windows) แล้ววัดใหม่
>
> หมายเหตุ: `legy.line-apps.com` และ `gf.line.naver.jp` ตอบ 404 **ไม่มี `Date` header** ใช้เป็น reference
> วัด skew ไม่ได้ ทั้งที่เป็น hot send origin

### 4. Field map ถูกต้อง

`room` = square chat mid (`m…`), `from` = square member mid (`p…`), `msg` = message id, `text`/`len`
ตรง, `createdTime` (thrift Int64) อ่านเป็น epoch ms ได้

## ผลวัดจริงบน Tokyo server (นาฬิกาเชื่อถือได้) — 2026-09-10

Host: `172.237.14.170` — Linode / **Akamai Connected Cloud, Tokyo** (โครงข่ายเดียวกับ LINE)

| ค่า                               | ผล                                                         |
| -------------------------------- | ---------------------------------------------------------- |
| RTT → `legy.line-apps.com`       | **0.366 / 0.400 / 0.437 ms** (min/avg/max)                 |
| RTT → `gf.line.naver.jp`         | 0.303 / 0.364 / 0.397 ms                                   |
| Clock offset (chrony, stratum 3) | **−0.008 ms (±1.706 ms)** — อยู่ในงบ 11ms                    |
| **inbound (Square push, n=10)**  | **min 123 / p50 126 / p95 148 / max 148 ms**, spread 25 ms |
| dropped / backlog                | 0 / 0                                                      |

### ข้อสรุปที่เปลี่ยนสมมติฐานของโปรเจกต์

**inbound ≈ 126 ms แต่เป้าใน Phase 0 ตั้งไว้ 11 ms — และ 126 ms นั้นไม่ใช่ของเรา**

network RTT ถึง LINE = 0.4 ms ⇒ เวลาที่เหลือเกือบทั้งหมดคือ **เวลาภายในของ LINE** ตั้งแต่รับข้อความจากผู้ส่งจนปล่อย
push ออกมา **โค้ดฝั่งเราลดไม่ได้ และคู่แข่งก็ลดไม่ได้** เป็น _common-mode delay_ ที่ทุกคนที่ฟัง push ได้รับพร้อมกัน

ผลต่อกลยุทธ์:

1. **เลิกมองว่า inbound 11 ms เป็นเกณฑ์ผ่าน/ตก** — ต้องแก้เป้าใน `phase-0-winner-definition.md` §7
   ให้สะท้อนหลักฐาน (แยก "ส่วนที่ LINE คุม" ออกจาก "ส่วนที่เราคุม")
2. **สนามแข่งจริงอยู่หลังจุดที่เรารับ event** — our processing (≤0.5 ms) + send RTT จาก Tokyo ที่ network 0.4
   ms ส่วนนี้มีโอกาสดีมาก → **Phase 2 ต้องวัด send RTT เป็นอันดับแรก**
3. **Phase 5 (race push / normal-poll / dedicated-poll) กลายเป็นงานที่มีค่าที่สุดสำหรับ inbound**
   ถ้าบางข้อความเส้นอื่นเห็นก่อน push เราชนะข้อความนั้น — และ spread 25 ms คือช่องว่างที่ race ไปกินได้

### ข้อจำกัดของชุดวัดนี้ (อย่าสรุปเกิน)

- n = 10, ผู้ส่งคนเดียว, ห้อง Square ห้องเดียว, **ยังไม่ได้ทดสอบ Talk**
- ยังไม่ยืนยันว่า `createdTime` เป็น server-stamp ตอน LINE รับ หรือ client-stamp จากเครื่องผู้ส่ง ถ้าเป็นอย่างหลัง
  126 ms จะรวมเวลาอัปโหลดของเครื่องผู้ส่ง + ความคลาดเคลื่อนนาฬิกาเขาด้วย (ไม่ว่าทางไหน ก็ยังเป็นส่วนที่เราลดไม่ได้)
- ยังไม่ได้วัด send RTT เลย — เป็นงานแรกของ Phase 2

## Phase 2 — รายละเอียด

| งาน                               | สถานะ | หมายเหตุ                                                                                   |
| --------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| 11 trace points + monotonic marks | ✅    | `src/metrics/trace.ts` — `Float64Array` จองครั้งเดียว, first-mark-wins, `NULL_TRACE` สำหรับปิด |
| Percentile ring (p50/95/99)       | ✅    | `src/metrics/ring.ts` — `add` O(1), sort เฉพาะตอน snapshot                                |
| Recorder (spans + counters)       | ✅    | `src/metrics/recorder.ts` — เก็บหลังส่งเสร็จเท่านั้น                                             |
| Wire เข้า pipeline + send RTT      | ✅    | `transport_submit → ack_complete` รอบ `sender.send`                                       |
| **วัด send RTT จริง**               | ✅    | p50 32.3ms (ดูด้านล่าง)                                                                      |
| **Instrumentation overhead A/B**  | ✅    | 1.64 µs/event (ดูด้านล่าง)                                                                   |
| per-lane stats                    | ⬜    | ต้องรอ Phase 4 (owned lanes)                                                               |
| worker ID                         | ⬜    | ต้องรอ Phase 7 (sharding)                                                                  |
| source winner                     | ⬜    | ต้องรอ Phase 5 (inbound race)                                                              |

## Phase 2 — ผลวัด baseline (Tokyo server, 2026-09-10)

### Send RTT — ตัวเลขที่ตัดสินการแข่งขัน (`transport_submit → ack_complete`)

วัดบนนาฬิกาเดียว **ไม่มี caveat เรื่อง NTP** — Talk compact `/CA5` ส่งหาตัวเอง, n=12

```
min 28.9 / p50 32.3 / p95 71.6 / max 71.6 ms     mean 37.7     12/12 สำเร็จ
#1  = 58.7ms   ← cold start (TLS/connection/JIT)
#2–11 = 28.9–36.3ms  ← warm steady state, jitter ~7ms
#12 = 71.6ms   ← spike
```

| เทียบเป้า                          | ผล          |
| -------------------------------- | ----------- |
| budget ≤ 19 ms                   | ❌ เกิน      |
| guardrail 23 ms (Playbook §7.10) | ❌ เกิน ~40% |

**แต่ network RTT ถึง `legy.line-apps.com` = 0.4 ms** ⇒ จาก 32ms มีแค่ 0.4ms ที่เป็นการเดินทาง ที่เหลือ ~31.6ms
คือ **LINE server processing + ต้นทุนในเครื่อง** (thrift encode, crypto, ชั้นของ LINEJS)

นี่คือ **baseline แบบยังไม่ optimize อะไรเลย** — ยังไม่มี warm transport (Phase 3) และยังไม่มี owned HTTP/2
lanes (Phase 4) ซึ่งเป็นสองอย่างที่ Playbook ใช้ทำให้ลงมาถึง ~20ms หลักฐานว่ามีที่ให้ปรับ: `#1` cold = 58.7ms (Phase
3 แก้), `#12` spike = 71.6ms (Phase 4 lane repair แก้)

### Instrumentation overhead (ข้อกำหนด Phases Phase 2)

pipeline อย่างเดียว 20,000 event/รอบ, MockSender:

```
tracing OFF : 3.06 µs/event
tracing ON  : 4.70 µs/event
overhead    : 1.64 µs/event
```

53.7% เมื่อเทียบกันเอง **แต่เทียบ budget "our processing ≤ 0.5 ms" แล้วคือ 0.3%** และ pipeline ทั้งเส้น (dedupe
3 ชั้น + match + claim + rate limit + job registry) ใช้ **4.7 µs = 0.9% ของงบ** ⇒ เปิด tracing ไว้ตลอดได้
ไม่ต้องมี sampling

### สรุปงบประมาณเวลา ณ ตอนนี้

| ช่วง                  |    เป้า |          วัดได้ | ใครคุม                                 |
| -------------------- | -----: | ------------: | ------------------------------------- |
| Inbound (LINE → เรา) |  11 ms |    **126 ms** | ❌ LINE — common-mode ทุกคนเท่ากัน       |
| Our processing       | 0.5 ms | **0.0047 ms** | ✅ เรา — เหลืองบ 99%                   |
| **Send RTT**         |  19 ms |     **32 ms** | ✅ **เรา — สนามแข่งจริง ยังไม่ optimize** |

## Phase 3 — Warm transport

### สิ่งที่สร้าง

| ส่วน                         | ไฟล์                        | หมายเหตุ                                                                                                                                                    |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TransportWarmer`           | `src/warm/warmer.ts`       | probe socket Square จริง `legy.line-apps.com/SQ1` เป็นช่วง (default 25s ตาม Playbook §8.1), `ready` = probe ล่าสุดสำเร็จและยังสด, นับ consecutive failures + tests |
| Pooled fetch                | `src/warm/http-client.ts`  | `Deno.createHttpClient({ poolIdleTimeout: false })` — connection ไม่หลุดตอน idle, แชร์ระหว่าง warmer กับ session                                                |
| Custom transport เข้า LINEJS | `adapters/linejs/login.ts` | `InitOptions.fetch` → adapt `(info,init)` → LINEJS `(req)` FetchLike                                                                                       |
| bench `--warm-seconds`      | `src/cli/bench.ts`         | อุ่น origin N วินาทีก่อนวัด ผ่าน connection เดียวกับที่ LINEJS ส่งจริง                                                                                                  |

Compact protocol (`/CA5`) มีตั้งแต่ Phase 1b · TCP NoDelay เป็น default ของ Deno HTTP client · TLS
session resumption จัดการโดย Deno เอง

### ผลวัด (Tokyo server) — interleaved cold/warm

|          pair | cold p50 |    warm p50 | cold #1 (first send) |     warm #1 |
| ------------: | -------: | ----------: | -------------------: | ----------: |
|             1 |  74.3 ms | **31.9 ms** |             114.4 ms | **39.7 ms** |
|             2 |  44.8 ms |     44.3 ms |              65.4 ms |     54.6 ms |
| (รอบก่อนหน้า) 1 |     32.3 |        30.8 |                 49.4 |        38.4 |
| (รอบก่อนหน้า) 3 |     33.8 |        30.8 |                 50.9 |        41.0 |

**ข้อสรุปที่เชื่อได้ (เห็นทุก pair):**

1. **Warm-up ลบ cold-start penalty ของ send แรกได้จริง** — cold #1 บวกจาก steady ~30–40 ms เสมอ, warm
   #1 บวกแค่ ~5–10 ms · warmer รายงาน `5 probes, last rtt ~2 ms, ready=true` — ทำงานถูก
2. **Warm-up ไม่ขยับ steady-state** — steady แกว่ง 30–75 ms ตามเวลาของวัน (LINE-side, §12.1) ไม่เกี่ยวกับเรา
3. Pair-to-pair variance ใหญ่กว่า within-pair ⇒ **ต้อง A/B แบบ interleaved ≥50 sample × ≥3 ช่วงเวลา
   (Playbook §12.2)** เพื่อได้ตัวเลขเป๊ะ — ทิศทางชัดแล้ว ตรงกับ Playbook §8.1

**สมมติฐาน ณ เวลาวัด Phase 3 (แก้ความหมายตามข้อมูลใหม่):**

- network probe RTT 0.4 ms กับ send ~30 ms เป็นคนละ workload/distribution จึงใช้ลบเพื่อแจกแจงเฟสไม่ได้
  การวัดตรงภายหลังพบ `writeThrift` เพียง ~0.06 ms p50
- ณ เวลาวัด Phase 3 ยังไม่มี **owned HTTP/2 lanes**; ปัจจุบัน Phase 4 ทำแล้วและเพิ่ม send/poll reservation +
  initial/stale calibration เมื่อ 2026-09-12
- **cold #1 residual ~5–10 ms หลัง network warm = protocol/crypto/JIT** (compact encode, `getReqseq`,
  crypto path) → Playbook §8.2 warm ที่ระดับ bot ยังไม่ทำ (พิจารณา Phase 3b หรือรวมกับ Phase 6)

### GATE: P3

`deno task gate` เขียว (local + server), 33 test files, coverage 97.9% · infra warm transport เสร็จ
และพิสูจน์ว่าลบ cold-start ได้ · steady-state เป็นงานของ Phase 4 และการวัดเฟสโดยตรง

## Phase 4 — Owned H2 lanes

**สร้าง:** `src/transport/lane.ts` (`Lane` — 1 HTTP/2 session + application-RTT window,
drain/recycle/close) · `src/transport/lane-pool.ts` (`LanePool` — custom fetch, route ตาม median RTT
ล่าสุด, switch margin 0.1ms, park lane ที่ raw RTT > 23ms, GOAWAY → drain+recycle, age recycle ทีละเส้น) ·
`src/transport/index.ts` (`createOwnedLanePool` → `Deno.HttpClient` ต่อ lane) · `bench --lanes N`

**เทสต์ (16 steps, deterministic):** route ไป lane เร็วสุด · ไม่ churn ต่ำกว่า margin · park lane ช้า · ไม่
park lane สุดท้าย · GOAWAY drain+recycle+close transport เก่า · age recycle ทีละเส้น เคารพ gap · close
ปิดทุก lane · reject config ผิด

**วัดจริง (Tokyo, `--lanes 0` vs `--lanes 6`):**

|         |     p50 |    mean | lane stats                                                              |
| ------- | ------: | ------: | ----------------------------------------------------------------------- |
| lanes=0 | 30.5 ms | 32.7 ms | —                                                                       |
| lanes=6 | 29.7 ms | 41.6 ms | lane1 median **7.6ms**, lane0 median 87.5ms (parked หลัง spike #6=104ms) |

- **ผลเดิมของรอบนี้**: routing เลือก lane 1, park lane 0 หลัง spike แต่ lanes 2–5 ไม่เคยถูก sample
- **แก้ 2026-09-12**: calibrate ทุก candidate lane ก่อนจัดอันดับ, re-calibrate sample ที่เกิน 30 วินาที และ แยก
  send lane ออกจาก continuous poll ด้วย `sendReservedLanes`
- **send RTT ยังต้องวัด live ใหม่**; การลบ `send p50 - lane p50` แล้วสรุปว่า ~22ms เป็น encode ไม่ถูกต้อง
  เพราะเป็น percentile คนละ distribution การวัด `writeThrift` ตรง ๆ พบเพียง 0.06ms p50 และเพิ่ม
  `sequence_prep` เพื่อแยกเวลา `getReqseq()`

### GATE: P4

`deno task gate` เขียว local+server, 20 test files, coverage 97.3% · lane pool กลไกครบและพิสูจน์แล้ว ·
คอขวดถัดไปยังไม่สรุปจนกว่า `sequence_prep` และ live A/B ของ lane reservation จะมี sample เพียงพอ

## Phase 5 — Fast inbound race

**สร้าง:** `src/adapters/racing.ts` (`RacingInboundAdapter` — merge N sources, dedupe by message-id,
first-wins, tag source, นับ win/duplicate) · `src/adapters/linejs/square-poll.ts`
(`SquarePollAdapter` — dedicated room poll, single cursor ไม่ overlap, drain history จนกว่า page ว่าง,
timeout+abort, error backoff) · `src/adapters/linejs/square-fetcher.ts` (`fetchSquareChatEvents` →
`SEND_MESSAGE`/`RECEIVE_MESSAGE` → `RawLineMessage`) · `probe --race <mid>`

**เทสต์ (8 steps, deterministic):** racing — start/stop children · forward distinct + tag source ·
suppress duplicate + count · stream ends after all children · square-poll — drain until empty page +
advance cursor · single cursor (maxConcurrent=1) · backoff แล้วโพลต่อด้วย token เดิม · stop

**วัดจริง (Tokyo, race push vs dedicated-poll ห้องทดสอบ):**

รอบ 1 (fetcher ผิด shape): dedicated-poll ส่ง 0 — fix: per-chat ใช้ `SEND_MESSAGE`/`RECEIVE_MESSAGE`
ไม่ใช่ `NOTIFICATION_MESSAGE`

รอบ 2 (n=5): **dedicated-poll ชนะ 5/5 · push 0 · duplicates suppressed 5** (push มาทีหลังถูกกลบ)

```
inbound (race): 24 / 31 / 58 / 84 / 88 ms      p50 58, min 24
inbound (push-only, เทียบ Phase 1b): ~123–126 ms
```

**ข้อสรุป — เปลี่ยนสมมติฐานอีกครั้ง:** "inbound ~126 ms เป็นของ LINE ลดไม่ได้" **ผิด** — นั่นคือของ **เฉพาะ push
stream** · dedicated `fetchSquareChatEvents` poll เห็นข้อความเร็วกว่า ~40–100 ms สม่ำเสมอ → **race
(Playbook §5.1) คือ lever ของ inbound จริง** ในห้องที่เฝ้า กลไก dedupe first-wins ทำงานถูก (push
ที่มาทีหลังถูกกลบ 5/5)

**ข้อจำกัด:** n=5, ห้องเดียว, ผู้ส่งคนเดียว · poll ทุก ~100 ms/ห้อง — สำหรับไม่กี่ห้องสำคัญโอเค แต่ไม่ scale ทุกห้อง →
**slot budget** (จำกัดจำนวนห้องที่ dedicated-poll) ยังไม่ทำ

**Slot budget (ปิดงาน Phase 5):** `src/adapters/linejs/racing-inbound.ts` `createRacingInbound()` —
push (ครอบทุกห้อง) + dedicated-poll สูงสุด `slotBudget` ห้อง (default 4) เรียงตาม priority ที่ caller ให้ ·
`probe --race a,b,c --slots N` · เทสต์ 5 steps: cap ที่ budget เรียงลำดับ · budget 0 = push only · budget
≥ rooms = ครบ · negative clamp เป็น 0 · lone push ยัง race ได้

### GATE: P5 ✅

`deno task gate` เขียว local+server, 23 test files, coverage ~93% · race + dedicated poll + slot
budget ครบและพิสูจน์แล้วว่า **ลด inbound ~ครึ่งหนึ่งในห้องที่เฝ้า** (p50 126→58 ms)

## Phase 6 — Readiness FSM

**สร้าง (pure logic, deterministic):**

- `src/readiness/state.ts` `ReadinessFsm` — ladder `starting→authenticated→syncing→warming→armed` (+
  `degraded`/`repair` นอก ladder) · **ARMED ต่อเมื่อ 5 check ผ่านครบ**: sessionValid,
  receiverSubscribed, rulesLoaded, senderReady, backlogDrained · forward เดินทีละ step (สังเกตได้) ·
  check หลุด → drop ลง state ต่ำทันที · `degrade(reason)` → บล็อก set() · `beginRepair()` จาก degraded
  เท่านั้น · `snapshot()` (state/checks/reason/since)

`WarmScheduler` ที่เคยอยู่ในแผนถูกตัดออกแล้ว: ไม่มี runtime consumer และการตั้งเวลา warm แบบแยก สามารถแย่ง lane
กับข้อความจริงได้. ระบบใช้ connection warmer ที่ผูกกับ lifecycle ของแต่ละ bot และ shared warm-up gate แทน
จึงไม่มี background schedule ที่ยิงเพิ่มระหว่างการแข่งขัน.

**เทสต์:** FSM — start/armed-requires-all/step-progression/regression-drops/degrade-blocks/
repair-only-from-degraded/snapshot

**หมายเหตุ:** การต่อ FSM เข้ากับ event จริงของ LINEJS (`fsm.set()` เมื่อ connection/subscription เปลี่ยน)
เป็นงานของ worker main loop (รวมกับ Phase 11)

### GATE: P6 ✅

`deno task gate` เขียว local+server, 24 test files, coverage 93.1%

## Phase 7 — Sharding + multi-user isolation

**สร้าง (TS core — ทดสอบได้ทั้งหมด):**

| ส่วน             | ไฟล์                               | กลไก                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shard topology  | `src/sharding/topology.ts`        | shard ด้วย **owner** ไม่ใช่ bot · `validateTopology()` จับ owner ซ้ำ 2 worker (จะทำให้ owner-level claim แตก), workerId ซ้ำ, default เกิน 1, topology ว่าง · `belongsTo(owner, worker)` = guard ที่ worker ใช้ทิ้งงานที่ไม่ใช่ของตัวเอง                                                         |
| Write-behind    | `src/persistence/write-behind.ts` | `enqueue()` = array push ไม่ await ไม่ throw · flush ตาม batch/timer · bounded + นับ drop · flush ซ้อนถูกรวบ · `close()` ไล่ flush แล้วหยุด ไม่ spin ถ้า flush พัง                                                                                                                      |
| SQLite          | `src/persistence/sqlite.ts`       | `node:sqlite` native (ไม่ต้องลง dep) · WAL + foreign_keys + busy_timeout + synchronous NORMAL · `runMigrations()` versioned, transaction ต่อ migration, idempotent, reject version ซ้ำ/ถอยหลัง                                                                                    |
| Schema          | `src/persistence/migrations.ts`   | **account DB** (room_configs, allowed_senders, rules, warm_schedules, config_generations, encrypted_session_records, sequence_reservations, job_results, latency_rollups, operational_events) · **control DB** (users, line_identities, web_sessions, accounts, deployments) |
| LINE Login PKCE | `src/auth/pkce.ts`                | verifier/challenge S256, state, nonce, `safeEqual` constant-time, `buildAuthorizeUrl()`                                                                                                                                                                                      |

**เทสต์ (38 steps):** topology 13 · write-behind 7 · sqlite/migrations 9 · pkce 9 — รวมเคส RFC 7636
worked example, migration rollback, และ `deployments.owner_id` PRIMARY KEY กันไม่ให้ owner เดียวมี 2
worker **ที่ระดับ schema**

**หลักการแยก isolation:** 1 account = 1 ไฟล์ SQLite (ไม่ใช่ tenant column) — SQLite ไม่มี RLS และ WAL
ยังเขียนได้ทีละ writer ต่อ database การแยกไฟล์จึงให้ทั้ง isolation และ write parallelism · LINE Login **ไม่ใช่**
สิทธิ์อ่านข้อความ — แยกจาก selfbot session เด็ดขาด

**เลื่อนไป (ต้องมี HTTP service):** Go control-plane API + proxy, transactional deploy/rollback, OAuth
callback handler ที่ใช้ PKCE helper นี้, config generation ACK loop — รวมกับ Phase 11

### GATE: P7 ✅ (core)

`deno task gate` เขียว local+server · 49 test files, **227 steps**, coverage 93.6%

## Phase 8 — UI / Observability

**แก้บั๊กหลัก §10.9:** UI เคยคำนวณ HOT เองจากคะแนนย้อนหลัง → lane 26.8ms โชว์ HOT ส่วน 16.3ms โชว์ COOL ตอนนี้
badge คำนวณที่ **backend ด้วยตัวเลขชุดเดียวกับที่ router ใช้เลือก lane จริง** UI แค่ render

| ส่วน                    | ไฟล์                              | กลไก                                                                                                                                                                             |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lane classification    | `src/observability/status.ts`    | `classifyLanes()` → badge `hot`/`standby`/`wait`/`down` · **sample เก่ากว่า 30s = WAIT และซ่อนตัวเลข** (ไม่ให้ค่าเก่าดูเหมือนสด) · lane ที่ไม่ `ready` ไม่มีวันชนะแม้ตัวเลขต่ำสุด                    |
| Snapshot               | `src/observability/snapshot.ts`  | รวม readiness + lanes + metrics + race + warm + workerId/origin/uptime — ประกอบตอนถูกขอ ไม่ใช่บน hot path                                                                           |
| HTTP                   | `src/observability/server.ts`    | `GET /` dashboard · `/api/status` · `/api/health` (503 จนกว่า armed) · **bind 127.0.0.1 เท่านั้น** (Playbook §14.3 ห้าม expose shard port) · `no-store` + `nosniff`                   |
| Dashboard              | `src/observability/dashboard.ts` | หน้าเดียว ไม่มี build step · instrument panel ไม่ใช่ SaaS template · สีสื่อความหมายจาก budget เท่านั้น · Thai `line-height 1.7` + `padding-top` กันวรรณยุกต์โดนตัด · mobile ≤520px จัด layout ใหม่ |
| `probe --serve <port>` | `src/cli/probe.ts`               | รัน console คู่กับ probe                                                                                                                                                             |

**เทสต์ (13 steps):** classify — lowest fresh RTT = HOT เดียว · unmeasured = WAIT ไม่แซง measured ·
stale → WAIT + ซ่อน rtt · draining=WAIT / dead=DOWN · non-ready ไม่ชนะแม้เร็วสุด · carry-through · empty
· server — `/api/status` payload, `/api/health` 503→200, `/` html+nosniff, 404/405, `no-store`,
uptime

**รันจริงบน Tokyo server:** `/` 200 · `/api/health` 200 (readiness `armed`, 5 checks ครบ) ·
`/api/status` คืน snapshot ครบ

ดูหน้า console ผ่าน SSH tunnel (port ไม่ได้เปิด public โดยตั้งใจ):

```bash
ssh -L 8791:127.0.0.1:8791 root@172.237.14.170     # แล้วเปิด http://localhost:8791/
```

### GATE: P8 ✅

`deno task gate` เขียว local+server · 51 test files, **240 steps**, coverage 93.0%

## Phase 9 — Advanced experiments

### สิ่งที่สร้าง

| ไฟล์                            | ทำอะไร                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `experiments/types.ts`         | รูปแบบ experiment: hypothesis, metric, sample floor, failure impact, rollback |
| `experiments/registry.ts`      | บังคับ "เปิดทีละตัว" + conflict + เงื่อนไขการ adopt                                 |
| `experiments/evaluate.ts`      | Welch CI 95% → `adopt` / `reject` / `inconclusive` + guard เรื่อง correctness  |
| `experiments/definitions.ts`   | เทคนิคทั้ง 7 ตัวจาก Phases §17 เขียนไว้ก่อนรัน                                       |
| `experiments/prepared-slot.ts` | กลไกใหม่ตัวเดียวของ phase นี้ — prepared request slot ที่ fail closed               |

รายละเอียดทั้งหมด + ผลวัดที่มีแล้วอยู่ใน [`experiments.md`](./experiments.md)

### สิ่งที่ phase นี้ **ไม่** ทำ

ไม่มีเทคนิคไหนถูก adopt ตอนนี้ — และนั่นคือผลลัพธ์ที่ถูกต้อง `read-only-fetch-race` มีผลบวกชัด (inbound p50 126ms →
58ms, dedicated poll ชนะ 5/5) แต่ 5 sample ต่ำกว่า floor 200 registry จะปฏิเสธถ้าลอง adopt ตอนนี้
ซึ่งเป็นสิ่งที่เราต้องการให้มันทำ

`cpu-affinity-irq` กับ `napi-socket-tuning` อยู่สถานะ `blocked` ไม่ใช่ `rejected` — ต้อง profile host ก่อน
ถึงจะรันได้

### ตัวเลขที่ชี้เป้า experiment ที่คุ้มที่สุด

| ชั้น                          | วัดได้   |
| --------------------------- | ------ |
| RTT ไป `legy.line-apps.com` | 0.37ms |
| lane-level HTTP RTT         | 7.6ms  |
| full send RTT               | ~30ms  |

ส่วนต่าง ~22ms คือ thrift encode/parse ใน TypeScript — owned lane (Phase 4) แตะไม่ได้ →
`native-encode-relay` คือ experiment ที่มี upside สูงสุดที่เหลืออยู่

### GATE: P9 ✅

`deno task gate` เขียว · เทสต์ใหม่ 36 steps (registry 15, evaluate 11, prepared-slot 10)

## Phase 10 — Acceptance

### สิ่งที่สร้าง

| ไฟล์                     | ทำอะไร                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `acceptance/harness.ts` | pipeline จริง + FakeClock + scripted sender — deterministic ทั้งหมด  |
| `acceptance/cases.ts`   | ตาราง Phases §18 ครบ 12 แถว แถวละหนึ่ง case                         |
| `acceptance/report.ts`  | รันทั้งตาราง + นับ pass/fail + limitations ที่ติดไปกับรายงานเสมอ          |
| `cli/acceptance.ts`     | `deno task acceptance` — exit 1 ถ้ามี case ตก ใช้เป็น release gate ได้ |

case ทุกตัวรันใน `deno task gate` ด้วย regression จึงทำให้ build แดง ไม่ใช่รอไปเจอตอน live

### ผล: 12/12 ผ่าน

| case                         | ยืนยันอะไร                                           |
| ---------------------------- | -------------------------------------------------- |
| `first-key-after-idle`       | idle 30 นาทีแล้ว span แรกไม่แย่กว่า warm                |
| `repeated-rounds`            | 5 รอบ = 5 send ไม่มีการใช้ครั้งที่สองแทนครั้งแรก            |
| `same-key-new-job`           | คีย์เดิม job ใหม่ → job key คนละตัว ตอบทั้งคู่              |
| `sender-not-in-allowlist`    | ตรงคีย์แต่ไม่มีสิทธิ์ = ไม่ตอบ                              |
| `impersonating-display-name` | ชื่อเหมือน ID คนละตัว = ไม่ตอบ                          |
| `multiple-rules-match`       | priority 10 ชนะ priority 1                         |
| `concurrent-jobs`            | 3 ห้องพร้อมกัน dispatched ครบ 3                       |
| `reconnect-backlog`          | backlog ส่งซ้ำจากอีก path = `deduped-incoming`        |
| `token-rotation`             | ARMED หลุด + prepared payload ไม่รั่ว                  |
| `ack-timeout-unknown`        | send ค้าง → `send-failed` + job `unknown` ไม่ใช่ lost |
| `observability-off-hot-path` | persistence ค้างสนิท + 200 snapshot → reply ยัง 1ms   |
| `crash-restart`              | owner ลง worker เดิม + prepared เก่าใช้ซ้ำไม่ได้         |

### สิ่งที่ phase นี้ค้นเจอ

สองแถวของตารางไม่มี gate ใน pipeline เลย — ไม่มี sender allowlist. เพิ่ม `core/allowlist.ts` + outcome
`sender-not-allowed` เป็น gate แรกสุด (ก่อน dedupe ด้วย: คนไม่มีสิทธิ์ไม่ควรถมพื้นที่ claim map) interface จับที่ ID
อย่างเดียว **ไม่มีพารามิเตอร์ให้ส่งชื่อเข้ามา** → เคส impersonation แก้ที่ระดับ type ดู [ADR-0007](./decisions.md)

### ขอบเขตของชุดวัดนี้ (อย่าสรุปเกิน)

รายงานพิมพ์ข้อจำกัดติดไปทุกครั้ง เพราะข้อจำกัดพวกนี้มีคนลืมประจำ:

- local replay = **correctness เท่านั้น** ไม่มีตัวเลขไหนในนี้เป็น live LINE latency
- sender เป็น script → send RTT ถูกกำหนดโดย harness ไม่ได้วัด
- ไม่มีบอทคู่แข่งร่วมวัด → เป็น controlled comparison ห้ามเรียกว่าชนะคู่แข่ง

### GATE: P10 ✅

`deno task gate` เขียว · `deno task acceptance` 12/12

## Phase 11 — Production + monitoring

### สิ่งที่สร้าง

| ไฟล์                        | ทำอะไร                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| `release/manifest.ts`      | build hash + config hash แยกกัน, canonical JSON, `assertDeployable()`    |
| `monitoring/alerts.ts`     | 5 rule พร้อม duration gate — spike เดียวไม่ใช่ alert                        |
| `monitoring/recovery.ts`   | recovery ladder 5 ขั้นตาม Playbook §16 — ตัดสินอย่างเดียว ไม่ลงมือ              |
| `persistence/retention.ts` | rollup รายชั่วโมงแยกตาม release + prune ที่ไม่ทำลายข้อมูลที่ยังไม่ได้ rollup        |
| `deploy/release.sh`        | transactional deploy ครบสิบข้อของ Playbook §16 + rollback อัตโนมัติ          |
| `observability/server.ts`  | เพิ่ม `/api/alerts` + ติด release label ใน `/api/health` และ `/api/status` |
| `docs/runbook.md`          | operations runbook                                                      |

### จุดตัดสินที่สำคัญ

**Release identity แยก code กับ config** ([ADR-0008](./decisions.md)) — ถ้าใช้ commit อย่างเดียว การแก้
config จะไม่เปลี่ยน id แล้ว metric สองชุดถูกยำรวมกัน A/B ก็ตอบอะไรไม่ได้ label ที่ติดไปกับ metric คือ
`<version>+<build12>/<config12>`

**Recovery ไต่บันได ไม่ restart จาก alert เดียว** ([ADR-0009](./decisions.md)) — Playbook §16 พูดตรง ๆ
เรื่องนี้ แต่ระบบ auto-heal ส่วนใหญ่ผูก handler ต่อ alert ตรง ๆ ซึ่งแปลว่า spike เดียวก็ restart ได้ มีเทสต์ ยืนยันว่า
latency regression ที่เห็นซ้ำ 20 ครั้งในเวลาเดียวกันยังอยู่ที่ขั้น `avoid-lane`

**Alert ทุกตัวมี duration gate** — 60s (readiness 30s) และ sample floor 20 อัตราล้มเหลว 100% จาก send
สองครั้งคือ noise ไม่ใช่ปัญหา

**prune บีบอัด ไม่ทำลาย** — raw row เก่าจะถูกลบก็ต่อเมื่อมี rollup ครอบมันแล้วเท่านั้น

### Worker main loop (ปิดช่องว่างสุดท้าย)

ก่อนหน้านี้ทุก phase สร้างชิ้นส่วนไว้ แต่ไม่มีตัวประกอบ — entry point ยังเป็น `cli/probe.ts` ซึ่งดูอย่างเดียว ไม่ตอบ
ตอนนี้มีแล้ว:

| ไฟล์                           | ทำอะไร                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `config/bot-config.ts`        | ต่อบอท: ห้อง, sender ที่อนุญาต, กฎ, `dryRun` — แก้ได้โดยไม่ต้อง redeploy |
| `worker/worker.ts`            | main loop: รับ → ตอบ, readiness, monitor tick                    |
| `worker/recovery-executor.ts` | แปลง rung เป็น action จริง (แยกจาก planner ที่เป็น pure)             |
| `adapters/dry-run.ts`         | เดินครบทั้ง pipeline แต่ไม่โพสต์ — โหมดสำหรับรันจริงครั้งแรก               |
| `cli/serve.ts`                | `deno task serve` — entry point ของ production                  |
| `release/describe.ts`         | อ่าน commit/config hash ของ build ที่รันอยู่                          |
| `deploy/lfr-worker.service`   | systemd unit                                                    |

**จุดสำคัญของ main loop:** dispatch **ไม่ await** ใน read loop ถ้า await งานถัดไปจะต้องรอ network round
trip ของงานก่อนหน้า ซึ่งคือเคส "งานใหม่ติด queue ของงานเก่า" ที่ acceptance table ตรวจอยู่พอดี — มีเทสต์ยืนยันว่า
event ที่สองเข้า sender พร้อมกับตัวแรก

**`dryRun` default = true** ถ้าไม่มี key นี้ในไฟล์ บอทจะไม่โพสต์ การโพสต์จริงต้องเขียน `"dryRun": false` ชัด ๆ —
บอทที่โพสต์ลงห้องจริงเพราะคนลืมใส่ flag เป็นความผิดพลาดที่แย่กว่าบอทที่เงียบ

### ยังไม่ได้ทำ

- Go control-plane API + proxy, OAuth callback handler, config-generation ACK loop
- `scheduler.schedule()` จาก config timezone/window (ยกมาจาก Phase 6)
- recovery rung `rearm-poll` / `reconnect-session` / `restart-worker` ยังไม่มี hook จริง — planner ตัดสิน
  และ log ไว้ ให้คนลงมือ (ดู runbook §5)

### GATE: P11 ✅

`deno task gate` เขียว · **72 test files, 362 steps, line coverage 94.9%** ·
`bash -n deploy/release.sh` ผ่าน

## Dependency

```
0 → 1 → 1b → 2 → 3 → 4 → 5
                          │
              7 ─┐        │
                 ├─ 8 ────┤
              6 ─┘        │
                          ↓
                    9 → 10 → 11
```

- 7 เริ่มออกแบบ schema/auth ได้หลัง 1b, ทำขนานกับ 3–6
- 9 บางรายการข้ามได้ถ้า profiling ไม่สนับสนุน
- 10 ต้องรอ feature ที่เลือกครบ

## จุดตัดสินระหว่างทาง (จาก decision doc §9 ความเสี่ยง)

1. Connector ใช้จริงได้หรือไม่ (1b)
2. เวลาหายที่ notification/fetch/network หรือในเครื่อง (2)
3. first-after-idle ดีขึ้นจริง หรือเฉพาะ repeated send (6)
4. ปรับแล้วชนะ/รับงานมากขึ้น หรือแค่ตัวเลข ACK ดูดีขึ้น (10)
