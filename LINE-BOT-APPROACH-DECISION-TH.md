# LINE Bot — สรุปแนวทางที่ได้ผลจริง (เลือกเส้นทางพัฒนา)

> เปรียบเทียบเอกสาร 2 ฉบับในโปรเจกต์ แล้วสรุปว่า **จะใช้แนวทางไหนที่ได้ผลจริง**
>
> - `LINE-BOT-LATENCY-PLAYBOOK.md` — เรียกย่อว่า **Playbook**
> - `LINE-First-Response-Architecture-and-Phases-TH.md` — เรียกย่อว่า **Phases**
>
> จัดทำ: 10 ก.ย. 2026

---

## 0. TL;DR (อ่านอันเดียวจบ)

|                 | สรุป                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playbook**    | โค้ด **สร้างจริง วัดผลจริง** (อ้าง commit `5e3a774`, test 98 pass/0 fail) เป็นบันทึกย้อนหลังของระบบที่รันได้แล้ว → ใช้เป็น **ฐานเทคนิคความเร็ว/ความนิ่ง**                                       |
| **Phases**      | แผน 10 phase ที่ **ยังไม่ได้ทดสอบกับบัญชี LINE จริงและยังไม่วัด latency จริง** (ระบุเองในบรรทัด 4) อ่านจาก source code LINEJS เป็นหลัก → ใช้เป็น **กระบวนการ + กติกา + ข้อควรระวังเฉพาะ LINEJS** |
| **แนวทางที่เลือก** | **ผสมสองฉบับ ไม่เลือกอันเดียว** — ยกโครงเทคนิคที่พิสูจน์แล้วจาก Playbook มาเป็นฐาน แล้วครอบด้วย Phase 0 (นิยามผู้ชนะ) + ข้อค้นพบระดับ source ของ LINEJS + จุด trace การวัด จาก Phases            |
| **สิ่งที่ห้ามทำ**    | อย่าเริ่มจากศูนย์ตาม Phases ทั้งหมด เพราะหลายเรื่องที่ Phases ยัง "เตือนว่าต้องระวัง" นั้น Playbook **แก้ไปแล้วและมีผลวัด/มี test ยืนยัน**                                                         |

---

## 1. เอกสารสองฉบับต่างกันตรงไหน

| มิติ              | Playbook                                                                                        | Phases                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| สถานะ           | โค้ดจริง `5e3a774` มีผลวัด + test ผ่าน 98/0 (§11)                                                    | ยังไม่ทดสอบกับบัญชี LINE จริง (บรรทัด 4)                                                  |
| ประเภทเอกสาร    | บันทึกย้อนหลัง (retrospective playbook)                                                             | แผนล่วงหน้า 10 phase (0–10)                                                          |
| ฐานหลักฐาน       | ตัวเลขวัดจริง เช่น warm-up origin (146→29ms, 335→99ms), poll ×2 ช้าลงเท่าตัว (17.8→36.3ms), lane tests | อ่าน source LINEJS `[S1]`–`[S16]`; ตัวเลขทั้งหมดเป็น **budget** ไม่ใช่ผลพิสูจน์ (บรรทัด 108)  |
| จุดแข็งเฉพาะตัว    | HTTP/2 owned lane pool, bug catalog 12 เคส, config baseline, deploy/rollback                    | นิยาม "ผู้ชนะ", job identity contract, measurement trace points, multi-user isolation |
| จุดอ่อน           | สมมติว่า connector ทำงานแล้ว, ไม่พูดเรื่องนิยาม "จุดตัดสินผู้ชนะ"                                            | ยังไม่มีผลจริงเลย, เสี่ยง re-derive สิ่งที่ Playbook แก้ไปแล้ว                                 |
| Stack           | Bun + Go relay + owned H2 lanes (ใช้งานจริง)                                                      | Go + Bun + React + SQLite + LINEJS (ยังตัดสิน Bun vs Node ไม่จบ)                       |
| LINEJS revision | ไม่ระบุชัด                                                                                         | pin `ef6c3d9f70dd41fa51053615d47f071f58cf8db3`                                     |

---

## 2. คำตัดสิน: ใช้แบบผสม

**เหตุผล**

1. Playbook เป็น _superset_ ของ "เทคนิคความเร็ว" ที่ Phases ตั้งเป้าจะไปค้นหา — Phase 3/4/5/8 ของ Phases
   ปลายทางคือดีไซน์เดียวกับที่ Playbook ทำเสร็จแล้ว (owned lane pool, application-aware routing, warm
   transport, inbound race)
2. Phases เก่งเรื่องที่ Playbook **ไม่ครอบ**: การนิยามสนามแข่งก่อนเขียนโค้ด, วินัยไม่หลอกตัวเองตอนวัด, ข้อจำกัด LINEJS
   ระดับ source ที่จะทำให้ budget พัง
3. สองฉบับ **พูดตรงกันหลายข้อโดยอิสระ** (ดู §5) → ข้อเหล่านั้นคือความมั่นใจสูงสุด

**สูตร:** `เทคนิคจาก Playbook (พิสูจน์แล้ว) × กระบวนการ+กติกาจาก Phases (กันหลงทาง)`

---

## 3. เทคนิคที่ "มีหลักฐานว่าได้ผลจริง" — เอามาจาก Playbook ได้เลย

| เทคนิค                                                                                                            | อ้างอิง         | หลักฐาน                                        |
| ---------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------- |
| Owned HTTP/2 lane pool + application-aware routing (6 lane default / 8 lane isolated shard)                      | Playbook §7   | lane tests ผ่านครบ §11.2                       |
| Race 3 เส้นทางรับข้อความ: `push` + `normal-poll` + `dedicated room poll` เข้าตัว dedupe เดียว                          | §5.1, §3      | —                                             |
| Dedupe ด้วย `message-id` ที่ประตูเข้า 3 ชั้น (`claimIncomingMessage` / `claimReply` / `claimRoomAnswer`)                | §5.2          | แก้บั๊ก duplicate push+poll §10.4                |
| Hot path อ่านทุกอย่างจาก memory, DB เป็น write-behind                                                                | §6.1–6.2      | —                                             |
| แยก H2 `PING` ออกจาก application RTT เด็ดขาด — **ห้ามใช้ PING แทน send latency**                                    | §2, §7.1, §19 | PING 0.9ms แต่ app RTT 26.5ms                  |
| Warm เป็น 2 ระดับ: network ระดับ worker + protocol/crypto/matcher ระดับ bot ก่อนประกาศ online                         | §8            | E2EE cold JIT +13ms บน Windows                |
| **ไม่มี cron restart** — self-healing ราย lane + age-based rolling recycle (15 นาที/เส้น)                            | §9, §7.11     | อาการ "เปิดนานแล้วช้า" แก้ที่ route ไม่ใช่ restart    |
| Soft affinity **ต่อบอท** (ไม่ hard-pin) — คนละบอทชนะคนละ lane พร้อมกันได้                                             | §7.6, §10.7   | hard-pin เคยทำให้ 6 session ทำงานเหมือนมีเส้นเดียว |
| Drop ดีกว่า queue เมื่อ rate limiter ไม่อนุญาต                                                                         | §6.3          | —                                             |
| แบ่ง shard ด้วย `owner_user_id` ไม่แบ่งราย bot                                                                       | §14.3         | bot พี่น้องต้องใช้ owner-level claim ชุดเดียว        |
| Poll concurrency = **1** เท่านั้น                                                                                   | §5.3, §10.5   | เพิ่มเป็น 2 → reply 17.8ms → 36.3ms (ช้าลงเท่าตัว)  |
| กฎสลับ lane เมื่อเร็วกว่า `≥ 0.10ms` (ไม่ใช่ 0.01)                                                                      | §7.5          | 0.01ms จะ churn ตาม jitter                    |
| Deploy จาก commit hash + build แยก dir + atomic symlink + เก็บ rollback target                                    | §16           | —                                             |
| ตัด HTTP/1-only headers ก่อนส่ง H2, ใช้ `:authority`, `accept-encoding: identity`, TCP `NoDelay`, TLS session ticket | §7.13         | lane test §11.2                               |

---

## 4. สิ่งที่ต้องหยิบจาก Phases (Playbook ไม่มี / ไม่ครบ)

1. **Phase 0 — นิยาม "ผู้ชนะ" ก่อนเขียนโค้ด** (Phases บรรทัด 90–95, 284–299)

   - จุดตัดสินคือ: ระบบรับงานปลายทาง / แอดมินเห็น / observer / ไม่มีข้อมูล
   - **ห้ามใช้ API ACK เป็นผลชนะโดยอัตโนมัติ** — เครื่องสองเครื่องเห็นลำดับ ACK ต่างกันได้
   - ถ้าไม่มีข้อมูลผู้ชนะจริง ให้รายงานแค่ latency ห้ามอ้าง win rate

2. **ข้อค้นพบระดับ source ของ LINEJS ที่กระทบ budget โดยตรง**
   | ข้อค้นพบ                                                                        | อ้างอิง             | ผลต่อแผน                                                                      |
   | ----------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
   | OpenChat push อาจเป็น **notification-only** → ต้อง `square.fetchMyEvents()` ต่อ  | §3.1 / `[S1]`     | มี network round trip เพิ่ม การลด matcher ไม่กี่ µs ไม่ช่วย                          |
   | `SquareChat.listen()` มี sleep **1,000ms** (2,000ms เมื่อ error)                 | §3.2 / `[S3][S4]` | เส้นนี้ไม่ผ่านเป้า inbound — ต้องใช้ push เป็น baseline                               |
   | `getReqseq()` มี queue + อ่าน storage + `await storage.set()` ก่อนคืนเลข          | §3.3 / `[S5]`     | ถ้า storage เป็น persistent I/O จะอยู่บนเส้นทางคำตอบแรก — ตรวจ implementation จริง |
   | Bun กับ Node ใช้ transport คนละแบบ; PUSH/HTTP2/ALPN ต้องทดสอบบน Bun revision จริง | §3.5 / `[S8]`     | "library รองรับ Bun" ≠ transport ทุกแบบ latency เท่ากัน                          |
   | Talk `sendCompactMessage()` + E2EE fallback + refresh-token retry             | §3.4 / `[S7]`     | อย่าเหมาว่าใช้กับ Square ได้; เตรียม key/token ก่อนช่วงงาน                           |

3. **Measurement trace points ที่ละเอียดกว่า Playbook** (Phases บรรทัด 114–127)

   ```
   source_event_time → notice_rx → fetch_submit → message_bytes_ready →
   decoded → matched → sequence_ready → transport_submit → write_observed →
   ack_complete → observer_seen → winner_confirmed
   ```

   - ใช้ monotonic clock ภายใน process; wall clock + ค่าคลาดเคลื่อนเมื่อข้ามเครื่อง
   - ถ้าวัดได้แค่ callback `square:message` ให้ตั้งชื่อว่า `callback_to_submit` **ห้าม** ใช้แทน "Our processing"
     ทั้งก้อน

4. **Job identity contract** (Phases บรรทัด 277–278, 506)

   - คีย์เดิมแต่ job ใหม่ **ต้องตอบได้** — ห้าม hash keyword แล้วปิดทิ้งตลอด
   - ถ้างานมี ID ให้ใช้ ID; ถ้าไม่มี ให้แยกรอบจาก source message ID + ผู้ส่ง + ห้อง + กฎปิดงาน

5. **Readiness state machine** ที่แยกสถานะให้ชัด (Phases บรรทัด 216, 254–264)
   `STARTING → AUTHENTICATED → SYNCING → WARMING → ARMED` (+ `DEGRADED → REPAIR`)

   - "connection มีชีวิต" ≠ "subscription ใช้ได้" ≠ "sender พร้อม" — TCP connect สำเร็จ ไม่ใช่ readiness
     ทั้งหมด

6. **Multi-user isolation / ownership ตั้งแต่ schema** (Phases Phase 6) — `control.sqlite` +
   `accounts/<id>.sqlite` แยกต่อบัญชี

---

## 5. จุดที่เอกสารทั้งสอง "พูดตรงกันโดยอิสระ" = ความมั่นใจสูงสุด ทำเลย

- ห้ามใช้ PING แทน send latency
- Race หลาย inbound source เข้า sender กลางตัวเดียว
- Dedupe ด้วย message-id ที่ประตูเข้า
- Memory hot path; metric / DB / log ทำ **หลัง** network send เท่านั้น
- Warm ก่อน armed/online
- **ไม่เพิ่ม poll concurrency เพราะคิดว่า parallel เร็วกว่า** (Playbook วัดได้ช้าลง 2 เท่า / Phases จัดอยู่ใน
  "อย่าเปิดเพราะชื่อดูเร็ว")
- ไม่ retry non-idempotent send โดยไม่มี idempotency key/sequence ที่ปลายทางรับรอง
- ไม่ใช้ cron restart กลบอาการเสื่อมตาม uptime
- A/B แบบ interleaved, ≥ 50 sample/config, ≥ 3 ช่วงเวลาไม่ติดกัน, แยก warm-up sample ออก
- รายงาน p50/p95/p99 แยกตาม phase (inbound / code / upstream) — p99 ของแต่ละส่วนบวกกันไม่ได้
- `TCP_NODELAY` เป็น socket option ต้องตรวจ effective จริง ไม่ใช่ HTTP header
- Compact protocol แยกตาม channel (Talk `/CA5`,`/ECA5` — Square `/SQ1`)
- อย่าสรุปจากตัวอย่าง 1–5 ครั้งแรก (cold path / GC / JIT / calibration)

---

## 6. Anti-pattern ที่ทั้งสองห้าม (รวมรายการ)

- ใช้ PING เป็นตัวแทน send latency
- hard-pin send lane ตลอดอายุ process
- retry send ที่อาจถึงปลายทางแล้วโดยไม่มี idempotency
- query database / เขียน metric แบบ synchronous ก่อนตอบ
- เปิด listener แบบ detached โดยไม่มี root `.catch()` / watchdog
- ใช้ auth token เป็นหลักฐานเดียวว่า listener ยังทำงาน
- repair/recycle lane ที่มี in-flight request / drain lane สุดท้ายโดยไม่มี standby
- ให้ UI ตีความ routing state จากคะแนนย้อนหลัง (ดาว/กล้วย)
- cron restart เพื่อรักษาความเร็ว
- แบ่ง bot owner เดียวกันข้าม worker เมื่อ coordination อยู่ใน memory
- deploy ก่อน commit / ไม่มี rollback target
- เดา endpoint, ปลอม timestamp, ปิด TLS verification, เดาคำตอบก่อนมีคีย์จริง, ส่งรัวแทนการลด latency
- เปลี่ยน congestion control / socket buffer / IRQ / CPU governor พร้อมกันจนระบุผลไม่ได้

---

## 7. จุดขัดกัน / ต้องตัดสินใจ

| ประเด็น                    | Playbook                                                             | Phases                                             | ทางออกที่เลือก                                                                                              |
| ------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime                   | Bun + Go relay + owned H2 lanes ใช้งานจริงแล้ว                          | ยังไม่ยืนยัน Bun PUSH transport; เสนอ Node เป็น control | **ใช้ Bun ต่อ** (มีหลักฐาน) แต่เก็บ Node control test ไว้เป็น regression ตาม Phases §3.5 — ไม่ถือเป็น blocker       |
| เป้า SEND                  | 20ms target / **23ms guardrail** (วัดจริง, เกิน 23ms พัก bot-route 15 วิ) | 19ms send / 32ms event-to-ACK (budget)             | ใช้ **23ms guardrail** เป็นเกณฑ์ปฏิบัติ; ถือ 32ms เป็น SLO รวม + error budget ไม่ใช่ hard fail รายครั้ง              |
| ความเร็วไปถึงดีไซน์ lane pool | มีครบแล้ว §7                                                           | กว่าจะถึง Phase 4/8                                  | **adopt lane pool design ทันที** แล้วใช้ Phases เป็นชั้น test/acceptance                                        |
| Switch margin 0.10ms      | มีเหตุผลรองรับ (§7.5)                                                   | เตือนเรื่อง lane churn ทั่วไป                           | เก็บ **0.10ms** ตาม Playbook                                                                              |
| LINEJS revision           | ไม่ระบุ                                                                | pin `ef6c3d9…`                                     | **lock ให้ตรงกันหนึ่งค่า** ก่อน benchmark; บันทึกใน version manifest                                             |
| storage ในเส้นทาง sequence | ใช้เส้นทางปัจจุบัน                                                        | เตือนว่า `getReqseq()` อาจ await disk                | ใช้ BufferedFileStorage (RAM + write-behind) และวัดตรงเป็น `sequence_prep`; รอ live sample ก่อน optimize เพิ่ม |

---

## 8. ลำดับลงมือที่แนะนำ (ผสมสอง roadmap)

| ขั้น                                     | ที่มา                         | งานหลัก                                                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. นิยามสนามแข่ง**                     | Phases Phase 0              | นิยามผู้ชนะ + job identity contract + workload profile (บัญชี/ห้อง/คีย์/งานพร้อมกัน)                                                                                                                                                                                          |
| **1. Correctness core**                | Playbook §17 P1 + Phases P1 | message-id dedupe, exactly-once reply claim, owner/room claim, rule cache, rate limiter, timeout/AbortSignal, error classification **+** connector capability matrix (push notification-only?, fetch ต่อ event, Bun transport, session recovery ไม่ทำงานเก่าเป็นงานใหม่) |
| **2. Measurement**                     | Playbook §17 P2 + Phases §5 | phase breakdown + 12 trace points + p50/95/99 ring + per-lane stats + worker ID + source winner; เก็บ **first attempt เสมอ** แม้ล้มเหลว; วัด instrumentation overhead แยก                                                                                               |
| **3. Warm transport**                  | Playbook P3                 | shared HTTP client, keep-alive, TLS session ticket, startup readiness warm, NoDelay, compact protocol                                                                                                                                                               |
| **4. Owned H2 lanes**                  | Playbook P4 / §7 ทั้งบท       | lane lifecycle, GOAWAY draining, application RTT, sub-23 crossover, 0.1ms soft switch, background repair, age recycle, per-bot route key + cooldown                                                                                                                 |
| **5. Fast inbound race**               | Playbook P5                 | dedicated room poll, startup drain history, single cursor, slot budget, push/poll dedupe                                                                                                                                                                            |
| **6. Warm scheduling + readiness FSM** | Phases P5                   | readiness จาก subscription+sender+config+session/key; warm ตาม timezone/interval/count; yield to real jobs                                                                                                                                                          |
| **7. Sharding + multi-user isolation** | Playbook §14 + Phases P6    | owner-scoped worker, control-plane proxy, disjoint topology validation, WAL/write-behind, transactional deploy/rollback, LINE Login (auth code + PKCE + state/nonce) แยกจาก selfbot session                                                                         |
| **8. UI / Observability**              | Phases P7 + Playbook §13    | dashboard ที่ HOT/COOL/WAIT มาจาก backend decision เดียว, แสดง sample age + worker ID + in-flight, score/history แยกจาก live state, mobile-first                                                                                                                       |
| **9. Advanced experiments**            | Phases P8                   | receiver diversity→single sender, read-only fetch race, prepared request slot, CPU affinity/IRQ — **เปิดทีละตัว มี hypothesis/baseline/rollback**                                                                                                                       |
| **10. Acceptance**                     | Phases P9                   | ตารางเคสการแข่งจริง (คีย์แรกหลัง idle, คีย์เดิม job ใหม่, ผู้ส่งนอก allowlist, ชื่อซ้ำแอดมินคนละ ID, หลายกฎ, หลายงาน, reconnect+backlog, ACK timeout → UNKNOWN)                                                                                                                     |
| **11. Production + monitoring**        | Playbook §16 + Phases P10   | release pin versions/hash, rollout กลุ่มเล็ก, alert จาก missed events + first-response regression + readiness loss, recovery ladder (เลี่ยง lane ช้า → reconnect lane เดียว → rearm room poll → reconnect session → restart worker เป็นขั้นสุดท้าย)                             |

---

## 9. ความเสี่ยงที่ยังเปิดอยู่ (ไม่มีเอกสารไหนปิด)

1. Playbook อ้าง commit `5e3a774` — **ต้อง verify ว่าตรงกับ codebase ปัจจุบัน** ก่อนอ้างเป็นข้อเท็จจริง
2. Playbook typecheck **ยังไม่ยืนยัน** (Bun binary remap error §10.12, §11.1) — อย่ารายงานว่า typecheck
   ผ่านจนกว่าจะรันสำเร็จจริง
3. Phases มีผลจริง **0 ครั้ง** — ทุกตัวเลข (11 / 0.5 / 19 / 32 / 26ms) เป็น budget ต้องพิสูจน์
4. LINEJS revision สองฉบับไม่ตรงกัน — **lock ให้เป็นค่าเดียว** + dependency lock + บันทึก OS/architecture
5. ยังไม่มีนิยาม "จุดตัดสินผู้ชนะ" จากผู้จัดงานจริง — **Phase 0 ต้องเสร็จก่อน** ไม่งั้น optimize ผิดจุด
6. Dev เป็น Windows (E2EE cold JIT +13ms §8.2) แต่ prod เป็น Linux — ต้องวัดแยกแพลตฟอร์ม
7. `getReqseq()` ใช้ BufferedFileStorage (อ่าน RAM/เขียนแบบ write-behind) แล้ว; ต้องเก็บ `sequence_prep`
   live sample เพื่อดู promise-queue/serialization contention ก่อนเปลี่ยน implementation

---

## 10. บรรทัดเดียวสำหรับผู้บริหาร

> **ไม่เริ่มใหม่จากแผน 10 phase** — ยกโครงเทคนิคที่วัดผลแล้วจาก Playbook (owned HTTP/2 lane pool, inbound
> race, dedupe ที่ประตู, memory hot path, warm, ไม่ restart ตามเวลา) มาเป็นฐาน แล้วใช้เอกสาร First-Response
> เป็นชั้น **นิยามผู้ชนะ + วินัยการวัด + ข้อควรระวัง LINEJS ระดับ source** ที่ Playbook ไม่ได้พูดถึง เริ่มลงมือที่ Phase 0
> (นิยามสนามแข่ง) → Correctness core → Measurement ก่อนแตะเรื่องความเร็ว
