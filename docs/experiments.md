# Experiment registry (Phase 9)

Phases §17 deliverable: hypothesis, baseline, sample size, first-response improvement, failure
impact, rollback — ต่อหนึ่งเทคนิค

กติกาที่บังคับด้วยโค้ด ไม่ใช่ด้วยวินัย (`apps/worker/src/experiments/`):

1. **เปิดทีละตัว** — `ExperimentRegistry` ตั้งต้น `maxConcurrent = 1` และปฏิเสธคู่ที่ประกาศ `conflictsWith`
   ไว้ต่อกัน เทคนิคสองตัวที่เปิดพร้อมกันทำให้ improvement ที่วัดได้ระบุที่มาไม่ได้
2. **adopt ต้องมีหลักฐาน** — `conclude(id, 'adopt', …)` โยน `ValidationError` ถ้า evidence เป็น `none`
   หรือ sample ต่ำกว่า floor ของ experiment นั้น. **reject ไม่ต้องมี** — ของแย่ต้องถอดออกได้ทันที
3. **verdict มาจาก confidence interval** — `evaluate()` จะ `adopt` ก็ต่อเมื่อ 95% CI ของผลต่าง **ทั้งช่วง**
   อยู่ต่ำกว่าศูนย์ ไม่ใช่เพราะ mean ดูดีขึ้น หรือเพราะมีรันหนึ่งที่สวย
4. **correctness ชนะ latency เสมอ** — missed/error rate แย่ลง = `reject` ต่อให้เร็วขึ้นแค่ไหน

---

## สถานะ

| id                           | เทคนิค                             | สถานะ           | หลักฐาน                                              |
| ---------------------------- | --------------------------------- | --------------- | --------------------------------------------------- |
| `read-only-fetch-race`       | Racing dedicated poll กับ push     | 🟡 มีผลบวกแล้ว    | Phase 5 + 2026-09-11 live, sample ยังไม่ถึง floor      |
| `receiver-diversity`         | หลาย receiver → sender เดียว       | ⬜ ยังไม่รัน       | ชนกับตัวบน                                            |
| `prepared-request-slot`      | เตรียม request ล่วงหน้า ใช้ครั้งเดียว    | 🔧 กลไกเสร็จ     | ยังไม่ได้วัด                                            |
| `split-fetch-send-transport` | แยก lane ของ fetch กับ send        | 🔧 กลไกเสร็จ     | reserve send lane + calibrate ครบ; รอวัด live A/B    |
| `native-encode-relay`        | ย้าย thrift encode ออกจาก TS       | ❌ **หักล้างแล้ว** | วัดจริงได้ 0.06–0.4ms ไม่ใช่ ~22ms (ดูล่าง) — **ไม่คุ้มสร้าง** |
| `cpu-affinity-irq`           | CPU affinity / IRQ / scheduler    | 🔒 blocked      | ต้อง profile host ก่อน                                |
| `napi-socket-tuning`         | NAPI / coalescing / socket tuning | 🔒 blocked      | ต้อง profile host ก่อน                                |

`blocked` ≠ `rejected` — `blocked` แปลว่ารันที่นี่ไม่ได้ (ต้องการสิทธิ์/ข้อมูล host), `rejected` แปลว่า วัดแล้วไม่คุ้ม
registry แยกสองอย่างนี้เพราะเหตุผลต่างกันคนละเรื่อง

---

## รายละเอียดที่มีผลวัดแล้ว

### `read-only-fetch-race` — ผลบวกที่ยืนยันแล้วใน Phase 5, ยืนยันซ้ำ 2026-09-11

**Hypothesis:** dedicated per-room fetch loop เห็นข้อความก่อน push stream → race แล้ว inbound ลดลงครึ่ง

**ผลจริง (Tokyo server, chrony ±1.7ms):**

| ตัววัด               | push อย่างเดียว | ราซ์กับ dedicated poll (Phase 5) | + `pollIntervalMs: 0` (2026-09-11)       |
| ------------------ | ------------- | ------------------------------ | ---------------------------------------- |
| inbound p50        | ~126ms        | 58ms                           | **19ms**                                 |
| inbound max        | —             | —                              | **48ms** (จาก 122ms ก่อนแก้)               |
| inbound min        | —             | 24ms                           | 10ms                                     |
| dedicated poll ชนะ | —             | 5/5                            | ส่วนใหญ่ (push ยังเห็นข้อความทุกครั้ง แค่แพ้ race) |

ข้อสรุปที่กลับสมมติฐานเดิมของโปรเจกต์: 126ms **ไม่ใช่** เพดานของ LINE — มันเป็นเพดานของ _push path_

**2026-09-11:** `pollIntervalMs` ไม่เคยถูกตั้งใน production config มาก่อน (ใช้ default 100ms)
การกระจายตัวของ inbound แบบ uniform 12–122ms คือลายเซ็นของ poll gap คงที่ — ข้อความมาถึงตอนไหนในช่องว่าง
100ms ก็ได้ ตั้ง `pollIntervalMs: 0` (ยิงรอบใหม่ทันทีที่รอบก่อนจบ ไม่ overlap) ตัดหางออกหมด, inbound p50 ลด 70%

**ผลข้างเคียงที่เจอ:** poll ถี่ขึ้น ~50/s ทำให้ dedicated-poll ชนะเกือบทุกครั้ง → alert `missed-events` เดิม
(วัดจาก win-share) เข้าใจผิดว่า push ตายเพราะชนะ 0% — แก้โดยเปลี่ยน alert ให้วัดจาก `seen` (ทุกครั้งที่ source
เจอข้อความ ไม่ว่าจะชนะหรือแพ้) แทน `wins` (ดู `apps/worker/src/adapters/racing.ts`,
`monitoring/alerts.ts`)

**ยังไม่ adopt อย่างเป็นทางการ** เพราะ sample floor คือ 200 ต่อ arm ตัวเลขข้างบนยังต่ำกว่านั้น ทิศทางชัดมากแต่ยัง
เรียกข้อสรุปทางการไม่ได้ registry จะปฏิเสธถ้าลอง `conclude('adopt', …)` ตอนนี้ ซึ่งถูกต้องแล้ว

**Failure impact:** อ่านห้องเพิ่ม + ถ้า dedupe gate พังเมื่อไหร่ จะโพสต์ซ้ำทุกข้อความ + request ไป LINE ถี่ขึ้น ~6
เท่า เสี่ยงโดน rate limit ถ้า LINE เข้มงวดขึ้น **Rollback:** ตั้ง `pollIntervalMs` กลับเป็นค่าที่สูงขึ้น (เช่น
25–50ms) ใน `config/bots/*.json` แล้ว restart — ไม่ต้อง deploy โค้ดใหม่ หรือไม่ส่ง `--race` เหลือ push
อย่างเดียว

### `native-encode-relay` — หักล้างแล้วด้วยตัวเลขจริง (2026-09-11)

ตัวเลขเดิมที่ทำให้ experiment นี้เกิด (ไม่เคยเป็นการวัดจริง เป็นการลบเลข):

| ชั้น                          | วัดได้ (เดิม, ลบเลข) |
| --------------------------- | ----------------- |
| RTT ไป `legy.line-apps.com` | 0.37ms            |
| lane-level HTTP RTT         | 7.6ms             |
| **full send RTT**           | **~30ms**         |

ตอนนั้นสรุปว่าส่วนต่าง ~22ms คือ thrift encode/parse ใน TypeScript — **แต่ไม่เคยวัด `protocol_prep`
ได้จริงสักครั้ง** `installThriftEncodeTimer` เดิมผูกกับ `sendMessage()` ซึ่ง await `getReqseq()` (เขียน storage
จริง) ก่อนจะเรียก `writeThrift` เสมอ ทำให้การจับเวลาแบบ synchronous-first-side-effect อ่านค่าเร็วเกินไปทุกครั้ง
คืน `undefined` ตลอด — unit test เดิมผ่านเพราะ mock เรียก `writeThrift` ตรงๆ ไม่มี await คั่นแบบของจริง

**แก้แล้ว (2026-09-11):** ย้ายจุดจับเวลาไปที่ `RequestClient.request()` แทน
(`request → requestCore →
writeThrift` เป็น synchronous จริง ไม่มี await คั่น) — ดู
`apps/worker/src/adapters/linejs/thrift-timing.ts`

**ผลวัดจริงบน production (7 sends แรกหลังแก้):**

| ตัววัด            | ค่าจริง                         |
| --------------- | ----------------------------- |
| `protocol_prep` | **0.06ms** (p50), 0.05–0.22ms |
| `send` เต็มๆ     | 28.5ms (p50)                  |

thrift encode กินแค่ **~0.2% ของ send** ไม่ใช่ ~73% ตามที่เคยสรุปไว้ **หักล้าง hypothesis เดิมสมบูรณ์ — ไม่คุ้มสร้าง
Go encode relay เลย** ส่วนต่างที่เหลือรวม `getReqseq`, request/response และเวลาประมวลผลฝั่ง LINE จึงเพิ่ม
`sequence_prep` เพื่อวัด `getReqseq()` ตรง ๆ ก่อนสรุปคอขวดชั้นต่อไป

Sample ยังต่ำกว่า floor (200/arm) มาก แต่ทิศทางห่างกัน 50 เท่า ไม่ต้องรอ sample ครบก็เพียงพอจะไม่เริ่มสร้าง relay

**Failure impact:** ไม่มีแล้ว — ไม่ต้องสร้าง **Rollback:** ไม่เกี่ยวข้อง

### `split-fetch-send-transport` — กลไกเสร็จ รอ live A/B (2026-09-12)

continuous poll เดิมใช้ candidate set เดียวกับ reply send และตัวเลือก lane เดิมไม่เคยส่งงานไป lane ที่ยังไม่มี
sample ทำให้ production เห็นหนึ่ง lane มีค่า ส่วนที่เหลือ WAIT ตลอด กลไกใหม่ทำสองอย่าง:

1. เก็บ lane หมายเลขต่ำไว้สำหรับ send (`sendReservedLanes`, ค่า production = 1) และให้ poll ใช้ lane ที่เหลือ
2. บังคับ calibrate ทุก lane ใน candidate set ก่อนจัดอันดับ และวัดใหม่เมื่อ sample เกิน 30 วินาที

private role header ถูกลบก่อน request ออกจาก process จึงไม่ส่ง metadata ภายในไป LINE หากกลุ่มที่สงวนไว้ใช้ไม่ได้
router จะ fallback ไปกลุ่มที่ยัง route ได้ ไม่ตัด availability ทิ้ง Dashboard แสดง role และ HOT แยกตามกลุ่ม เมื่อ
reserved send lanes ทุกเส้นมี fresh RTT ตั้งแต่ 23ms ขึ้นไป send จะ crossover ไป fast idle poll lane ก่อน
จึงไม่ย้อนกลับไปเส้นช้าเพียงเพราะ cooldown หมด

**หลักฐานตอนนี้:** deterministic tests ครอบคลุมการแยก role, header stripping, initial/stale calibration
และ fallback แต่ยังไม่มี live A/B จึงยังไม่สรุปว่า latency ดีขึ้น **Rollback:** ตั้ง `sendReservedLanes: 0` แล้ว
restart

### `prepared-request-slot` — กลไกเสร็จ ยังไม่ได้วัด

`PreparedSlot<T>` fail closed ทุกทาง: ใช้ได้ครั้งเดียว, route key/sequence ไม่ตรงคือทิ้ง payload, เกิน
`maxAgeMs` คือทิ้ง อันตรายจริงของ experiment นี้คือ replay request เก่าใส่ session ใหม่ ไม่ใช่ช้า

การ fail closed แพ้แค่ค่าเตรียม request หนึ่งครั้ง การ fail open ส่ง request ที่ค้างอยู่ออกไปจริง

---

## วิธีรัน experiment หนึ่งตัว

```ts
const registry = new ExperimentRegistry(EXPERIMENTS);
registry.start(EXPERIMENT_IDS.preparedSlot); // ปฏิเสธถ้ามีตัวอื่นเปิดอยู่

// … เก็บ sample ทั้งสอง arm …

const verdict = evaluate(baselineArm, variantArm, { minSamples: 200 });
registry.conclude(EXPERIMENT_IDS.preparedSlot, verdict.verdict === 'adopt' ? 'adopt' : 'reject', {
  note: verdict.reason,
  evidence: 'live-paired',
  samples: verdict.variant.n,
});
```

`verdict.reason` ออกแบบมาให้ paste ลงตารางข้างบนได้ตรง ๆ เช่น
`mean 4.20ms faster, 95% CI [-5.10, -3.30] entirely below 0`

## ข้อควรระวังตอนวัด live

จาก Phases §18 — ใช้กับ experiment ด้วย ไม่ใช่แค่ acceptance:

- สลับ A/B แบบสุ่มตามเวลา หรือ crossover เพื่อลดผล time-of-day / session path
- เก็บ sample count ต่อ idle bucket; sample น้อยต้องแสดงความไม่แน่นอน โดยเฉพาะ p99
- รายงานงานที่ระบบ DEGRADED แยกจากงานตอน ARMED — ไม่งั้นเป็นการซ่อน availability
- ไม่มีคู่แข่งจริงในการวัด = **controlled comparison** ห้ามเรียกว่าชนะคู่แข่ง
