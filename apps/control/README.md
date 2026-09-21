# apps/control (Go) — stub

Control API + supervisor. **ยังไม่ scaffold** — เริ่มใน Phase 7 (multi-user, isolation, persistence,
login)

ขอบเขต (decision doc §8 step 7):

- login + users + ownership (LINE Login: authorization code + PKCE + state/nonce)
- worker lifecycle / configuration (versioned snapshot → worker ACK generation)
- SQLite persistence + metrics rollups (`control.sqlite`)
- REST + SSE → React admin / mobile user

**ไม่อยู่บน hot path** ระหว่างคีย์กับคำตอบ

Layout ที่วางไว้:

```
apps/control/
  cmd/control/main.go
  internal/{auth,users,bots,metrics,store}/
```
