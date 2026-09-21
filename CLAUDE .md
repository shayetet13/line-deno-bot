# CLAUDE.md
**ไฟล์คำสั่งให้ Claude ทำงานตามมาตรฐาน (ฉบับเต็ม)**

> Claude ต้องอ่านและปฏิบัติตามไฟล์นี้อย่างเคร่งครัด ทุกครั้งที่เริ่มโปรเจคใหม่หรือแก้ไขโค้ด
> ใน Claude Code ไฟล์นี้ถูกโหลดอัตโนมัติทุก session

---

## 📋 Table of Contents
1. [Project Execution Model](#1-project-execution-model)
2. [Phase Breakdown](#2-phase-breakdown)
3. [Definition of Done](#3-definition-of-done)
4. [Architecture & Code Principles](#4-architecture--code-principles)
5. [Folder Structure](#5-folder-structure)
6. [Database Rules](#6-database-rules)
7. [Design Language (Anti-AI)](#7-design-language-anti-ai)
8. [Thai Typography Rules](#8-thai-typography-rules)
9. [Frontend Performance](#9-frontend-performance)
10. [Tech Stack](#10-tech-stack)
11. [Quality Gate Checklist](#11-quality-gate-checklist)
12. [SaaS Production Checklist](#12-saas-production-checklist)
13. [Monitoring & Alerting](#13-monitoring--alerting)
14. [Cost Management](#14-cost-management)
15. [PDPA / Data Privacy (Thailand)](#15-pdpa--data-privacy-thailand)
16. [Senior Staff Engineer Mindset](#16-senior-staff-engineer-mindset)

---

## 1. Project Execution Model

### Workflow: Phase-by-Phase
- **วางแผนทั้งโปรเจคจนจบ** แต่ **ลงมือทีละ phase**
- **ทุก phase ต้องผ่าน Quality Gate เดียวกัน** ก่อนไป phase ถัดไป
- **ห้ามข้าม Quality Gate** ไม่งั้นโปรเจคตกเป็นหนี้ทางเทคนิค
- **ห้ามรวม phase** — ทำให้ครบ → test → review → deploy → ถัดไป
- ทุก phase ต้องมี task ชื่อ `GATE: <phase-name>` บังคับรันตอนปิด phase

### Golden Rules
1. อ่านไฟล์ที่เกี่ยวข้องทั้งหมดก่อนแก้โค้ด — **ห้ามเดา**
2. ขออนุมัติก่อนทำ breaking change ทุกครั้ง
3. ทำเฉพาะที่ขอ ไม่ทำเกิน (no scope creep)
4. อธิบาย "ทำไม" ทุกครั้งที่เปลี่ยนแปลงสำคัญ
5. ถ้าไม่แน่ใจ → ถาม ไม่ assume

---

## 2. Phase Breakdown

ลำดับ phase มาตรฐานสำหรับ SaaS บน Next.js (ปรับได้ตามโปรเจค)

| Phase | ชื่อ | สิ่งที่ทำ | Gate |
|-------|-----|----------|------|
| **Phase 0** | Foundation & Infra | Setup repo, ESLint/Prettier/Husky, Supabase, env config, CI/CD skeleton, health check `/api/health`, error/logging framework | GATE: P0 |
| **Phase 1** | Auth & User | Login/register, JWT + refresh, session, RBAC, RLS multi-tenant, profile | GATE: P1 |
| **Phase 2** | Core Feature A | Feature หลักของธุรกิจ (เช่น Invoice CRUD) + service/repo layer | GATE: P2 |
| **Phase 3** | Core Feature B | Feature รองที่ต่อจาก A (เช่น Payment, PDF, Email) | GATE: P3 |
| **Phase 4** | Advanced & Integrations | ต่อ API จริง (Stripe, Resend, OpenAI, LINE), webhooks, background jobs | GATE: P4 |
| **Phase 5** | Polish & Performance | Lighthouse 100, bundle optimization, Anti-AI design recheck, mobile UX | GATE: P5 |
| **Final** | Launch | Full security audit, PDPA compliance, monitoring, DRP, deploy production | GATE: FINAL |

### Phase Rules
- **Phase 0 ต้องเสร็จก่อนเสมอ** — ไม่มี infra = ทำต่อไม่ได้
- แต่ละ phase ต้อง deploy ได้จริง (ไม่ใช่ half-done)
- Integration (Phase 4) ใช้ stub/mock ก่อนใน phase ต้นๆ แล้วค่อยต่อจริง
- Feature flag สำหรับ feature ที่ยังไม่พร้อม

---

## 3. Definition of Done

ทุก feature/PR ต้องผ่านทั้งหมดนี้ก่อน merge:

### Code
- [ ] TypeScript strict — 0 error, ไม่มี `any`
- [ ] ESLint + Prettier — 0 error, 0 warning
- [ ] ไม่มี `console.log` / `debugger` หลงเหลือ
- [ ] ไม่มี `// TODO` / `// FIXME` ค้าง (หรือมี issue tracking)
- [ ] ไม่มี dead code / unused imports
- [ ] ไม่มี hardcoded string/number (ใช้ constant/enum)

### Tests
- [ ] Unit tests ผ่าน + coverage ≥ 80%
- [ ] Integration tests ผ่าน (API endpoints)
- [ ] E2E ครอบคลุม critical flow ของ feature นี้
- [ ] Edge cases ถูก test (null, empty, error, boundary)

### UI/UX
- [ ] Responsive ทุก breakpoint (mobile/tablet/desktop)
- [ ] Mobile UX เทียบเท่า native app
- [ ] Loading state + Error state + Empty state ครบ
- [ ] Thai font ตรวจแล้ว — ไม่มี clipping วรรณยุกต์/สระบน
- [ ] Anti-AI design — ไม่ดูเหมือน template/AI-generated
- [ ] Lighthouse ≥ 90 ทุกหมวด (target 100)
- [ ] Accessibility — keyboard nav, ARIA, contrast ผ่าน

### Security & Reliability
- [ ] Input validation ทุกจุด (Zod)
- [ ] ไม่มี secret หลุดในโค้ด/log
- [ ] Error handling ครบ (custom error, global handler)
- [ ] No race condition / memory leak / infinite loop
- [ ] Cleanup ครบ (subscriptions, timers, listeners, effects)

### Docs
- [ ] README/ADR อัปเดต (ถ้ามี architectural change)
- [ ] API doc (OpenAPI) อัปเดต (ถ้าแก้ endpoint)
- [ ] Comment เฉพาะที่จำเป็น (self-documenting code)

---

## 4. Architecture & Code Principles

### Modular Design (บังคับทุกไฟล์)
- **Single Responsibility** — 1 ไฟล์ = 1 concept
- **ฟังก์ชัน < 20 บรรทัด** (hard limit)
- **ไฟล์ < 400 บรรทัด** (soft: 400, hard: 800)
- **Dependency Injection** — ไม่ import hardcoded dependencies
- **Repository Pattern** — DB access ผ่านชั้นเดียว
- **Service Layer** — business logic แยกจาก route handler

### Code Standards
- **TypeScript strict mode** — ห้าม `any` (ถ้าจำเป็นจริงให้ `unknown` + narrow)
- **ESLint + Prettier** — auto format ทุกครั้ง
- **Husky pre-commit** — block code ที่ไม่ผ่าน lint/test
- **Conventional Commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- **Semantic Versioning** — MAJOR.MINOR.PATCH

### Error Handling
- ✅ Custom Error classes (`UserNotFoundError`, `ValidationError`)
- ✅ Global error handler — จัดการทุกสถานการณ์
- ✅ Fail fast — ตรวจ precondition ก่อน
- ✅ User-friendly messages (ไม่โชว์ stack trace ให้ user)
- ❌ ห้าม `throw new Error("msg")` — ใช้ custom class
- ❌ ห้าม unhandled Promise rejection

### Data & Validation
- **Zod** validate input ทุกจุดที่ขอบระบบ (request body, params, env)
- **ไม่เชื่อ client** — ID, token, body ต้อง validate + authorize
- **Immutability** — สร้าง object ใหม่ ไม่ mutate

### Async & Concurrency
- ✅ async/await เท่านั้น — ห้าม callback hell
- ✅ `Promise.all` สำหรับงาน parallel
- ✅ Timeout ทุก async operation
- ✅ Mutex/Lock ป้องกัน race condition
- ✅ Queue สำหรับงานหนัก (ไม่ block event loop)

### Logging (Structured)
- ✅ JSON format
- ✅ Request ID ทุก log line
- ✅ Levels: `debug` | `info` | `warn` | `error`
- ✅ Correlation ID ข้าม service
- ❌ ห้าม log sensitive data (password, token, PII)

### Configuration
- **12-Factor App** — config มาจาก environment
- ✅ Validate config ตอน startup — fail fast
- ✅ Feature flags
- ❌ ห้าม magic numbers — `setTimeout(5000)` → `RETRY_DELAY_MS`
- ❌ ห้าม hardcoded strings — ใช้ constant/enum

### Principles
- **SOLID** ทุกข้อ
- **Clean Architecture** — dependency ชี้เข้าใน
- **DRY** — ไม่เขียนซ้ำ
- **KISS** — ง่ายที่สุดเท่าที่ทำได้
- **Separation of Concerns**
- **Composition over inheritance**
- **DDD** — แยก domain ชัดเจน

---

## 5. Folder Structure

### แยก Frontend / Backend ชัดเจน + ตามมาตรฐาน Next.js

```
project-root/
├── frontend/                      # Next.js App Router
│   ├── app/
│   │   ├── (auth)/                # Route group
│   │   │   ├── login/page.tsx
│   │   │   └── layout.tsx
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx
│   │   │   ├── invoices/page.tsx
│   │   │   └── settings/page.tsx
│   │   ├── api/                   # Route Handlers (backend)
│   │   │   ├── health/route.ts
│   │   │   ├── auth/[...all]/route.ts
│   │   │   └── invoices/
│   │   │       ├── route.ts       # GET/POST
│   │   │       └── [id]/route.ts  # GET/PUT/DELETE
│   │   ├── layout.tsx             # Root layout
│   │   └── page.tsx
│   ├── components/
│   │   ├── common/                # Button, Input + .css คู่กัน
│   │   ├── layout/                # Header, Sidebar
│   │   └── forms/                 # InvoiceForm + invoice-form.css
│   ├── hooks/                     # useAuth, useInvoice
│   ├── lib/                       # utils, cn, validation (client)
│   ├── services/                  # api client wrapper
│   ├── styles/
│   │   ├── tokens.css             # Design tokens (สี/spacing/font)
│   │   ├── global.css
│   │   └── *.css
│   └── types/                     # shared TS types
│
├── backend/                       # Business logic layer
│   ├── services/                  # *.service.ts (business logic)
│   ├── repositories/              # *.repo.ts (data access)
│   ├── domain/                    # entities, value objects (DDD)
│   ├── errors/                    # custom error classes + handler
│   ├── validation/                # Zod schemas
│   ├── logging/                   # structured logger
│   └── middleware/                # auth, rate-limit, request-id
│
├── db/
│   ├── migrations/                # versioned SQL migrations
│   ├── seed.ts
│   └── client.ts                  # Supabase client
│
├── CLAUDE.md                      # ไฟล์นี้
├── CLAUDE.quick.md                # ฉบับย่อ
└── package.json
```

### กฎโครงสร้าง
- CSS แยกเป็นไฟล์ย่อยให้มากที่สุด — วาง .css คู่ component (เช่น `Hero.tsx` + `hero.css`)
- ห้าม hardcode สี/typography/spacing ซ้ำ — ใช้ `styles/tokens.css`
- Layer flow: `route handler → service → repository → DB`

### Responsive Design
- **Mobile-first** — style mobile ก่อน → ขยายขึ้น
- Tailwind breakpoints: `sm:` `md:` `lg:` `xl:` `2xl:`
- Touch target ≥ 48px, spacing ≥ 16px
- **UX มือถือเทียบเท่า native app** — ไม่ใช่แค่ย่อ desktop
- ห้าม hide feature บน mobile — ปรับ UI ให้ fit แบบถูกวิธี

---

## 6. Database Rules

### Schema Design
- ทุกตารางมี `id` (UUID), `created_at`, `updated_at`, `deleted_at` (soft delete)
- **Multi-tenant**: ทุกตารางมี `tenant_id` + RLS policy + `current_tenant_id()`
- Foreign keys + cascading rules ชัดเจน
- ใช้ `enum` type ใน DB สำหรับ status fields
- Naming: `snake_case`, plural table names (`invoices`, `users`)

### Indexing
- Index ทุก FK column
- Composite index สำหรับ query ที่ใช้บ่อย (เช่น `(tenant_id, status)`)
- Index columns ที่ใช้ใน `WHERE` / `ORDER BY` / `JOIN`
- **ระวัง over-indexing** — index มากเกินทำให้ write ช้า
- ตรวจ query ด้วย `EXPLAIN ANALYZE` ก่อน production

### Query Safety
- ✅ Parameterized queries เสมอ (ป้องกัน SQL injection)
- ✅ ป้องกัน N+1 query — ใช้ join/batch
- ✅ Transaction สำหรับ operation ที่ต้อง atomic
- ✅ Optimistic locking (version column) สำหรับ concurrent update
- ✅ Connection pooling
- ❌ Never trust client-supplied ID — ตรวจ ownership ทุกครั้ง

### Migration
- Versioned migrations (เลขลำดับ / timestamp)
- **ทุก migration ต้อง reversible** (มี up + down)
- Test migration บน staging ก่อน production
- Backward compatible — deploy ใหม่ต้องทำงานกับ schema เก่าได้ชั่วคราว
- ห้ามแก้ migration ที่ deploy แล้ว — สร้างใหม่แทน

### Scale
- พิจารณา partitioning สำหรับตารางใหญ่ (time-series, logs)
- Read replica สำหรับ read-heavy workload
- Archive ข้อมูลเก่าตาม retention policy

---

## 7. Design Language (Anti-AI)

> เป้าหมาย: เว็บต้องไม่ดูเหมือน AI generate / template / SaaS landing โหลๆ
> ให้รู้สึก handcrafted, opinionated, premium เหมือนมี dev + ทีม UX/UI มือโปรจริง

### ❌ Avoid (ห้ามทำ)

**Layout**
- Generic hero / hero + dashboard mockup / centered hero แบบ startup template
- โครง SaaS ซ้ำ: Hero → Features → Pricing → FAQ → CTA
- Section ซ้ำแพตเทิร์น / สมมาตรเป๊ะทุกจุด
- Template marketplace aesthetics

**Visual Style**
- Gradient ม่วง/น้ำเงิน, glassmorphism, floating UI/dashboard
- Generic AI illustration, empty decorative background
- Blur/shadow/rounded เกินจำเป็น, สไตล์ Dribbble

**Components**
- 3-column feature grid, การ์ดซ้ำๆ
- Generic icon collection / pricing table / FAQ / CTA / trust badge / logo cloud

**Content**
- สถิติปลอม / testimonial ปลอม / โลโก้ลูกค้าปลอม
- Copy การตลาดลอยๆ — คำว่า Fast/Secure/Modern/Powerful/Scalable/Reliable/Innovative (ถ้าไม่มีหลักฐาน)
- Stock photo (คนยิ้มจับแล็ปท็อป/ประชุมทีม), screenshot ปลอม, placeholder

**Motion**
- Animation ทุก section / parallax / scroll effect เพื่อความสวยอย่างเดียว

### ✅ Prefer (ทำให้หมด)

**Product-First + Content-First**
- โชว์ของจริง (screenshot/workflow/interface จริง)
- เน้นความชัดเจน + proof + business value มากกว่าตกแต่ง

**Storytelling**
```
Problem → Proof → Process → Product → Evidence → Trust → Conversion
(ไม่ใช่ Hero → Features → Pricing → FAQ → CTA)
```

**Layout**
- Custom section structure, จังหวะ/ลำดับชั้นตั้งใจ
- Asymmetry แบบตั้งใจ, สไตล์ editorial
- แต่ละ section มีเอกลักษณ์

**Design Language**
- แนว Linear / Stripe / Raycast / Notion / Vercel
- ไม่ใช่ ThemeForest / generic SaaS / AI generator

**Copywriting** — เขียนเป็น "ผลลัพธ์" ไม่ใช่ feature
- ❌ "Fast, Secure, Powerful"
- ✅ "สร้างใบแจ้งหนี้ใน 20 วินาที"
- ✅ "ส่งบิลอัตโนมัติผ่าน LINE"
- ✅ "เซ็นสัญญาออนไลน์ไม่ต้องพิมพ์"

**Section Philosophy** — ทุก section ต้อง justify ตัวเอง
- ✅ Build trust / Explain product / Show evidence / Improve conversion
- ❌ มีไว้แค่ดูสวย → ตัดทิ้ง

**UX**
- กดให้น้อยที่สุด (minimize clicks), flow สั้น, default ฉลาด
- Inline edit, keyboard-friendly
- ใช้งานง่าย ไม่รก เคลียร์ ทันสมัย

**Final Rule**
ผลลัพธ์ต้องไม่เหมือนงานจาก ChatGPT / Claude / v0 / Lovable / Bolt / Replit Agent / Framer AI / Wix AI / Squarespace AI
→ ต้อง handcrafted, premium, opinionated, senior designer level

---

## 8. Thai Typography Rules

### Font Selection
- **Thai fonts**: IBM Plex Sans Thai, Noto Sans Thai, Sarabun, LINE Seed Sans TH
- จับคู่กับ Latin font ที่เข้ากัน (Inter, IBM Plex Mono)

### Line Height & Spacing
- **line-height ≥ 1.6** สำหรับ body (ไทยต้องการช่องมากกว่า Latin)
- **line-height ≥ 1.3** สำหรับ heading
- ห้ามใช้ line-height แน่นแบบ Latin
- `padding-top ≥ 8px` สำหรับ container ที่มีข้อความไทย

### Prevent Clipping
ตัวอักษรไทยมีวรรณยุกต์/สระบนที่ถูกตัดง่าย: `ิ ี ึ ื ่ ้ ๊ ๋ ์`
- ตรวจ clipping ทุก heading/badge/button ที่ความสูงจำกัด
- เผื่อ gap ด้านบนพอ ไม่ให้วรรณยุกต์/สระบนถูกตัด/ทับขอบ
- ปรับ vertical metrics ของ container ให้มีช่องว่างด้านบน

### Design Tokens (styles/tokens.css)
```css
:root {
  --font-th-body: 'IBM Plex Sans Thai', sans-serif;
  --font-th-heading: 'IBM Plex Sans Thai', sans-serif;
  --font-latin: 'Inter', -apple-system, sans-serif;

  --leading-th-body: 1.6;
  --leading-th-heading: 1.3;
  --gap-top-th: 8px;
}
```
ใช้ซ้ำทั้งระบบ ไม่ hardcode

---

## 9. Frontend Performance

### Code Splitting
- Dynamic import สำหรับ component ที่หนัก/ไม่ critical
- Route-based splitting (Next.js ทำให้อัตโนมัติ)
- Lazy load below-the-fold content
- Target: initial JS landing < 150kb, app < 300kb (gzipped)

### Image Optimization
- ใช้ `next/image` เสมอ — ไม่ใช้ `<img>` ตรงๆ
- กำหนด `width`/`height` ป้องกัน CLS
- Format: WebP/AVIF, lazy loading default
- Responsive `sizes` attribute

### Font Loading
- `next/font` สำหรับ self-host (ป้องกัน FOUT/FOIT)
- `font-display: swap`
- Preload critical fonts
- Subset เฉพาะ glyph ที่ใช้ (ไทย + Latin)

### Rendering
- ใช้ Server Components default, Client Component เฉพาะที่ต้อง interactive
- หลีกเลี่ยง unnecessary re-render (memo, useMemo, useCallback ตามจำเป็น)
- ป้องกัน hydration mismatch
- Debounce/throttle สำหรับ event ถี่ๆ

### Data Fetching
- Fetch ที่ server เมื่อทำได้ (RSC)
- Cache ด้วย Next.js cache / React Query
- ป้องกัน waterfall — parallel fetch
- Prevent unnecessary API calls (dedupe, stale-while-revalidate)

---

## 10. Tech Stack

| Category | Tool | Notes |
|----------|------|-------|
| **Frontend** | Next.js 15 (App Router) | TS strict, TailwindCSS, shadcn/ui |
| **UI** | shadcn/ui | Headless, accessible, customizable |
| **Backend** | Next.js Route Handlers | Service + Repository layer |
| **Database** | Supabase (PostgreSQL) | Auth + RLS multi-tenant |
| **Cache/Rate limit** | Upstash Redis + Ratelimit | Serverless-friendly |
| **Queue/Cron** | Upstash QStash | Webhook-based, Vercel-friendly |
| **Storage** | Supabase Storage | S3-compatible |
| **PDF** | @react-pdf/renderer | Server-side, เบา |
| **Edge/WAF/DDoS** | Cloudflare | Protect + speed |
| **Deploy** | Vercel | CI/CD ในตัว |
| **Alt hosting** | Railway / Cloudflare Workers | ตามโปรเจค |

### Integrations (stub ก่อน → ต่อจริงตาม phase)
Stripe (payment), Resend (email), OpenAI (AI), LINE API (Thai market)

> เลือก stack ตามความเหมาะสมของแต่ละโปรเจค — ตารางนี้คือ default ที่แนะนำ

---

## 11. Quality Gate Checklist

> ทุก phase ต้องผ่านทั้ง 10 gates ก่อนขึ้น phase ถัดไป
> ถ้าไม่ผ่าน → วนแก้ใน phase เดิม → test ใหม่ → รัน gate ใหม่
> สร้าง task `GATE: <phase>` บังคับรันทุกครั้งที่ปิด phase

| # | Gate | Tool | เกณฑ์ผ่าน |
|---|------|------|----------|
| **G1** | Tests (unit + integration + E2E) | Vitest, Playwright | Coverage > 80%, ผ่านหมด, 0 flaky |
| **G2** | Lint + Format + Type-check | ESLint, Prettier, `tsc --noEmit` | 0 error, 0 warning |
| **G3** | Dead code cleanup | knip, ts-prune, depcheck | ไม่มี dead code / unused import / โค้ดซ้ำ |
| **G4** | Code + Security review | code-reviewer, security-review | ไม่มี CRITICAL/HIGH |
| **G5** | Lighthouse (ทุก route ที่แตะ) | Lighthouse CI / Playwright | Perf/A11y/Best-Practices/SEO = 100; CWV ผ่าน |
| **G6** | Security scan + tenant isolation | npm audit, Snyk, Semgrep, RLS test | ไม่มี HIGH+, RLS แยกขาด 2 tenant |
| **G7** | Build + bundle budget | `npm run build` | Build ผ่าน, JS landing < 150kb / app < 300kb (gzipped) |
| **G8** | Docs / ADR / README | doc-updater | อัปเดตครบต่อ module |
| **G9** | Anti-AI design recheck | frontend-design, design-critique | ไม่มี UI เข้าข่าย Anti-AI; ฟอนต์ไทยไม่ clipping |
| **G10** | Production readiness | SaaS checklist | Error handling, logging, monitoring, secrets ปลอดภัย |

### Core Web Vitals Targets
- **FCP** < 1.0s · **LCP** < 1.0s · **CLS** < 0.1 · **TBT** < 100ms · **SI** < 1.0s
- Load + interactive < 1 วินาที

---

## 12. SaaS Production Checklist

### Availability & Resilience
- Health checks + auto-failover, rate limiting, traffic shaping
- Multi-AZ/region (Vercel + Supabase จัดการ), DB replication, failover automation
- Horizontal scaling (serverless), CDN/edge caching, stateless architecture
- **Resilience patterns**: circuit breaker, retry + exponential backoff + jitter, bulkhead, timeout, graceful degradation, graceful shutdown, fallback
- **Resource**: OOM protection, memory leak detection, resource quotas, backpressure, connection pool
- **Backup**: 3-2-1 rule, PITR tested, RTO/RPO defined, DRP + BCP, DR drill รายไตรมาส

### Security
- **IAM**: JWT (access + refresh), API key (scoped+hashed), RBAC/ABAC, MFA, SSO (SAML/OIDC), token rotation/revocation, least privilege
- **App**: input validation (Zod), output encoding (XSS), SQL injection prevention, CSRF, CORS strict, security headers (Helmet), CSP, SSRF/XXE/path traversal prevention
- **Infra**: network segmentation, private networking, zero trust, TLS 1.3 only, cert automation, WAF, DNSSEC
- **Data**: encryption at rest (AES-256), in transit (TLS 1.3), column-level encryption (PII), data masking, DLP, classification, right to erasure
- **Secrets**: no hardcoded, no secrets in logs, rotation 90 วัน, separate keys per env
- **Supply chain**: dependency scan (Snyk), SAST (Semgrep), SBOM, lock files, container scan (Trivy)
- **Compliance**: SOC 2 (Vanta/Drata), GDPR/PDPA, ISO 27001, PCI-DSS (ถ้ารับ payment)

### API
- **Design**: RESTful, consistent response, error code standard, versioning, cursor pagination
- **Performance**: response time P50/P95/P99, Redis cache, CDN, query optimization, connection pooling, compression, N+1 prevention
- **Middleware**: request ID → logger → security headers → CORS → rate limiter → body parser → auth guard → permission guard → validation → serializer → global error handler
- **Reliability**: circuit breaker, retry+backoff, idempotency keys, timeout per op, `/api/health`, graceful shutdown
- **Jobs/Webhooks**: queue (BullMQ/QStash), dead letter queue, webhook retry, HMAC verification, cron, idempotent processing
- **Docs/DX**: OpenAPI/Swagger, Postman, SDK gen, changelog, status page, sandbox
- **Testing**: unit, integration, contract (Pact), load (k6), security (OWASP ZAP), coverage > 80%
- **Multi-tenancy**: RLS isolation, usage tracking per tenant, quota enforcement, usage alerts, tenant-aware cache keys

### Code Quality
- **Architecture**: modular, DDD, SoC, DI, repository pattern, service layer, SOLID
- **Standards**: TS strict, ESLint+Prettier, Husky, conventional commits, semver, review checklist
- **Error**: custom error classes, global handler, never throw raw, handle promise rejection, fail fast, user-friendly
- **Async**: async/await, Promise.all, queue heavy tasks, mutex/lock, timeout ทุก op
- **DB**: parameterized queries, versioned migrations, transactions, optimistic locking, soft delete, audit trail, never trust client ID
- **Security code**: never trust input, constant-time compare (token), secure random (crypto.randomBytes), hash before store (Argon2/bcrypt), sanitize HTML, ห้าม eval()
- **Performance**: lazy load, memoization, debounce/throttle, no blocking event loop, stream large data, batch, worker threads
- **Config**: 12-factor, env-based, validate on startup, feature flags, no magic numbers, no hardcoded strings
- **Logging**: JSON, log levels, request ID, no sensitive data, correlation ID, perf timing
- **Maintainability**: DRY, SRP, small functions (<20 lines), descriptive naming, self-documenting, JSDoc public API, README per module, ADR
- **CI/CD**: lint on push, test on PR, security scan, format check, dead code detection, bundle size check, build verification
- **Tech debt**: boy scout rule, debt tracking, refactor sprint, deprecation strategy, code smell detection

---

## 13. Monitoring & Alerting

### Metrics (RED + USE)
- **RED** (per service): Rate, Errors, Duration
- **USE** (per resource): Utilization, Saturation, Errors
- Track: response time P50/P95/P99, error rate, throughput, DB connection pool usage

### Alert Thresholds (ปรับตามจริง)
- Error rate > 1% ใน 5 นาที → alert
- P95 latency > 1s → warning, > 3s → critical
- CPU > 80% sustained 5 นาที → scale/alert
- Memory > 85% → alert
- DB connection pool > 90% → critical
- Failed background jobs > 5 ใน 10 นาที → alert

### Observability Stack
- Centralized logging (Datadog / Vercel / SIEM)
- Distributed tracing (request ID ข้าม service)
- Real User Monitoring (Vercel Analytics / Sentry)
- Uptime monitoring + public status page

### Incident Response
- Runbook ต่อ incident type
- On-call schedule + escalation
- Blameless postmortem
- Kill switch / emergency rollback
- Forensic log retention
- Communication plan (status page update)

### Log Retention
- Application logs: 30 วัน hot, 1 ปี archived
- Audit logs: ตาม compliance (PDPA: เก็บเท่าที่จำเป็น)
- Security logs: ≥ 1 ปี

---

## 14. Cost Management

### Budget Awareness
- กำหนด budget ต่อเดือนชัดเจน (เช่น $50-100/month MVP)
- Track cost ต่อ service (Vercel, Supabase, Upstash, Cloudflare)
- Alert เมื่อใกล้ budget (80% threshold)

### Vercel
- ระวัง function execution time (timeout ยิ่งนานยิ่งแพง)
- ระวัง bandwidth — optimize image/asset
- ใช้ ISR/static แทน SSR เมื่อทำได้ (ลด compute)
- Edge function สำหรับ logic เบาๆ (ถูกกว่า serverless)

### Supabase
- เริ่ม Free tier → Pro ($25) เมื่อจำเป็น
- ระวัง DB size, bandwidth, storage
- Connection pooling (Supavisor) ลด connection cost
- Archive ข้อมูลเก่า ลด DB size

### Upstash / อื่นๆ
- Pay-per-request — เหมาะ traffic ต่ำ-กลาง
- Cache aggressive ลด DB hit
- ปิด service ที่ไม่ใช้

### Optimization Targets
- Cache hit ratio > 80% (ลด DB/API cost)
- Bundle size เล็ก = bandwidth ถูก
- ลด N+1 query = ลด DB compute

---

## 15. PDPA / Data Privacy (Thailand)

> PDPA = พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (กฎหมายไทย) — บังคับใช้ถ้ามีผู้ใช้ในไทย

### หลักการ
- **Consent** — ขอความยินยอมก่อนเก็บข้อมูลส่วนบุคคล ชัดเจน เพิกถอนได้
- **Purpose limitation** — เก็บเท่าที่จำเป็นตามวัตถุประสงค์ที่แจ้ง
- **Data minimization** — ไม่เก็บข้อมูลเกินจำเป็น

### สิทธิของเจ้าของข้อมูล (ต้องรองรับ)
- สิทธิเข้าถึง (export ข้อมูลตัวเอง — JSON/CSV)
- สิทธิแก้ไข
- สิทธิลบ (right to erasure — ลบจริง ไม่ใช่แค่ soft delete สำหรับ PII)
- สิทธิคัดค้าน / ระงับการใช้
- สิทธิเพิกถอนความยินยอม

### Implementation Checklist
- [ ] Privacy policy + consent banner (ภาษาไทย)
- [ ] บันทึก consent (เมื่อไหร่ ยินยอมอะไร)
- [ ] เข้ารหัส PII (encryption at rest + column-level)
- [ ] Data retention policy — ลบ/archive ข้อมูลเก่าอัตโนมัติ
- [ ] User data export endpoint
- [ ] Account deletion flow (ลบ PII จริง)
- [ ] Audit log การเข้าถึงข้อมูลส่วนบุคคล
- [ ] DPO contact (ถ้าองค์กรเข้าเกณฑ์)
- [ ] Data breach notification plan (แจ้งภายใน 72 ชม.)

### Data Classification
- **PII**: ชื่อ, email, เบอร์โทร, เลขบัตรประชาชน, ที่อยู่ → เข้ารหัส + จำกัดการเข้าถึง
- **Sensitive**: ข้อมูลสุขภาพ, ศาสนา, ประวัติอาชญากรรม → เข้มงวดเป็นพิเศษ
- **Public**: ข้อมูลทั่วไป → ปกติ

---

## 16. Senior Staff Engineer Mindset

### Analysis-First (ก่อนแก้โค้ดทุกครั้ง)
1. อ่าน codebase ที่เกี่ยวข้องทั้งหมด
2. เข้าใจ dependency + side effect
3. Map ไฟล์ที่เกี่ยวข้องทั้งหมด
4. วาง refactor plan
5. ขออนุมัติก่อน breaking change

### Output Format (สำหรับ refactor งานใหญ่)
```
Phase 1: Audit findings (Critical / High / Medium / Low)
Phase 2: Refactor plan
Phase 3: Implement changes
Phase 4: Validation results

สรุปท้าย:
1. Major changes
2. Removed files/functions/imports
3. Potential risks
4. Further optimization opportunities
5. Build / TypeScript / ESLint / Test status
6. Breaking change assessment
```

### Requirements (Non-Negotiable)
Zero: breaking changes, TS errors, ESLint errors, unused imports, dead code, duplicated logic
Preserve: features, UI, API compat, DB compat, env compat
Improve: maintainability, scalability, readability, performance

### Reliability Checklist
- Error boundaries, loading/error states
- Memory-safe async, no race conditions
- No hydration issues, no infinite renders
- Cleanup ครบ: subscriptions, timers, listeners, effects

### Communication
- ❌ Never assume behavior — ถาม
- ✅ อธิบาย "ทำไม" เสมอ
- ✅ List changes ชัดเจน + highlight risks
- ✅ ขออนุมัติก่อน risky change
- ✅ Read all related files before modifying

---

**Version:** 2.0.0 · **Updated:** June 2026
