# แผนพัฒนา LINE Bot เพื่อชนะด้วยคำตอบแรก: สถาปัตยกรรม เทคนิค และ Phase

วันที่ค้นคว้า: 10 กันยายน 2026  
สถานะ: ข้อกำหนดและแผนพัฒนาอ้างอิงเอกสาร/ซอร์สโค้ด ยังไม่ได้ทดสอบกับบัญชี LINE หรือวัด latency จริง  
เทคโนโลยีหลัก: Go + Bun + React + SQLite + LINEJS สำหรับ Talk/OpenChat

## 1. เป้าหมายที่ยืนยันจากผู้ใช้

เมื่อผู้ส่งที่กำหนดโพสต์คีย์ของงานใหม่ บอทต้องรับรู้และส่งคำตอบที่ถูกต้องให้ถึงจุดตัดสินก่อนคู่แข่ง เพราะงานนั้นมีผู้ชนะเพียงคนแรก การส่งครั้งที่สอง สาม สี่ หรือห้าได้เร็วภายหลัง ไม่ได้ชดเชยคำตอบแรกที่แพ้ไปแล้ว

นี่ **ไม่ใช่ข้อกำหนดให้ระบบส่งได้เพียงหนึ่งข้อความ** และไม่ใช่การแข่ง throughput หรือจำนวนข้อความต่อวินาที แต่เป็นการเพิ่มโอกาสที่ **คำตอบแรกที่ถูกต้องของแต่ละงาน** จะเป็นคำตอบที่ผู้จัดงานรับก่อน

สิ่งที่ต้อง optimize ตามลำดับ:

1. คำตอบแรกหลังรอคีย์ต้องพร้อมส่งโดยไม่มีการเตรียมระบบกะทันหัน
2. รับข้อความที่มีคีย์ครบเร็วกว่าคู่แข่ง
3. ตรวจห้อง ผู้ส่ง และเงื่อนไขได้ถูกต้องโดยเสียเวลาน้อยที่สุด
4. ส่งคำตอบผ่านเส้นทางที่ทำให้จุดตัดสินรับได้เร็วที่สุด
5. หลังงานจบ รักษาความพร้อมสำหรับงานใหม่ทันที

ความเร็วที่ต้องรายงานแยกกัน ได้แก่ เวลาในเครื่องเรา เวลา API ตอบรับ เวลาข้อความปรากฏ และผลชนะงาน ห้ามใช้ค่าใดค่าหนึ่งแทนทั้งหมด

## 2. ข้อเลือกทางสถาปัตยกรรม

เริ่มด้วย **Bun + LINEJS worker แยกตามบัญชี** ให้รับ–ตรวจผู้ส่ง–จับคีย์–ส่งอยู่ใน process เดียวกัน ส่วน Go ทำ control API, user management, supervisor และ dashboard backend; React ทำหน้า admin/user; SQLite เก็บ config และประวัติ

OA ใช้ Go worker กับ Messaging API แยกช่องทาง ขณะที่ Talk/OpenChat ใช้ client connector ของ LINEJS ไม่บังคับให้ผ่าน OA webhook

การตัดสินใจนี้เป็น baseline สำหรับพิสูจน์ ไม่ใช่ข้ออ้างว่า Bun หรือ LINEJS เร็วที่สุดแล้ว ถ้า runtime/transport ของ Bun กับ revision ที่เลือกไม่ผ่านการทดสอบ push ให้เทียบ Node.js เป็นตัวควบคุม และบันทึกเหตุผลก่อนเปลี่ยน production stack

ยังไม่ควร port ทั้งระบบไป Go จนกว่าจะพบจาก profiling ว่า local processing เป็นคอขวดจริง การเปลี่ยนภาษาไม่สามารถลบเวลาเดินทางเครือข่ายหรือการรอให้ LINE ส่ง event ได้

## 3. ผลค้นคว้ารอบใหม่ที่เปลี่ยนลำดับงาน

ตรวจ LINEJS โดยอ้างอิง revision `ef6c3d9f70dd41fa51053615d47f071f58cf8db3` จาก GitHub ณ เวลาค้นคว้า ต้อง pin revision และ lock dependencies ตอนสร้างต้นแบบ ห้ามใช้ `main` แบบลอยในผล benchmark

### 3.1 OpenChat push ไม่ได้แปลว่ามีเนื้อหาข้อความครบอยู่ในทุก push

ใน `_OnPushResponse()` เมื่อเป็น Square service type 3 ซอร์สเรียก `square.fetchMyEvents()` ก่อนนำ events เข้า stream ขณะที่ sign-on response มีอีกเส้นทางที่บรรจุ events ได้อยู่แล้ว ดังนั้นต้องจับ trace แยกตามชนิด event จริง ห้ามสรุปว่ารับ push แล้วเข้า matcher ได้ทันทีทุกกรณี [S1]

ผลต่อแผน: เพิ่มจุดวัด **notification → fetch message → decode** และเตรียม connection ที่ใช้ fetch ให้พร้อมด้วย ถ้า additional fetch เป็นขั้นตอนจำเป็น การลด matcher ลงอีกไม่กี่ไมโครวินาทีจะไม่ลบ network round trip นี้

### 3.2 Listener คนละตัวให้ต้นทุนต่างกันมาก

`client.listen()` เชื่อมกับ Talk/Square streams; แต่ `SquareChat.listen()` มี polling loop ที่พัก 1,000 ms หลังรอบปกติ และพัก 2,000 ms เมื่อเกิด error ส่วน listener แบบเก่าบางตัวมี interval ของตัวเอง [S2][S3][S4]

ผลต่อแผน: ใช้ push เป็น baseline ที่ต้องทดสอบก่อน เส้นทางที่พัก 1 วินาทีไม่ผ่านเป้า inbound 11 ms สำหรับงานที่คีย์อาจมาระหว่างพัก การลบ sleep แล้ว poll ไม่หยุดไม่ใช่หลักฐานว่าจะเร็วกว่า ต้องทดสอบวิธีรับที่บริการรองรับและผลต่อ tail latency

### 3.3 ก่อนส่งมี sequence allocation และ storage await

`getReqseq()` มี queue, อ่านค่าเริ่มต้นจาก storage และรอ `storage.set()` ก่อนคืนหมายเลข; Square sender เรียกฟังก์ชันนี้ก่อนสร้างคำขอ [S5][S6]

ผลต่อแผน: ต้องตรวจ storage implementation ที่ใช้งานจริง ถ้าเป็น persistent I/O อาจอยู่บนเส้นทางคำตอบแรก ถ้าเป็น memory storage ต้นทุนจะต่างกัน ห้ามกล่าวว่าทุก config ต้องเขียน disk ทุกข้อความ

### 3.4 Talk มี compact sender และ fallback ที่ต้องแยกจาก OpenChat

Talk มี `sendCompactMessage()` และ fallback ไป E2EE เมื่อพบเงื่อนไขที่กำหนด รวมทั้ง refresh-token retry ในบาง error; Square มี sender ของตนเอง [S7][S6]

ผลต่อแผน: ทดสอบ compact เฉพาะช่องทางและข้อความที่รองรับ เตรียมสถานะ encryption/token ก่อนช่วงงาน เพื่อไม่ให้คำตอบแรกเสียหนึ่งรอบไปกับ fallback ไม่ปิด encryption เพื่อหวังลดเวลา

### 3.5 Runtime ใช้ transport ไม่เหมือนกัน

ซอร์สมี Node dispatcher แยก RPC กับ PUSH และเลือกให้ PUSH รองรับ HTTP/2; Bun/Deno ใช้เส้นทาง fallback/native หรือ custom transport ตาม config [S5][S8]

ผลต่อแผน: ต้องทดสอบ PUSH handshake, streaming, ALPN และ reconnect บน Bun revision จริง คำว่า library รองรับ Bun ไม่ได้ยืนยันว่า transport ทุกแบบมี latency หรือความเข้ากันได้เท่ากัน

### 3.6 ความพร้อมก่อนคีย์มาเป็นเรื่องจริงในซอร์ส

เส้นทางสร้าง push connection มี timer รอเริ่มต้น และ polling manager มีช่วงพัก reconnect; ค่าเหล่านี้เป็นต้นทุนตอน setup/recovery ไม่ใช่ delay ที่บวกทุกข้อความใน steady state [S9][S4]

ผลต่อแผน: ต้องเข้าสถานะพร้อมจาก handshake/subscription ที่ยืนยันแล้ว ไม่ใช่เริ่ม connection เมื่อคีย์มาถึง หรือถือว่า `listen()` คืนค่าแล้วเท่ากับพร้อม

## 4. ทำไม ping ช้ากว่าแต่ยังชนะได้

ตัวแปรที่ตัดสินคือเวลาที่คำตอบถูกต้องถึงระบบรับงาน ไม่ใช่ ping ตัวเดียว

```text
เวลาถึงจุดตัดสินโดยประมาณ
  = เวลาที่ LINE ปล่อย event ถึงเส้นทางเรา
  + เวลารับ notification / ดึงเนื้อหา / decode
  + เวลาตรวจเงื่อนไขและจัดเตรียมคำขอ
  + เวลารอส่งในเครื่องและบนเครือข่าย
  + เวลาที่ LINE และระบบรับงานประมวลผล
```

ตัวอย่างเชิงอธิบายเท่านั้น ไม่ใช่ผลทดสอบ: A รับคีย์ช้ากว่า B 20 ms แต่ส่งเร็วกว่า 8 ms ก็ยังอาจแพ้ B 12 ms บอทที่ ping ต่ำแต่ต้องเปิด TLS ใหม่หรือรอ polling อาจแพ้บอท ping สูงกว่าที่พร้อมรับและส่งอยู่แล้ว

อีกกรณีคือ A ส่งถึง LINE ก่อน แต่ได้รับ response กลับช้ากว่า B จึงห้ามใช้ลำดับ ACK ที่เครื่องสองเครื่องเห็นเป็นหลักฐานลำดับผู้ชนะ

ต้องระบุจุดตัดสินจริงตั้งแต่ Phase 0:

- ถ้าระบบปลายทางมีผลรับงาน/ผู้ชนะ ให้ใช้ผลนั้นเป็นหลัก
- ถ้าดูจากข้อความที่แอดมินเห็น ให้ใช้ observer ที่เกี่ยวข้องเป็นหลักฐานรอง พร้อมระบุข้อจำกัด
- ถ้าไม่มีข้อมูลผู้ชนะ ให้รายงานเฉพาะ latency และผลที่สังเกตได้ ไม่อ้าง win rate จริง
- message ID และ timestamp ต้องไม่ถูกสมมติว่าเรียงลำดับการรับงานได้โดยไม่มีหลักฐาน

## 5. เป้าหมายเวลาและนิยามการวัด

| ค่า | จุดเริ่มและจุดจบ | เป้าหมายผู้ใช้ |
|---|---|---:|
| Inbound | event timestamp ที่บริการให้ → ได้ bytes เนื้อหาข้อความครบเพื่อ decode | ≤11 ms |
| Our processing | bytes เนื้อหาครบ → submit คำขอส่งเข้า transport รวม decode, filter, matcher, sequence, serialize และคิวช่วงนี้ | ≤0.5 ms |
| LINE send | transport submission → decode ผลตอบรับสำเร็จ รวม pool wait/write ถ้าวัดต่ำกว่านั้นไม่ได้ | ≤19 ms |
| Event-to-ACK | event timestamp → decode ผลตอบรับสำเร็จ | ≤32 ms |
| LINE RTT | probe ไป–กลับที่ระบุ host, protocol, connection และวิธีวัด | ≤26 ms |
| First-response win rate | งานที่ยืนยันว่าชนะด้วยคำตอบแรก / งานที่เข้าเงื่อนไขและมีผลทราบ | เพิ่มให้สูงที่สุด |

11 + 0.5 + 19 = 30.5 ms เหลือ 1.5 ms ในงบ 32 ms ตัวเลขนี้เป็น budget ไม่ใช่ผลที่พิสูจน์แล้ว ถ้า RTT 26 ms เป็นของ transaction เดียวกันจริง ต้องตรวจความสอดคล้องกับ send 19 ms ไม่บวก RTT ซ้ำและไม่เทียบคนละ endpoint เสมือนเป็นค่าเดียวกัน

Inbound เป็น event delivery delay โดยประมาณ ไม่ใช่ one-way network latency บริสุทธิ์ รวมการปล่อย event, notification-triggered fetch และงานภายในก่อนมี payload ด้วย ต้องแสดง clock uncertainty; ถ้าไม่มี timestamp ที่ใช้ได้ให้เป็น `unknown` ไม่ใส่ 0

### จุด trace ที่ต้องมี

```text
source_event_time      timestamp จากบริการ ถ้ามี
notice_rx              ได้ push notification (ถ้ามี)
fetch_submit           เริ่มดึง message หลัง notice (ถ้าจำเป็น)
message_bytes_ready    ได้ payload ครบ ก่อน decode ของแอป
decoded                decode/decrypt และระบุตัวตนได้แล้ว
matched                กฎเลือกคำตอบแล้ว
sequence_ready         ได้ request sequence แล้ว
transport_submit       ส่งคำขอเข้าสู่ transport
write_observed         จุด write ถ้า runtime เปิดให้วัด
ack_complete           อ่านและตรวจผลตอบรับครบ
observer_seen          observer เห็นข้อความ ถ้ามี
winner_confirmed       ผลตัดสินของระบบงาน ถ้ามี
```

ใช้ monotonic clock สำหรับช่วงเวลาใน process เดียวกัน; ใช้ wall clock ที่ sync พร้อมค่าคลาดเคลื่อนสำหรับข้ามเครื่อง ห้ามหัก monotonic timestamps ของคนละ process/host โดยตรง

ถ้าวัดได้เฉพาะ callback `square:message` ต้องตั้งชื่อว่า `callback_to_submit` เพราะ library อาจ decode/fetch มาก่อนแล้ว ไม่ใช้แทน Our processing ทั้งหมด

รายงาน p50/p95/p99/max, sample count, timeout, missing-event, failure และ threshold exceedance แยกกัน ค่า p99 ของแต่ละส่วนบวกกันไม่ได้เป็น p99 ของผลรวม ต้องคำนวณผลรวมต่อ event แล้วสร้าง distribution ใหม่

## 6. โครงสร้างโปรแกรมและขอบเขต framework

```text
LINE Talk/OpenChat
  ↕ persistent receiver + message-fetch + sender
Bun / LINEJS account worker
  ├─ local verified sender/room index
  ├─ compiled keyword rules + reply templates
  ├─ per-job state + event dedupe
  ├─ sequence/session state
  ├─ readiness + warm controller
  └─ async metrics/config IPC
                 ↕
Go control service / supervisor
  ├─ login + users + ownership
  ├─ lifecycle/configuration
  ├─ SQLite persistence/rollups
  └─ REST + SSE → React admin / mobile user

LINE OA → Go OA worker → Messaging API
```

| ส่วน | ตัวเลือกเริ่มต้น | ขอบเขต |
|---|---|---|
| Selfbot worker | Bun + TypeScript + pinned LINEJS | hot path ใน process เดียว |
| Control API | Go net/http + ServeMux | config/auth/metrics ไม่อยู่ระหว่างคีย์กับคำตอบ |
| OA worker | Go net/http | webhook + reply/push ตามบริบท |
| Frontend | React + TypeScript | admin/user แยก route และ bundle |
| Frontend build | Bun bundler | production assets |
| Styling | CSS Modules + CSS variables | mobile-first, dependency น้อย |
| Storage | SQLite + SQL migrations | config/session metadata/metrics |
| Live dashboard | SSE + REST | ส่ง snapshot ทุก 500–1,000 ms เป็นค่าเริ่มต้น |
| Process supervision | systemd บน Linux | แยก restart/resources ตามบัญชี |
| Local control IPC | Unix socket หรือ framed pipe | ส่ง config/metrics แบบ async |

React/Bun build ไม่ได้ช่วย network ไป LINE โดยตรง ประโยชน์คือจัด UI ได้โดยไม่รบกวน worker; SQLite ต้องไม่เป็น request-response dependency ในช่วงจับคีย์ก่อนส่ง

บอทที่แชร์ LINE account เดียวกันยังแชร์ session, sequence และข้อจำกัดของบัญชีนั้น ควรจัดเป็นหลาย rule-set ภายใต้ account worker เดียว การแยกอิสระจริงต้องใช้บัญชี/session ที่แยกได้จริง

## 7. เทคนิคที่จะใช้และเงื่อนไขเลือก

ลำดับ A = ทำใน baseline, B = A/B test แล้วเลือกผลชนะ, C = ทดลองขั้นสูงเมื่อ profiling มีหลักฐาน ตัวเลขประโยชน์ต้องได้จากการวัด ไม่กำหนดว่าประหยัดได้กี่ ms ล่วงหน้า

| เทคนิค | ลำดับ | เหตุผล/เงื่อนไข |
|---|---|---|
| เปิด receiver และยืนยัน subscription ก่อนช่วงงาน | A | ลด cold-start ของคำตอบแรก |
| ใช้ listener ที่ไม่มี intentional polling sleep | A | ไม่พลาดคีย์ระหว่างรอ timer |
| เตรียม message-fetch connection ของ OpenChat | A | push บางแบบต้อง fetch ต่อ |
| คง sender connection ที่ตรวจ reuse ได้ | A | ลด DNS/TCP/TLS setup |
| เตรียม rules, IDs, reply ใน RAM | A | ไม่ดึง config/profile ก่อนตอบ |
| ตรวจ sender ด้วย immutable ID | A | ตัดข้อความไม่เกี่ยวข้องเร็วและไม่จับชื่อผิด |
| บันทึก log/metrics แบบไม่ blocking | A | ลด disk/console delay |
| ไม่มี Bun → Go → Bun RPC ใน hot path | A | ลด IPC และ serialization |
| สร้าง response template ล่วงหน้า | A | ทำเฉพาะ field ที่ไม่เปลี่ยน |
| โหลด key/session state ก่อน arm | A | ลด on-demand fetch/refresh |
| เลือก region/provider จาก first-response test | B | เส้นทาง ingress/egress ต่างกัน |
| IPv4 เทียบ IPv6 | B | ใช้เฉพาะ address family ที่รองรับจริง |
| HTTP connection/protocol policy | B | ตรวจ compatibility และ ALPN แยก PUSH/RPC |
| แยก RPC ส่งจากงาน maintenance | B | ลด pool contention ถ้า transport คุมได้ |
| Preconnect ก่อนเวลา | B | เฉพาะ transport/pool ที่จะใช้จริง |
| Sequence allocation ที่ลด storage wait | B | ต้องผ่าน invariants และ restart test |
| Sender แบบ compact ของ Talk | B | ไม่อนุมานว่าใช้กับ Square ได้ |
| ข้าม object wrapper ที่ไม่จำเป็น | B | หลัง decode ที่ถูกต้อง พร้อม regression test |
| ลด copying/allocation ใน decoder/serializer | B | profile ก่อน; ไม่แก้ความหมาย protocol |
| เลือก crypto path ให้ถูกตั้งแต่แรก | B | ลด fallback โดยรักษา E2EE ที่จำเป็น |
| CPU allocation/affinity และแยกงานหนัก | B | ลด scheduling jitter; ระวัง IRQ contention |
| TCP_NODELAY เมื่อคุม socket ได้ | B | ตรวจ effective option ไม่เดาว่า fetch เปิดให้ตั้ง |
| Receiver หลายเส้นทางรวมเข้าผู้ส่งเดียว | C | ต้องได้รับ events ได้จริงและไม่ทำ session เสีย |
| Read-only fetch race ที่จำกัดขอบเขต | C | เฉพาะ API semantics ที่พิสูจน์ว่าทำได้ |
| Prepared request slot แบบใช้ครั้งเดียว | C | sequence/key/nonce ถูกต้องและไม่ reuse |
| NIC IRQ/RSS/coalescing/NAPI tuning | C | เฉพาะเครื่องและ runtime รองรับ |
| Port hot path ทั้งเส้นทางไป Go | C | หลัง Bun local cost เป็นคอขวดที่พิสูจน์แล้ว |

### 7.1 Warm ให้ถูก connection

Bun มี `fetch.preconnect()` และ connection pooling แต่ไม่ควรสรุปว่ามัน warm Node dispatcher, custom transport หรือ PUSH stream อีกชุดหนึ่งด้วย ต้องตรวจ pool identity และ connection reuse จาก trace [S10]

Warm ก่อนคีย์มา: DNS/TCP/TLS, session validation ตามวิธีที่รองรับ, receiver subscription, lazy imports, matcher, template และ state ที่ไม่เปลี่ยน ให้เวลาระบบ settle ก่อน critical window

Warm ระหว่างรอ: ใช้ heartbeat ตาม protocol และ maintenance ที่จำเป็นในจำนวนจำกัด วัดว่า warm รบกวน message-fetch/sender หรือไม่ ไม่จำเป็นต้องส่งข้อความทดสอบเข้าห้องงานเพื่ออุ่นเครื่อง

Connection มีชีวิต, subscription ใช้ได้ และ sender พร้อม เป็นคนละสถานะ ห้ามใช้เพียง TCP connect สำเร็จเป็น readiness ทั้งหมด

### 7.2 ลด storage wait โดยไม่ทำ sequence พัง

แนวทางทดลองเรียงจากเสี่ยงน้อยไปมาก:

1. เริ่มด้วย storage เดิมและจับเวลาเฉพาะ `getReqseq()`
2. ทำ initialization ก่อน arm และแยก maintenance ไม่ให้แย่ง sequence queue
3. พิจารณา durable reservation ของ sequence range แล้ว allocate ใน RAM เฉพาะเมื่อพิสูจน์ว่าช่องว่าง sequence ใช้ได้กับ protocol นี้
4. สำรอง high-watermark ให้สำเร็จก่อนใช้งาน range; restart ต้องข้ามช่วงที่จองแล้ว ไม่เริ่มเลขเดิม
5. ถ้า semantics ไม่ยืนยัน ให้ใช้ allocator เดิมหรือออกแบบทางเลือกที่พิสูจน์ได้ ไม่แลกความถูกต้องกับ benchmark

ห้าม reuse ciphertext/nonce หรือ request sequence เพื่อหวังลด latency การเตรียมล่วงหน้าควรเริ่มจาก room/metadata/template/key lookup; การเตรียม encrypted payload ต้องมี slot แบบใช้ครั้งเดียวและ invalidate เมื่อ key/session เปลี่ยน

### 7.3 Receiver หลายเส้นทางช่วยได้เมื่อครบเงื่อนไข

ข้อเสนอทดลอง: receiver ที่ได้รับอนุญาตหลายตัวส่ง event เข้าผู้ส่งกลางที่เตรียมพร้อม ให้ผู้ส่งเลือก event ที่ถูกต้องซึ่งมาถึงก่อน ตรวจ job/event ID แล้ว dispatch โดยไม่รอรวมผลทั้งหมด

เงื่อนไข: บัญชี/ห้องต้องรองรับ receiver ดังกล่าว, event identity เทียบกันได้, ไม่ละเมิดการแยกข้อมูลผู้ใช้ และค่า forward + verification ต่ำกว่าความได้เปรียบขาเข้า ห้ามเปิดหลาย session ของบัญชีเดียวโดยสมมติว่าจะไม่เตะกันออก

การตั้ง receiver หลาย region ไม่ได้เร็วขึ้นเสมอ ถ้าแต่ละตัวส่งเองจะเกิดปัญหาคำตอบซ้ำ/session/sequence และการแข่ง lock ข้าม region อาจเพิ่ม latency จึงเริ่มจาก single sender owner หรือเลือกทั้ง worker region ก่อนช่วงงาน

Read-only racing ใช้ได้เฉพาะเมื่อ operation ไม่เปลี่ยน state ที่แข่งกันและทำงานซ้อนได้จริง ต้องตรวจ API ก่อนทดลอง ส่วนการยิงคำตอบหลายเส้นทางพร้อมกันไม่ใช่ baseline เพราะยังไม่มีหลักฐาน deduplication semantics ที่ปลายทาง

### 7.4 เทคนิคที่ไม่ควรเปิดเพียงเพราะชื่อดูเร็ว

- เพิ่ม bandwidth ไม่ได้แปลว่า small-message latency ลดลง
- CDN, proxy หรือ relay ช่วยเฉพาะเมื่อเส้นทางรวมที่วัดได้ดีขึ้น ไม่ใช่ทุกกรณี
- Placement group ช่วยเครือข่ายระหว่าง instance ที่จัดกลุ่ม ไม่ได้วางเครื่องเราใกล้ LINE โดยอัตโนมัติ [S11]
- Busy-poll/NAPI มีข้อกำหนด kernel/driver/socket และกิน CPU ต้องทดลองเฉพาะเมื่อ scheduling/NIC เป็นปัญหา [S12]
- TCP_NODELAY เป็น socket option ต้องตรวจสิ่งที่ runtime ทำจริง; ไม่ใช่ HTTP header [S13]
- การอ่าน bytes เข้าหน่วยความจำยังไม่แปลว่าได้ message ที่ตรวจสอบครบ ต้องไม่ตอบจาก frame ที่ยังไม่ครบหรือข้อมูลที่ยังไม่ผ่าน integrity/decryption
- TLS 1.3 session resumption อาจช่วย reconnect แต่ 0-RTT มี replay implications และต้องรองรับทั้งสองฝั่ง ไม่ใช้ส่ง claim ที่มีผลข้างเคียงโดยพลการ [S14]
- ไม่เดา endpoint, ปลอม timestamp, ปิด TLS verification, เดาคำตอบล่วงหน้าก่อนมีคีย์จริง หรือส่งรัวเพื่อใช้แทนการลด latency
- ไม่เปลี่ยน congestion control, socket buffers, IRQ และ CPU governor พร้อมกันจนระบุผลไม่ได้

## 8. วงจรของบอทและวงจรของงาน

### Worker readiness

```text
STARTING → AUTHENTICATED → SYNCING → WARMING → ARMED
                                              ↓
                       DEGRADED ← connection/session/problem
                           ↓
                        REPAIR → SYNCING → WARMING → ARMED
```

ARMED ต้องมี session ใช้งานได้, receiver พร้อมรับ, rules โหลดครบ, sender พร้อม และไม่มี backlog ที่ทำให้ข้อมูลเก่าเป็นงานใหม่ หากยังยืนยันไม่ได้แสดง DEGRADED พร้อมเหตุผล

### Per-job lifecycle

```text
WAITING → ELIGIBLE_TRIGGER → FIRST_RESPONSE_DISPATCHED
                                     ↓
                            WON / LOST / UNKNOWN
                                     ↓
                      เก็บผลและพร้อมประมวลงานถัดไป
```

นี่เป็น state ต่อ job ไม่ใช่ global lock ที่บังคับให้งาน B รอผล ACK/ผู้ชนะของงาน A ทุกกรณี ถ้าช่องทางอนุญาต ให้ส่งงานใหม่ที่เป็นอิสระได้โดยมี concurrency แบบจำกัดและ sequence ถูกต้อง

การกัน webhook/event ซ้ำทำเพื่อไม่เข้าใจว่า event เดิมเป็นงานใหม่ ไม่ใช่ตีความว่าคีย์เดียวกันในอนาคตห้ามตอบ ถ้างานมี ID ให้ใช้ ID; ถ้าไม่มี ให้กำหนดวิธีแยกรอบจาก source message ID, ผู้ส่ง, ห้อง และกฎปิดงาน ไม่ hash เฉพาะ keyword แล้วปิดทิ้งตลอด

หลังยืนยันว่าแพ้แล้ว งาน maintenance/retry ของงานเก่าต้องไม่ขวางคีย์งานใหม่ ถ้าคำขอเดิมยังไม่ทราบผล ให้เก็บ UNKNOWN แทนสรุปว่าไม่เคยส่งถึง LINE

Retry เป็นนโยบายความถูกต้อง/การกู้คืนที่ตั้งแยกได้ ไม่ใช่เทคนิคหลักเพื่อชนะ และห้ามนำ latency ของ retry ที่เร็วกว่าไปแทน first-attempt latency ในรายงาน จำนวนข้อความไม่ได้ถูกกำหนดเป็นหนึ่งจากข้อกำหนดผู้ใช้

## 9. Phase 0 — ระบุสนามแข่งและนิยามผลชนะ

**เป้าหมาย:** ให้ระบบ optimize สิ่งที่ผู้จัดงานใช้ตัดสินจริง

งาน:

- ระบุช่องทาง Talk/OA/OpenChat และว่ารับ/ตอบห้องเดียวกันหรือคนละห้อง
- ระบุรูปแบบคีย์ คำตอบที่ยอมรับ job ID และเงื่อนไขผู้ส่ง
- แยก system admin, owner และผู้ส่งคีย์ฝั่งห้อง
- ระบุจุดตัดสิน: ระบบรับงาน, แอดมิน, observer หรือหลักฐานอื่น
- ระบุจำนวนบัญชี ห้อง คีย์ และงานพร้อมกัน เพื่อสร้าง workload ที่เหมือนจริง
- ถ้ายังไม่มีข้อมูลครบ ให้ทำ connector/profiling ต่อในห้องทดสอบด้วยสมมติฐานที่บันทึกไว้

**สิ่งส่งมอบ:** requirements, definition of winner, event/job identity contract, workload profile

**เกณฑ์ผ่าน:** ทีมบอกได้ว่าอะไรคือชนะ/แพ้/ไม่ทราบ และไม่ใช้ API ACK เป็นผลชนะโดยอัตโนมัติ

## 10. Phase 1 — พิสูจน์ connector ก่อนลงทุน UI

**เป้าหมาย:** ยืนยันว่าบัญชีจริงรับคีย์ครบและส่งคำตอบถูกต้องได้

งาน:

- Pin LINEJS revision, Bun version และ dependency lock; บันทึก OS/architecture
- ทำ login/session flow ของ connector พร้อม QR/challenge ที่รองรับจริง
- ทดสอบ `client.listen()` สำหรับ Talk และ Square แยกกัน
- ตรวจว่า push เป็น notification-only หรือมีเนื้อหาครบ และนับ fetch ต่อ event
- ตรวจ Bun streaming transport/HTTP2/ALPN; ทำ Node control test ถ้าต้องแยกปัญหา runtime
- ทดสอบส่งข้อความธรรมดาที่ผู้จัดงานยอมรับผ่าน sender ของช่องทางนั้น
- ตรวจ room ID, sender ID, message ID, sync token, reconnect และ backlog หลัง reconnect
- แยกบัญชีที่เป็น sender ของ OpenChat กับ OA channel credentials ไม่ใช้แทนกัน

**สิ่งส่งมอบ:** connector capability matrix, trace ตัวอย่าง, version manifest, blocker report

**เกณฑ์ผ่าน:** รับ–ส่งได้จริง, ระบุผู้ส่งได้, session recovery ไม่ทำงานเก่ากลายเป็นงานใหม่ และไม่มี fallback ที่ซ่อนอยู่โดยไม่ถูกวัด

ถ้า OpenChat connector ไม่ผ่าน ห้ามไปสร้าง dashboard แล้วประกาศว่าระบบพร้อมรับงาน; ให้แก้หรือเปลี่ยน connector ที่พิสูจน์ได้ก่อน

## 11. Phase 2 — ระบบวัดคำตอบแรกและ baseline

**เป้าหมาย:** เปิดเผยต้นทุนที่อยู่ก่อน callback และก่อน socket write

งาน:

- Instrument จุด trace ตามส่วน 5 ทั้งใน adapter และ transport
- แยก notification fetch, decode/decrypt, sequence/storage, matcher, encode, transport wait และ ACK
- สร้าง mock replay สำหรับ throughput/local correctness โดยไม่แตะ LINE
- สร้าง live test ในห้องทดสอบที่ควบคุมได้ และสุ่มช่วงรอระหว่างงาน
- ทดสอบข้อความแรกหลัง idle 5 วินาที, 30 วินาที, 2 นาที, 10 นาที และหลัง restart/reconnect แยกชุด
- เก็บผล first attempt เสมอ แม้ส่งล้มเหลวหรือระบบไม่พร้อม
- วัด instrumentation overhead เปิด/ปิดและรายงานแยก ไม่ลบ overhead แบบเดาสุ่ม

**สิ่งส่งมอบ:** baseline report, per-event traces, unknown/failure counters, reproducible test procedure

**เกณฑ์ผ่าน:** สามารถระบุได้ว่าคำตอบแรกเสียเวลาในขั้นตอนไหน ไม่มีค่าที่ซ่อนการ fetch/decrypt/sequence และไม่ตัดงานช้าออกจากรายงาน

## 12. Phase 3 — เลือก region, provider และเส้นทาง

**เป้าหมาย:** ลดช่วง network ที่ไม่สามารถแก้ด้วย matcher

งาน:

- เลือก candidate เริ่มต้น Tokyo, Singapore, Bangkok และ provider ที่มีให้ทดสอบ โดยไม่ถือว่าที่ใดชนะล่วงหน้า
- ใช้ workload, runtime และ hardware class ใกล้กัน; ถ้า session พร้อมกันไม่ได้ ให้สลับทดสอบเป็นช่วงแบบสุ่ม
- ทดสอบทั้งช่วงที่จะใช้งานจริงและช่วงอื่น โดยเก็บ connection age และ network errors
- เปรียบเทียบ IPv4/IPv6 เมื่อ endpoint รองรับ ตรวจ resolved address/ALPN โดยไม่ฝัง IP ถาวร
- แยก ping, TCP/TLS setup, fetch-after-notice, first-send และผล observer
- เลือก primary จาก first-response outcome และ distribution ไม่เลือกจาก best ping ครั้งเดียว
- เตรียม standby และเลือกเส้นทางก่อน critical window หลีกเลี่ยงย้าย session ตอนคีย์มา

**สิ่งส่งมอบ:** region/provider scorecard, primary/standby decision, clock quality report

**เกณฑ์ผ่าน:** มีเส้นทางที่ชนะ baseline อย่างมีหลักฐานหรือระบุชัดว่าไม่ต่าง พร้อมข้อมูล failure และต้นทุน

## 13. Phase 4 — ลด overhead ใน worker และ LINEJS

**เป้าหมาย:** ลดงานภายในก่อนคำตอบแรก โดยรักษาความถูกต้อง

งาน:

- Compile room/sender/rule indexes ตอน config เปลี่ยน
- exact ใช้ map; prefix/contains เลือกจาก benchmark ของจำนวนคีย์จริง; regex compile ก่อน arm
- กำหนดกติกา Unicode/ช่องว่าง/ตัวพิมพ์ชัดเจน และทดสอบภาษาไทย
- เตรียม template คำตอบที่สั้นที่สุดซึ่งยังถูกกติกางาน
- ลด wrapper/copy/serialization จาก profile ไม่ใช้ unsafe byte search บนข้อความเข้ารหัส
- Audit synchronous log listeners, storage adapters และ update-syncdata handlers
- วัดและปรับ sequence allocation ตามเงื่อนไขส่วน 7.2
- เตรียม E2EE keys/session; ตรวจ compact sender สำหรับ Talk โดยเทียบผลถูกต้องและ first-send time
- แยกการส่งงานใหม่จากการรอ ACK ของงานเก่าโดยรักษา protocol ordering ที่จำเป็น
- ใช้ bounded buffers, จำกัด telemetry และไม่ให้ logging backpressure หยุด matcher

**สิ่งส่งมอบ:** optimized worker, small reviewed LINEJS patches ถ้าจำเป็น, local profile และ regression tests

**เกณฑ์ผ่าน:** Our processing ≤0.5 ms ตาม percentile/workload ที่ระบุจึงถือว่าผ่าน target; ถ้ายังไม่ถึงต้องรายงานค่าจริง ไม่ใช้เวลาเฉพาะ matcher มาแทน

## 14. Phase 5 — First-response readiness และ warm scheduling

**เป้าหมาย:** คำตอบแรกหลัง idle ใช้เส้นทางที่พร้อมอยู่แล้ว

งาน:

- Implement readiness จาก receiver subscription, sender transport, config generation และ session/key state
- ตั้ง warm ได้ตาม timezone, start/end, interval และจำนวนครั้ง
- อุ่น local code paths และ connections ที่เกี่ยวข้องกับ receive/fetch/send
- จัด maintenance ก่อนช่วงงาน; ไม่ทำ token refresh หรือโหลดข้อมูลก้อนใหญ่โดยไม่จำเป็นตอน ARMED
- สร้าง alarm จาก disconnect/subscription invalidation ไม่ใช้ read timeout สั้นจนห้องเงียบถูกเข้าใจว่าขาดการเชื่อมต่อ
- เลื่อน/ยกเลิก warm ที่ยังไม่เริ่มเมื่อมีงานจริง โดยไม่ทำลาย shared connection ที่กำลังส่งงาน
- ทดลอง connection age และ idle timeout เพื่อเลือก warm schedule จากหลักฐาน
- ควบคุม warm budget ไม่ให้เพิ่ม traffic จนผลคำตอบแรกแย่ลง

**สิ่งส่งมอบ:** warm scheduler, readiness state machine, first-after-idle comparison

**เกณฑ์ผ่าน:** first-after-idle ดีขึ้นหรือคงที่พร้อม failure ไม่แย่ลง; dashboard ไม่แสดง ARMED เมื่อยัง sync/session ไม่พร้อม

ตัวอย่าง config สำหรับออกแบบ ไม่ใช่ค่า optimal ที่ยืนยันแล้ว:

```json
{
  "timezone": "Asia/Bangkok",
  "activeWindow": {"start": "08:55", "end": "10:05"},
  "warm": {
    "enabled": true,
    "start": "08:54:30",
    "intervalMs": 5000,
    "count": 5,
    "local": true,
    "transport": true,
    "yieldToJobs": true
  }
}
```

เมื่อจำนวนครั้งครบ receiver ยังต้องฟังต่อและ heartbeat ที่ protocol กำหนดยังทำงาน; warm count ไม่ใช่จำนวนคำตอบหรือจำนวนงาน

## 15. Phase 6 — Multi-user, isolation, persistence และ login

**เป้าหมาย:** ผู้ใช้ตั้งบอทของตนได้โดยไม่แชร์ state ผิดบัญชี

งาน:

- แยก worker/session/sequence/rules/metrics ตาม account ownership
- แยก resource limits และทำ load test ว่าบอทหนึ่งไม่เพิ่ม tail latency ของอีกบอทเกินเกณฑ์ที่ตั้ง
- เก็บ `control.sqlite` สำหรับ users/ownership และ SQLite รายบัญชีสำหรับ config/history
- ใช้ WAL บน local disk, migration ที่ versioned และ writer ที่ควบคุมได้; WAL ยังมี writer ได้ครั้งละหนึ่งต่อ database [S15]
- รับ config ใหม่แบบ versioned snapshot แล้วให้ worker ACK generation ที่ใช้งานจริง
- Login เว็บไซต์ผ่าน LINE Login: authorization code + PKCE + state/nonce และ secure session
- รองรับ QR ผ่าน flow ที่ LINE ให้; รหัสยืนยันของ LINE ให้ LINE เป็นผู้จัดการ [S16]
- ถ้าต้องการ OTP ของเว็บไซต์ส่งทาง OA ให้แยกเป็น feature และข้อกำหนด recipient/channel ต่างหาก
- เชื่อม selfbot account ด้วย QR/challenge ของ connector แยกจาก website login
- Ownership/RBAC ตรวจที่ server; admin dashboard ไม่ต้องแสดง token; encrypted credentials กับ key แยกที่เก็บ

**สิ่งส่งมอบ:** users/auth, isolated worker supervisor, SQLite schema/migrations, account connection flow

**เกณฑ์ผ่าน:** ผู้ใช้ A อ่าน/แก้/สั่ง worker ของ B ไม่ได้, restart ไม่ทำ sequence/session ปะปน และ LINE Login ไม่ถูกใช้เสมือนเป็นสิทธิ์อ่านข้อความส่วนตัว

Schema เชิงแนวคิด:

```text
control.sqlite
  users, line_identities, web_sessions, accounts, ownership, deployments

accounts/<account-id>.sqlite
  room_configs, allowed_senders, rules, warm_schedules
  config_generations, encrypted_session_records, sequence_reservations
  job_results, latency_rollups, operational_events
```

## 16. Phase 7 — User mobile UI และ admin dashboard

**เป้าหมาย:** ตั้งค่าชัดเจนและเห็นความพร้อม/คำตอบแรก โดยไม่รบกวน worker

User mobile:

- ภาพรวม: บอทที่เลือก, ห้อง, ARMED/DEGRADED, เริ่ม/หยุด, คำตอบแรกของงานล่าสุด
- คีย์/คำตอบ: exact/prefix/contains, ลำดับ rule, ตัวอย่างทดสอบภาษาไทย, validation ก่อนบันทึก
- ผู้ส่งที่อนุญาต: ID ที่เชื่อถือได้พร้อมชื่อเพื่อช่วยจำ ไม่ใช้ชื่อเป็นตัวตัดสิน
- เวลา/warm: ช่วงทำงาน, timezone, จำนวนครั้งและผล warm ล่าสุด
- ประวัติงาน: first attempt, won/lost/unknown, latency breakdown และเหตุที่ข้าม
- บัญชี: QR/challenge/session status ที่เกี่ยวข้อง ไม่เผย credential

Admin dashboard:

- users/accounts/ownership และเปิด–หยุด–restart ราย worker
- global readiness, reconnects, backlog, CPU/RAM และ first-response SLO
- เปรียบเทียบ region/runtime/config generation และ first-after-idle performance
- ตั้งค่า warm และ sender allowlist ตามสิทธิ์ พร้อมประวัติการแก้ไข
- มุมมองผลชนะต้องแสดงตัวหาร unknown และช่วงข้อมูลชัดเจน

Mobile ใช้ card และ bottom navigation, touch targets เหมาะสม, ไม่บังคับเลื่อนตารางแนวนอนเพื่อทำงานหลัก แยก admin/user bundles และ lazy-load หน้าที่ไม่จำเป็น

**สิ่งส่งมอบ:** React mobile user UI + admin dashboard + SSE integration

**เกณฑ์ผ่าน:** ตั้งค่าและตรวจสถานะบนมือถือได้ครบ; เปิด dashboard หลายหน้าแล้ว first-response latency ไม่ถดถอยเกินเกณฑ์

## 17. Phase 8 — ทดลองเทคนิคขั้นสูงเพื่อเพิ่มโอกาสชนะ

**เป้าหมาย:** ใช้เทคนิคเพิ่มเฉพาะเมื่อช่วยคำตอบแรกจริง

ชุดทดลอง:

1. Receiver diversity/forwarding → single sender โดยใช้สิทธิ์และ session ที่รองรับ
2. Read-only message-fetch racing ที่ semantics อนุญาต พร้อมจำกัดจำนวนและ dedupe
3. Prepared request slot แบบใช้ครั้งเดียว พร้อม key/sequence invalidation
4. CPU affinity, IRQ allocation และ scheduler configuration แยกตัวแปร
5. NAPI/interrupt coalescing/socket tuning บนเครื่องที่เปิดให้ควบคุมและมี profile รองรับ
6. Transport แยก fetch/send และ connection policies ที่ลดการรอของคำตอบแรก
7. Go transport/worker prototype ถ้า Bun processing หรือ transport เป็นคอขวดจริง

**สิ่งส่งมอบ:** experiment registry: hypothesis, baseline, sample size, first-response improvement, failure impact, rollback

**เกณฑ์ผ่าน:** เทคนิคต้องเพิ่ม first-response outcome โดยไม่ทำ correctness หรือ missed-job rate แย่จนผลสุทธิลดลง ถ้าไม่ช่วยให้ถอดออก ไม่เปิดทุก option พร้อมกัน

คำว่า “เอาเทคนิคมาใช้ให้หมด” ในแผนนี้หมายถึงค้นและทดสอบเทคนิคที่เกี่ยวข้องอย่างครบถ้วน แล้วใช้ชุดที่ทำให้ชนะมากที่สุด บางเทคนิคขัดกันหรือเพิ่ม jitter จึงไม่ควรเปิดพร้อมกันเพียงเพื่อให้ครบรายการ

## 18. Phase 9 — Acceptance test ที่ตรงการแข่งขันจริง

**เป้าหมาย:** ตรวจว่าความเร็วที่ดีเกิดกับคำตอบแรกของงานใหม่จริง

| กรณี | สิ่งที่ต้องยืนยัน |
|---|---|
| คีย์แรกหลัง idle แต่ละช่วง | ไม่มี cold initialization ที่ซ่อนอยู่ |
| งานต่อเนื่องเป็นรอบ | ไม่ใช้ผลส่งครั้งสองแทนครั้งแรก |
| คีย์เดิมแต่ job ใหม่ | ตอบได้ ไม่ติด dedupe ผิดรอบ |
| ผู้ส่งไม่อยู่ allowlist | ไม่ตอบแม้ข้อความตรงคีย์ |
| ชื่อเหมือนแอดมินแต่คนละ ID | ไม่เข้าใจผิด |
| หลายกฎตรงพร้อมกัน | คำตอบที่เลือกตรง priority ที่ตั้ง |
| หลายงานพร้อมกัน | งานใหม่ไม่ติด queue ของงานเก่าโดยไม่จำเป็น |
| reconnect + backlog | ไม่รับงานเก่าซ้ำเป็นงานใหม่ |
| token/key เปลี่ยน | readiness และ template invalidation ถูกต้อง |
| ACK timeout | แสดง UNKNOWN ไม่ปลอมเป็น lost หรือไม่เคยส่ง |
| dashboard/SQLite งานหนัก | ไม่ทำให้ hot path รอ |
| worker crash/restart | ownership, sequence และ session ถูกต้อง |

วิธีประเมิน:

- Local replay จำนวนมากใช้หาคอขวดและทดสอบ correctness; ไม่อ้างเป็น live LINE latency
- Live benchmark ใช้ห้อง/บัญชีทดสอบและปริมาณที่เหมาะกับบริการ ไม่ยิง load test ใส่ห้องงาน
- สลับ A/B ตามเวลาแบบสุ่มหรือ crossover เพื่อลดผล time-of-day/session path
- เก็บ sample count ต่อ idle bucket; sample น้อยต้องแสดงความไม่แน่นอน โดยเฉพาะ p99
- ถ้ามีผลผู้ชนะ เก็บ paired outcome/win margin และช่วงความเชื่อมั่นตามจำนวนงาน
- ถ้าไม่มีคู่แข่งหรือผลผู้ชนะจริง ให้เรียก controlled comparison ไม่เรียกชนะคู่แข่งจริง
- Report รวมงานที่ระบบ DEGRADED/รับไม่ทัน พร้อมรายงานเฉพาะ ARMED แยกอีกชุด เพื่อไม่ซ่อน availability
- เกณฑ์ latency เป้าผู้ใช้ต้องรายงานทั้งจำนวนผ่านและเกิน ไม่แปลง requirement “ไม่เกิน” เป็นแค่ค่าเฉลี่ย

**สิ่งส่งมอบ:** acceptance report พร้อม raw trace ที่ตัด secrets แล้ว, comparison และ known limitations

**เกณฑ์ผ่าน:** ทุก feature สำคัญผ่าน correctness และมีผลยืนยัน target ตามสภาพทดสอบ; ถ้า 32 ms ยังไม่ถึงให้ระบุ bottleneck และผลจริง ไม่ประกาศผ่านจากครั้งที่ดีที่สุด

## 19. Phase 10 — Production และติดตามผลคำตอบแรก

**เป้าหมาย:** รักษาผลที่พิสูจน์แล้วโดยไม่เพิ่ม overhead

งาน:

- Release แบบ pin versions, build hash และ config hash ที่ย้อนกลับได้
- Deploy worker พร้อม session restore/warm ก่อนเปิดรับงาน
- Rollout เป็นกลุ่มเล็กและแยก metrics version เก่า/ใหม่
- Alert จาก missed events, first-response regression, readiness loss และ failure rate
- เปลี่ยน region/connection strategy ก่อนช่วงงานจากข้อมูล ไม่โยกทุกครั้งที่ ping แกว่ง
- จำกัด retention ของ raw events; เก็บ rollups ระยะยาว; ไม่บันทึก token/QR secrets ใน trace
- Backup SQLite ตามวิธีที่รองรับ live database และทดสอบ restore
- ตรวจการเปลี่ยน protocol/library ในห้องทดสอบก่อนอัปเดต production

**สิ่งส่งมอบ:** deployment package, rollback procedure, operations runbook, live first-response dashboard

**เกณฑ์ผ่าน:** restart/deploy ไม่ทำให้งานถูกนับผิด, rollback ได้ และเปรียบเทียบ first response ราย version ได้

## 20. ลำดับ dependency และการทำงานขนาน

```text
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
                                                    │
                                Phase 6 → Phase 7   │
                                      ↘             ↓
                                        Phase 8 → Phase 9 → Phase 10
```

Phase 6 เริ่มออกแบบ schema/auth ได้หลัง Phase 1 และทำขนาน Phase 3–5; Phase 7 ทำ UI หลัง contract/config ชัดเจน; Phase 8 บางรายการข้ามได้หาก profiling ไม่สนับสนุน แต่ Phase 9 ต้องทดสอบระบบรวมหลัง feature ที่เลือกครบ

จุดตัดสินสำคัญ:

1. Connector ใช้จริงได้หรือไม่
2. เวลาหายไปที่ notification/fetch/network หรือในเครื่อง
3. First-after-idle ดีขึ้นจริงหรือเฉพาะ repeated sends
4. ปรับแล้วชนะ/รับงานมากขึ้นหรือเพียงตัวเลข ACK ดูดีขึ้น

## 21. โครงสร้าง repository ที่เสนอ

```text
line-first-response/
  apps/
    control/cmd/control/             # Go API + supervisor
    control/internal/{auth,users,bots,metrics,store}/
    worker/src/{adapters,receiver,matcher,sender,readiness}/
    worker/src/{sequence,jobs,telemetry,config}/
    oa-worker/                       # Go OA connector
    web/src/{user,admin,shared}/      # React
  packages/
    contracts/                       # versioned config/metrics schema
  patches/
    linejs/                          # เฉพาะ patch ที่มี profile/tests รองรับ
  migrations/
    control/
    account/
  bench/
    replay/
    first-after-idle/
    network/
    observer/
  deploy/
    systemd/
  docs/
    measurements.md
    protocol-findings.md
    decisions.md
    runbook.md
```

ขนาดไฟล์: แบ่งตามหน้าที่ ไม่บีบโค้ด source จนตรวจยาก; production ใช้ minify/tree-shaking ตาม build ที่รองรับ, แยก UI bundles และไม่แจก source maps/development dependency โดยไม่จำเป็น วัด binary size, transfer size และ RSS แยกกัน เป้าขนาดยังต้องกำหนดจาก build จริง

## 22. ตรวจครบตามความต้องการเดิม

| ความต้องการ | ส่วนที่รับผิดชอบ |
|---|---|
| Inbound 11 ms | Phase 2–3, trace notification/fetch |
| Send 19 ms | Phase 3–5, transport/session |
| โค้ด 0.5 ms | Phase 4, รวม decode/sequence/serialize |
| รวม 32 ms | Phase 9, event-to-ACK พร้อมข้อจำกัด clock |
| RTT 26 ms | Phase 3, metric แยกไม่บวกซ้ำ |
| Talk/OA/OpenChat + คีย์/จับเวลา | Phase 1, 2, 4, 7 |
| Warm ตามเวลาและจำนวน | Phase 5 |
| ตอบเฉพาะผู้ส่งแอดมินที่กำหนด | Phase 0, 4, 7, 9 |
| บอทกลุ่ม | OA group/Talk group/Square แยก capability |
| บอทแต่ละคนแยกกัน | Phase 6, account/session ownership |
| ตั้ง users | Phase 6 |
| User UI แยก | Phase 7 |
| Admin dashboard กลาง | Phase 7 |
| Go+Bun+React+SQLite | ส่วน 6 และ Phase 6–7 |
| ไฟล์เล็ก/โค้ดกระชับ | ส่วน 21, build size budget |
| ตรวจคีย์และตอบทันที | Phase 4–5 |
| แสดงความเร็ว admin/user | Phase 2 และ 7 |
| Mobile ใช้ง่าย | Phase 7 |
| LINE login/รหัส | Phase 6, แยก website กับ selfbot session |
| QR login | Phase 1 และ 6 ตาม connector/login flow |
| คำตอบแรกชนะงาน | Phase 0, 2, 5, 9 เป็นเป้าหมายหลักทุก phase |

## 23. ข้อสรุปเพื่อเริ่มพัฒนา

เริ่มจากพิสูจน์ **OpenChat receiver → message-fetch → sequence allocation → first send หลัง idle** ด้วย Bun + LINEJS ก่อน เพราะเป็นจุดที่มีหลักฐานจากซอร์สว่าอาจเพิ่มเวลา และส่งผลโดยตรงต่อคำตอบแรก

ใช้ Go/SQLite/React เป็นระบบควบคุมที่ไม่ขวาง hot path เมื่อ baseline ชัดแล้วจึงเลือก network, warm และเทคนิคขั้นสูงจากผลการรับงานจริง ไม่ใช้ความเร็วของการส่งซ้ำมาอ้างแทนคำตอบแรก และไม่รับประกันอันดับหนึ่งจากตัวเลข network อย่างเดียว

## 24. แหล่งอ้างอิง

แหล่งซอร์ส LINEJS ด้านล่าง pin commit เพื่อให้ตรวจย้อนหลังได้ ข้อสังเกตจากซอร์สยืนยันว่า code path มีอยู่ แต่ยังไม่ยืนยัน latency หรือการใช้งานกับบัญชีเป้าหมาย

[S1]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/base/push/connManager.ts
[S2]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/client/client.ts
[S3]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/client/features/square/mod.ts
[S4]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/base/polling/mod.ts
[S5]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/base/core/mod.ts
[S6]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/base/service/square/mod.ts
[S7]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/base/service/talk/mod.ts
[S8]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/base/core/node_fetch.ts
[S9]: https://github.com/evex-dev/linejs/blob/ef6c3d9f70dd41fa51053615d47f071f58cf8db3/packages/linejs/base/push/conn.ts
[S10]: https://bun.com/docs/runtime/networking/fetch
[S11]: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/placement-strategies.html
[S12]: https://docs.kernel.org/networking/napi.html
[S13]: https://nodejs.org/api/net.html#socketsetnodelaynodelay
[S14]: https://www.rfc-editor.org/rfc/rfc8446.html#section-8
[S15]: https://www.sqlite.org/wal.html
[S16]: https://developers.line.biz/en/docs/line-login/integrate-line-login/

- [S1 — LINEJS push/notification และ fetchMyEvents][S1]
- [S2 — LINEJS Client listener][S2]
- [S3 — LINEJS SquareChat polling][S3]
- [S4 — LINEJS polling manager และ reconnect][S4]
- [S5 — LINEJS sequence/storage และ transport selection][S5]
- [S6 — LINEJS Square sender][S6]
- [S7 — LINEJS Talk compact sender และ fallback][S7]
- [S8 — LINEJS Node transport pools][S8]
- [S9 — LINEJS PUSH connection startup][S9]
- [S10 — Bun fetch, pooling และ preconnect][S10]
- [S11 — AWS placement group scope][S11]
- [S12 — Linux NAPI/busy polling][S12]
- [S13 — Node TCP_NODELAY][S13]
- [S14 — TLS 1.3 0-RTT replay considerations][S14]
- [S15 — SQLite WAL][S15]
- [S16 — LINE Login, QR และ PKCE][S16]
- [LINE Messaging API สำหรับกลุ่ม](https://developers.line.biz/en/docs/messaging-api/group-chats/)
- [LINE webhook และ event redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [LINEJS project และ runtime support](https://github.com/evex-dev/linejs)
