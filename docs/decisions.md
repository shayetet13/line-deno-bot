# Architecture Decision Record

รูปแบบสั้น: Context → Decision → Consequences. เพิ่มด้านบนสุดเมื่อมี decision ใหม่

---

## ADR-0011 — Bot หลายตัวใน `--multi-bot` รันบน bot shard (Worker thread) ไม่ใช่ thread เดียวกับ console

**วันที่:** 2026-09-24

**Context:** production ใช้ `--multi-bot` ซึ่งเดิมรัน bot ทุกตัวบน JavaScript thread เดียว และ vps3 มี 1 vCPU
เมื่อเพิ่มเป็น 20 bot ตัวเลขกระโดด 50–400ms. วัดด้วย simulator (LanePool + LINEJS request path +
SquarePollAdapter ของจริง, mock LINE server แบบ TLS/HTTP2 หน่วง 10ms/19ms, ปักไว้ 1 core):

| topology (poll 1 ห้อง/bot, `pollIntervalMs: 0`) | CPU           | คำตอบช้าเพิ่ม p95    | ช้าสุด       |
| ---------------------------------------------- | ------------- | ----------------- | ---------- |
| 1 bot                                          | 7% ของ 1 core | +3.5ms            | +7ms       |
| 20 bot, thread เดียว, 1 core                    | 46%           | +9.6ms            | +15ms      |
| 20 bot, process ละตัว, **1 core**               | 100% (อิ่มตัว)   | +40ms (แย่สุด +106) | **+180ms** |
| 20 bot, process ละตัว, 2 core                   | 139%          | +9.7ms            | +19ms      |
| 20 bot, 1 shard thread, 2 core                 | 51%           | +3.7ms            | +4.5ms     |

ข้อสรุป: (1) อาการกระโดดคือ CPU ไม่พอ ไม่ใช่ LINE (2) CPU ขึ้นกับ **จำนวน poll ต่อวินาที** ไม่ใช่โค้ดเรา —
`LanePool` กิน ~5µs/request, fetch ของ Deno เองเป็นส่วนใหญ่ (3) แยก process ละ bot เปลืองกว่ารวม ~3
เท่าเพราะแต่ละ process ตื่นแยกกัน (4) thread เดียวใช้ได้ core เดียวไม่ว่าเครื่องมีกี่ core

**Decision:**

- `--multi-bot` รัน bot ใน `BOT_SHARDS` Worker thread (ค่าเริ่ม: จำนวน core − 1, อย่างน้อย 1, สูงสุด 8;
  `BOT_SHARDS=0` = แบบเดิม). bot ใหม่ไป shard ที่มี bot น้อยสุด และอยู่ shard เดิมตลอดอายุ process
- ใน shard, bot คือ `BotHost` ตัวเดิมและ route ของ console คือ handler ตัวเดิม (`shard-worker.ts` เป็นแค่
  bridge) console thread ยืนยันตัวตน ถือทะเบียนบัญชี (writer เดียวของ `.control/users.json`) แล้ว forward
  request ของ คนนั้นไป shard ของ bot เขาเท่านั้น — ownership ตัดสินก่อน forward เหมือนเดิม
- shard ตาย (uncaught error) → เริ่ม thread ใหม่และ start bot ของ shard นั้นใหม่; shard อื่นไม่รู้ตัว
- Node sidecar ของ `/PUSH` ใช้ร่วมกันหนึ่งตัวต่อ thread (เดิมหนึ่งตัวต่อ bot = 20 process) โดยแต่ละ bot ยังมี
  HTTP/2 session และ health ของตัวเอง
- ทุก thread วัด event-loop lag (`metrics/loop-lag.ts`) ส่งออกใน `/api/status → host` และ alert
  `host-cpu-starved` (p99 > 10ms นาน 60s) ซึ่ง **observation-only** — reconnect ใช้ CPU เพิ่ม ไม่ได้ลด

**Consequences:**

- (+) bot หนึ่งตัวที่ decode หนักไม่หน่วง bot ใน shard อื่น, ใช้ได้ทุก core, UX login หน้าเดียวเหมือนเดิม
- (+) แยกได้ทันทีว่ากระโดดเพราะเครื่อง (loop lag ขึ้นพร้อม send) หรือเพราะ LINE (send ขึ้น loop lag นิ่ง)
- (−) บนเครื่อง 1 vCPU shard ช่วยได้น้อย — ต้องเพิ่ม core; คำแนะนำขนาดเครื่องอยู่ใน runbook §10
- (−) sidecar ที่ใช้ร่วมกันตายทีเดียว PUSH ของทุก bot ใน thread นั้นหลุดพร้อมกัน (reconnect เองอัตโนมัติ และ
  dedicated poll ยังรับห้องที่เฝ้าอยู่)

---

## ADR-0010 — Reply lane เลือกด้วย scout ที่วัดต่อเนื่อง: ยึดเส้นเร็ว สลับเมื่อมีเส้นเร็วกว่าจริง

**วันที่:** 2026-09-24

**Context:** router เดิมเรียนรู้จาก reply จริงเท่านั้น ซึ่งมีไม่กี่ครั้งต่อนาที และ preflight ทำครั้งเดียวตอน start —
ลำดับความเร็วจึงเก่าลงเรื่อย ๆ และ pin ยังอยู่บน lane ที่เคยเร็วตอน start แม้อีก lane จะเร็วกว่าแล้ว
(`sendReservedLanes: 2, sendSpareLanes: 1` = มี primary lane เดียว เลือกอะไรไม่ได้เลย). ความต่างต่อ
connection เป็นของจริง: sendMessage เส้นดี 20.3–21.0ms เส้นอื่น 23–25ms บน IP เดียวกัน เพราะ edge ของ LINE
map แต่ละ connection ไป backend ต่างกัน

**Decision:** `transport/reply-scout.ts`

1. **วัด** — ยิง `getSquareChatStatus` (read-only, ผ่าน Square service เดียวกับ sendMessage) บังคับลง reply
   lane ทีละเส้น เส้นที่ข้อมูลเก่าสุดก่อน ทุก `replyProbeIntervalMs` (ค่าเริ่ม 1000). ไม่ยิงขณะมี reply อยู่บนสาย
   หรือภายใน 300ms หลัง reply เริ่ม. probe ที่ค้างบน lane ไม่ทำให้ lane นั้นนับว่า "busy" — reply วิ่งคู่กันบน HTTP/2
   ได้โดยไม่ต่อคิว จึงไม่ถูกดันไป lane ที่ช้ากว่า
2. **ยึดแล้วค่อยสลับ** — pin ย้ายเฉพาะเมื่อ lane อื่นเร็วกว่า ≥0.5ms (predicted = p50 + 35% ของ p95−p50) ติดกัน 2
   รอบ; pin แรกเลือกเมื่อวัดครบทุก lane แล้ว (startup ยิง preflight 3 รอบให้ครบก่อน ARMED). scout ข้าม veto
   ของ router ไม่ได้ (tail เกิน 27ms, bypass หลัง breach)
3. **หาเส้นใหม่** — lane ที่ไม่ได้ pin และช้ากว่าเส้นดีสุด ≥2ms ถูกเปิด connection ใหม่ (สูงสุด 1 ครั้ง/30s) ระหว่าง
   HEAD + probe 3 ครั้ง lane ถูกซ่อนจาก reply แล้วค่อยปล่อย — reply จริงไม่เคยจ่าย TCP/TLS handshake

**Consequences:**

- (+) ข้อ "เจอเส้นเร็วให้ค้างไว้ จนกว่ามีเส้นที่เร็วกว่าค่อยสลับ" เป็นพฤติกรรมที่มีเทสต์รองรับ
- (+) ทุก reply lane อุ่นอยู่ตลอด เพราะ probe คือ request จริง — สลับ lane ไม่มี cold path
- (+) pin ใหม่ของ `pin-legy-fast-ips.sh` ถูกรับเข้าเองผ่าน re-roll โดยไม่ต้อง restart
- (−) +1 request/วินาที/bot (เทียบกับ poll ~84/วินาที/ห้อง = เล็กน้อย)
- (−) ยังไม่ได้พิสูจน์ด้วย live A/B ว่า latency ของ getSquareChatStatus ต่อ lane ทำนาย sendMessage ต่อ lane
  ได้แม่น — ถ้าไม่แม่น ปิดได้ด้วย `replyProbeIntervalMs: 0` (กลับเป็น routing แบบเดิม 100%)

---

## ADR-0009 — Recovery ต้องไต่บันได ไม่ restart จาก alert เดียว

**วันที่:** 2026-09-10

**Context:** Playbook §16 เขียนไว้ตรง ๆ ว่า "การ restart service ทั้ง worker เป็น recovery ขั้นแรง ไม่ควรถูก
เรียกจาก latency spike เดี่ยว ๆ" — แต่ระบบ auto-heal ส่วนใหญ่ผูก handler ต่อ alert ตรง ๆ ซึ่งแปลว่า spike เดียวก็
restart ได้ และ restart ระหว่างงานคือแพ้ทั้งรอบ

**Decision:** `RecoveryPlanner` ตัดสินอย่างเดียว ไม่ลงมือทำ:

- ขั้นบันได 5 ขั้นตาม Playbook:
  `avoid-lane → reconnect-lane → rearm-poll → reconnect-session →
  restart-worker`
- alert แต่ละชนิดมี **entry rung** ของตัวเอง — latency regression เข้าที่ `avoid-lane` เท่านั้น
- ขึ้นทีละขั้น และต้องรอ cooldown (ค่าตั้งต้น 120s) ให้ขั้นปัจจุบันพิสูจน์ตัวเองก่อน
- alert ที่หนักกว่ากระโดดไป entry rung ของมันได้ทันที
- ลงบันไดต้องสะอาดติดกันหลายครั้ง (ค่าตั้งต้น 3) — snapshot ดีครั้งเดียวหลัง restart ไม่พิสูจน์อะไร
- `ceiling` ตั้งได้ ถ้าอยากให้คนอนุมัติขั้นสุดท้ายเอง

**Consequences:**

- (+) spike เดียวไปไม่ถึง restart ต่อให้เห็นซ้ำกี่รอบ (มีเทสต์ยืนยัน)
- (+) การตัดสินเป็น pure function ของ (alerts, clock) → เทสต์ครบทุกเส้นทางได้โดยไม่ต้อง reconnect จริง
- (−) worker ต้องเขียน executor ที่ map rung → action เอง ยังไม่มีในโค้ด (ทำพร้อม worker main loop)

---

## ADR-0008 — Release identity = build hash + config hash แยกกัน

**วันที่:** 2026-09-10

**Context:** Phases §19 ต้องการเทียบ first-response ราย version ถ้าใช้แค่ git commit เป็น id การแก้ config
อย่างเดียว (เช่น เปลี่ยน rate limit) จะไม่เปลี่ยน id → metric สองชุดถูกยำรวมกัน แล้ว A/B ตอบอะไรไม่ได้

**Decision:** `buildManifest()` คำนวณ hash สองตัวแยกกัน — `buildHash` (version+commit+runtime+deps)
และ `configHash` (config ที่ใช้จริง) — บน canonical JSON ที่ sort key ทุกชั้น. label ที่ติดไปกับ metric/log คือ
`<version>+<build12>/<config12>` และเติม `-dirty` ถ้า build จาก working tree ที่แก้ค้างไว้.
`assertDeployable()` ปฏิเสธ dirty build, ปฏิเสธ commit ที่เป็นชื่อ branch, ปฏิเสธ dependency ที่ไม่ pin

**Consequences:**

- (+) config เปลี่ยนอย่างเดียวก็ได้ id ใหม่ → เทียบ version ได้จริง
- (+) sort key ทุกชั้น แปลว่าจัดเรียงไฟล์ config ใหม่ไม่ถูกนับเป็น release ใหม่
- (−) ต้องส่ง config ที่ผ่าน `loadConfig` แล้วเข้ามา ไม่ใช่ raw env — raw env มีตัวแปรที่ไม่เกี่ยวปนอยู่

---

## ADR-0007 — Sender allowlist จับที่ ID เท่านั้น ไม่มีที่ให้ส่งชื่อเข้ามา

**วันที่:** 2026-09-10

**Context:** Phase 10 acceptance มีสองแถวที่ pipeline เดิมไม่ผ่านเลย เพราะยังไม่มี gate: "ผู้ส่งไม่อยู่ allowlist —
ไม่ตอบแม้ข้อความตรงคีย์" กับ "ชื่อเหมือนแอดมินแต่คนละ ID — ไม่เข้าใจผิด" display name ใน LINE ผู้ใช้ตั้งเองได้
ในห้องที่คนเยอะไม่มีใครทันสังเกต

**Decision:** `SenderAllowlist.allows(ownerId, senderId)` — interface **ไม่มีพารามิเตอร์สำหรับชื่อ** จึงไม่มี
ทางเขียนโค้ดผิดที่ call site. วางเป็น gate แรกสุดของ pipeline ก่อน dedupe ด้วย เพราะคนที่ไม่มีสิทธิ์ไม่ควร ถมพื้นที่
claim map ได้. owner ที่ไม่มี entry = ไม่จำกัด, owner ที่มี entry เป็น list ว่าง = ปิดสนิท — สองอย่างนี้ต้องไม่ยุบรวมกัน

**Consequences:**

- (+) เคส impersonation แก้ที่ระดับ type ไม่ใช่ระดับ discipline
- (+) bot ที่ยังไม่ตั้ง allowlist พฤติกรรมเหมือนเดิมทุกอย่าง (`ALLOW_ANY_SENDER`)
- (−) รายชื่อ sender id จริงยังเป็น TODO ใน `docs/phase-0-winner-definition.md` — ต้องได้ข้อมูลเกมก่อน

---

## ADR-0006 — ทิ้ง ESLint/Prettier/Bun tooling, ใช้ `deno fmt` + `deno lint` และผ่อน compilerOptions

**วันที่:** 2026-09-10

**Context:** หลังย้ายไป Deno (ADR-0005) tooling เดิม (bun test, eslint, prettier, tsconfig) ซ้ำซ้อนกับของ
Deno และ `deno check` type-check **ทั้ง graph รวม vendored LINEJS** ด้วย `compilerOptions` ของ root →
`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noImplicitReturns` ทำให้เกิด error 714
จุดในโค้ด LINEJS

**Decision:**

- ลบ `bunfig.toml`, `eslint.config.mjs`, `.prettierrc`, `package.json`, `tsconfig*.json`, `bun.lock`
- gate = `deno fmt --check` + `deno lint` + `deno check` + `deno test --coverage`
- `compilerOptions` เหลือ `strict` + `noImplicitOverride` + `noFallthroughCasesInSwitch` (ตัด 3 flag ที่
  LINEJS ไม่ผ่าน)
- ESLint rule เชิงโครงสร้างที่หายไป (**ฟังก์ชัน ≤20 บรรทัด, ไฟล์ ≤400/800, ห้าม raw `new Error`, max-depth
  4**) → กลายเป็น **review checklist** ใน `CLAUDE .md` §4/§11 ไม่ automate

**Consequences:**

- (+) toolchain เดียว ไม่มี node_modules ของ dev tooling
- (−) โค้ดของเราเขียนตาม flag ที่เข้มกว่าแล้ว แต่ **ไม่มีตัวบังคับอัตโนมัติ** ต่อจากนี้ — ต้องระวังตอน review
- (−) `deno coverage` ยังไม่มี `--fail-under` → coverage เป็น report ไม่ใช่ hard gate (ปัจจุบัน ~97% line)

---

## ADR-0005 — Runtime ของ worker = Deno; vendor LINEJS เป็น git submodule

**วันที่:** 2026-09-10

**Context:** LINEJS ที่ commit ที่ pin (`ef6c3d9`, tag v3.4.2) เป็น **Deno-first**: `deno.json` import
map (`jsr:`/`npm:` specifiers), `.ts` extension imports, transport พึ่ง `npm:undici@^7`, และ source
import bare specifier ที่ไม่มีใน npm (`@evex/loose-types`, `@evex/linejs-types`, `@std/assert`) Bun/Node
ต้องแปลง import map + shim JSR + strip-types เอง — เปราะและไม่ตรงกับ runtime ที่ LINEJS ทดสอบ

**Decision:**

- worker รันบน **Deno 2.9.6**
- vendor LINEJS เป็น **git submodule** `vendor/linejs` pin ที่
  `ef6c3d9f70dd41fa51053615d47f071f58cf8db3`
- root `deno.json` ประกาศ
  `workspace: ["./vendor/linejs/packages/linejs", "./vendor/linejs/packages/types"]` → ชื่อ package
  ภายใน (`@evex/linejs`, `@evex/linejs-types`) resolve ได้ **โดยไม่ต้อง shim**
- ย้าย test 14 ไฟล์ `bun:test` → `@std/testing/bdd` + `@std/expect` (ผ่านครบ)
- โค้ด LINEJS-specific อยู่ใต้ `src/adapters/linejs/` เท่านั้น — core/pipeline ยัง connector-agnostic

**หลักฐาน:** `deno run` import `@evex/linejs` สำเร็จ, export ครบ (`Client`, `loginWithQR`,
`loginWithPassword`, `loginWithAuthToken`, Talk/Square classes), `deno check` ผ่าน

**Consequences:**

- (+) ไม่มี shim, ตรงกับ runtime ที่ LINEJS พัฒนา/ทดสอบ
- (+) submodule pin ทำให้ benchmark เทียบย้อนหลังได้ (ต่อยอด ADR-0002)
- (−) ต่างจาก ADR-0001 ที่เขียนว่า Bun — **ADR นี้ override เฉพาะ runtime ของ worker** (Go control plane /
  React / SQLite ยังตามเดิม)
- (−) `deno fmt`/`deno lint` ต้อง scope path เอง ไม่งั้นไปแก้ไฟล์ใน submodule

---

## ADR-0004 — env validation ใช้ hand-rolled `Reader`, ไม่ใช้ Zod (จนถึง Phase 1b)

**วันที่:** 2026-09-10

**Context:** `CLAUDE .md` §4 แนะให้ validate ด้วย schema/Zod ทุก boundary. env ของ worker เป็น flat
key-value ~10 ตัว (int/number/enum) ไม่ nested

**Decision:** `src/config/env.ts` ใช้คลาส `Reader` (~40 บรรทัด, zero-dep) — ตรวจ type/range/enum, รวม
error ทุกตัว, fail-fast โยน `ConfigError` typed, coverage 100%. **ยังไม่เพิ่ม Zod**

**เมื่อไรจึงดึง Zod เข้ามา:**

- **Phase 1b** — parse LINE event payload (nested, untrusted, ซับซ้อน) ที่ adapter boundary
- **Phase 7** — versioned config snapshot จาก Go control plane ผ่าน IPC
- เมื่อ `packages/contracts` ต้องมี runtime schema แชร์กับ adapter

**Consequences:**

- (+) ไม่มี dependency บนแพ็กเกจ hot path, gate เบา
- (−) โค้ด validate สองสไตล์ชั่วคราว (`Reader` สำหรับ env, Zod สำหรับ payload ตอน 1b) — ยอมรับได้

---

## ADR-0003 — Phase 1 correctness core เป็น pure logic + mock, ไม่แตะ LINE

**วันที่:** 2026-09-10

**Context:** decision doc สั่งลำดับ `Phase 0 → Correctness core → Measurement` ก่อนแตะความเร็ว
Correctness core (dedupe/claim, rule cache, rate limiter, job identity, timeout, error
classification) เป็น logic ล้วน ทดสอบได้เต็มที่โดยไม่ต้องมีบัญชี LINE

**Decision:** เขียน core ทั้งหมดใน `apps/worker/src/core` + `src/lib` + `src/errors` เป็น deterministic
functions ที่รับ clock/config ผ่าน DI, unit test ครอบ edge cases
(null/empty/boundary/expiry/concurrent-claim), coverage ≥ 80%. Connector จริงเลื่อนไป Phase 1b

**Consequences:**

- (+) gate ผ่านได้เร็ว, ไม่ต้องรอ credential, regression net พร้อมก่อนแตะ transport
- (+) `Clock` DI ทำให้ทดสอบ TTL/expiry ได้โดยไม่ใช้ `sleep`
- (−) ยังไม่พิสูจน์ว่า contract ตรงกับ LINEJS behavior จริง — Phase 1b ต้อง verify `claimIncomingMessage` key
  shape เทียบ event จริงจาก push + poll

---

## ADR-0002 — Pin LINEJS revision + Bun version

**วันที่:** 2026-09-10

**Context:** Playbook ไม่ระบุ revision; Phases pin `ef6c3d9f70dd41fa51053615d47f071f58cf8db3`
เอกสารทั้งสอง benchmark คนละ revision ไม่ได้

**Decision:**

- LINEJS: pin commit `ef6c3d9f70dd41fa51053615d47f071f58cf8db3` (`github:evex-dev/linejs`) —
  ยืนยัน/อัปเดตใน Phase 1b
- Bun: `1.3.14` (ที่ติดตั้งบนเครื่อง dev ปัจจุบัน) — lock ใน `package.json` engines + `.tool-versions` เมื่อขึ้น
  server
- บันทึก OS/arch ใน version manifest ของทุก benchmark (dev = Windows 11 x64, prod = Linux)

**Consequences:**

- (+) ผล benchmark เทียบย้อนหลังได้
- (−) ต้องมีขั้นตอน review ก่อน bump LINEJS; E2EE cold JIT +13ms วัดบน Windows อาจต่างจาก Linux (Playbook
  §8.2)

---

## ADR-0001 — Stack: Bun + Go + LINEJS + SQLite (self-hosted) ไม่ใช่ Next.js/Supabase/Vercel

**วันที่:** 2026-09-10

**Context:** `CLAUDE .md` (template v2.0.0) กำหนด default stack = Next.js 15 + Supabase + Vercel +
shadcn/ui แต่เป้าหมายโปรเจกต์คือ LINE selfbot ที่ต้องการ owned HTTP/2 lane pool, sub-23ms send, race หลาย
inbound source, ไม่มี cron restart, self-heal ราย lane — ทำบน serverless/managed hosting ไม่ได้
(Playbook §9, §16)

**Decision:** ยึด `LINE-BOT-APPROACH-DECISION-TH.md`:

- hot path = **Bun + TypeScript + LINEJS** worker แยกต่อบัญชี, self-hosted, `systemd`
- control plane = **Go** (`net/http`) — auth/users/ownership/supervisor/metrics, ไม่อยู่ระหว่างคีย์กับคำตอบ
- OA = **Go** worker + Messaging API
- UI = **React + TypeScript** (admin dashboard + user mobile)
- storage = **SQLite (WAL)** local — config/session metadata/metrics rollups
- `CLAUDE .md` **process rules ยังบังคับใช้** (phase gate, DoD, conventional commits, TS strict, ฟังก์ชัน
  <20 บรรทัด, ไฟล์ <400, Zod ที่ boundary, no magic number, coverage ≥80%) — เฉพาะส่วน **stack/hosting**
  ที่ override

**Consequences:**

- (+) ควบคุม transport/connection ได้เต็มที่ตามที่ Playbook พิสูจน์แล้ว
- (+) cost ต่ำ (self-hosted VPS) ไม่มี per-invocation billing
- (−) ต้องดูแล infra เอง (systemd, deploy/rollback, monitoring) — Phase 11
- (−) Supabase Auth/RLS ไม่ได้ใช้ → ต้อง implement LINE Login (auth code + PKCE) + ownership/RBAC ที่ Go
  control เอง (Phase 7)
