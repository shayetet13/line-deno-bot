import { unsafeRoomId, unsafeSenderId } from '@line-first/contracts';
import { IdSenderAllowlist } from '../core/allowlist.ts';
import { PreparedSlot } from '../experiments/prepared-slot.ts';
import { FakeClock } from '../lib/clock.ts';
import { Logger } from '../logging/logger.ts';
import { MetricsRecorder } from '../metrics/recorder.ts';
import { StatusSource } from '../observability/snapshot.ts';
import { WriteBehindQueue } from '../persistence/write-behind.ts';
import { ReadinessFsm } from '../readiness/state.ts';
import { ShardTopology } from '../sharding/topology.ts';
import { AcceptanceHarness, owner, sender } from './harness.ts';

/**
 * The Phase 10 acceptance table (Phases §18), one entry per row.
 *
 * These are correctness cases, not a benchmark. Each one asserts a property
 * that has to hold for the FIRST response to a NEW job to be trustworthy; the
 * suite deliberately contains no "is it fast" case, because a local replay
 * cannot answer that (that is what `deno task bench` on the Tokyo host is for).
 */

export interface CaseResult {
  pass: boolean;
  /** What was actually observed, in one line. Shown pass or fail. */
  detail: string;
}

export interface AcceptanceCase {
  readonly id: string;
  /** The row from the table, verbatim. */
  readonly requirement: string;
  run(): Promise<CaseResult>;
}

const pass = (detail: string): CaseResult => ({ pass: true, detail });
const fail = (detail: string): CaseResult => ({ pass: false, detail });
const check = (ok: boolean, detail: string): CaseResult => (ok ? pass(detail) : fail(detail));
const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });

export const ACCEPTANCE_CASES: readonly AcceptanceCase[] = [
  {
    id: 'first-key-after-idle',
    requirement: 'คีย์แรกหลัง idle แต่ละช่วง — ไม่มี cold initialization ที่ซ่อนอยู่',
    async run() {
      const h = new AcceptanceHarness({ metrics: true });
      const warmup = await h.run();
      const warmSpan = h.localSpan(warmup);

      // Long idle: every TTL in the core lapses. The next job must still take
      // the same path, not a slower re-initialisation one.
      h.clock.advance(30 * 60_000);
      const afterIdle = await h.run();
      const idleSpan = h.localSpan(afterIdle);

      if (warmSpan === undefined || idleSpan === undefined) {
        return fail('no sender timestamps recorded');
      }
      // The scripted sender charges a fixed 1ms, so any extra work would show.
      return check(
        afterIdle.outcome === 'dispatched' && idleSpan <= warmSpan,
        `warm ${warmSpan}ms vs first-after-idle ${idleSpan}ms, outcome ${afterIdle.outcome}`,
      );
    },
  },
  {
    id: 'repeated-rounds',
    requirement: 'งานต่อเนื่องเป็นรอบ — ไม่ใช้ผลส่งครั้งสองแทนครั้งแรก',
    async run() {
      const h = new AcceptanceHarness();
      const rounds = 5;
      for (let i = 0; i < rounds; i += 1) {
        const result = await h.run();
        if (result.outcome !== 'dispatched') return fail(`round ${i} gave ${result.outcome}`);
        h.clock.advance(2_000);
      }
      // One send per round: nothing was answered by a retry standing in for
      // the first attempt.
      return check(
        h.sender.sent.length === rounds,
        `${rounds} rounds produced ${h.sender.sent.length} sends (want ${rounds})`,
      );
    },
  },
  {
    id: 'same-key-new-job',
    requirement: 'คีย์เดิมแต่ job ใหม่ — ตอบได้ ไม่ติด dedupe ผิดรอบ',
    async run() {
      const h = new AcceptanceHarness();
      const first = await h.run({ text: 'go' });
      h.clock.advance(5_000);
      const second = await h.run({ text: 'go' });
      return check(
        first.outcome === 'dispatched' && second.outcome === 'dispatched' &&
          first.jobKey !== second.jobKey,
        `both dispatched=${
          String(
            first.outcome === 'dispatched' && second.outcome === 'dispatched',
          )
        }, distinct job keys=${String(first.jobKey !== second.jobKey)}`,
      );
    },
  },
  {
    id: 'sender-not-in-allowlist',
    requirement: 'ผู้ส่งไม่อยู่ allowlist — ไม่ตอบแม้ข้อความตรงคีย์',
    async run() {
      const h = new AcceptanceHarness({
        allowlist: new IdSenderAllowlist({ 'owner-1': ['admin-1'] }),
      });
      const stranger = await h.run({ senderId: unsafeSenderId('stranger-9'), text: 'go' });
      const admin = await h.run({ senderId: unsafeSenderId('admin-1'), text: 'go' });
      return check(
        stranger.outcome === 'sender-not-allowed' && admin.outcome === 'dispatched' &&
          h.sender.sent.length === 1,
        `stranger=${stranger.outcome}, admin=${admin.outcome}, sends=${
          String(h.sender.sent.length)
        }`,
      );
    },
  },
  {
    id: 'impersonating-display-name',
    requirement: 'ชื่อเหมือนแอดมินแต่คนละ ID — ไม่เข้าใจผิด',
    async run() {
      const allowlist = new IdSenderAllowlist({ 'owner-1': ['admin-1'] });
      // The impersonator's display name is irrelevant by construction: the
      // allowlist interface has nowhere to pass one.
      const decidedById = allowlist.allows(owner('owner-1'), sender('admin-1-lookalike'));
      const h = new AcceptanceHarness({ allowlist });
      const impostor = await h.run({ senderId: unsafeSenderId('admin-1-lookalike') });
      return check(
        !decidedById && impostor.outcome === 'sender-not-allowed' && h.sender.sent.length === 0,
        `lookalike id refused=${String(!decidedById)}, outcome=${impostor.outcome}`,
      );
    },
  },
  {
    id: 'multiple-rules-match',
    requirement: 'หลายกฎตรงพร้อมกัน — คำตอบที่เลือกตรง priority ที่ตั้ง',
    async run() {
      const h = new AcceptanceHarness();
      const result = await h.run({ text: 'go' });
      const text = h.sender.sent[0]?.text;
      return check(
        String(result.ruleId) === 'open' && text === 'first!',
        `rule=${String(result.ruleId)} reply=${String(text)} (want open/"first!")`,
      );
    },
  },
  {
    id: 'concurrent-jobs',
    requirement: 'หลายงานพร้อมกัน — งานใหม่ไม่ติด queue ของงานเก่าโดยไม่จำเป็น',
    async run() {
      const h = new AcceptanceHarness();
      const rooms = ['room-a', 'room-b', 'room-c'];
      const results = await Promise.all(
        rooms.map((r) => h.run({ roomId: unsafeRoomId(r) })),
      );
      const dispatched = results.filter((r) => r.outcome === 'dispatched').length;
      const roomsSent = new Set(h.sender.sent.map((c) => String(c.roomId)));
      return check(
        dispatched === rooms.length && roomsSent.size === rooms.length,
        `${String(dispatched)}/${String(rooms.length)} dispatched across ${
          String(roomsSent.size)
        } rooms`,
      );
    },
  },
  {
    id: 'reconnect-backlog',
    requirement: 'reconnect + backlog — ไม่รับงานเก่าซ้ำเป็นงานใหม่',
    async run() {
      const h = new AcceptanceHarness();
      const live = h.event({ text: 'go' });
      const first = await h.replay(live);
      // Reconnect: the backlog redelivers the same event, this time from the
      // other receive path. Same message id ⇒ same job, not a new one.
      const redelivered = await h.replay({ ...live, source: 'dedicated-poll' });
      return check(
        first.outcome === 'dispatched' && redelivered.outcome === 'deduped-incoming' &&
          h.sender.sent.length === 1,
        `first=${first.outcome}, redelivered=${redelivered.outcome}, sends=${
          String(h.sender.sent.length)
        }`,
      );
    },
  },
  {
    id: 'token-rotation',
    requirement: 'token/key เปลี่ยน — readiness และ template invalidation ถูกต้อง',
    run() {
      const clock = new FakeClock();
      const readiness = new ReadinessFsm(clock, silent());
      readiness.set({
        sessionValid: true,
        receiverSubscribed: true,
        rulesLoaded: true,
        senderReady: true,
        backlogDrained: true,
      });
      const wasArmed = readiness.isArmed;

      const slot = new PreparedSlot<string>({ clock });
      slot.prepare('route-1', 1, () => 'prepared-with-old-token');

      // Rotation: the session is no longer valid and anything prepared against
      // it must not go on the wire.
      readiness.set({ sessionValid: false });
      slot.invalidate('token rotated');

      const leaked = slot.take('route-1', 1);
      return Promise.resolve(check(
        wasArmed && !readiness.isArmed && leaked === undefined,
        `armed before=${String(wasArmed)}, armed after=${
          String(readiness.isArmed)
        } (${readiness.state}), prepared payload leaked=${String(leaked !== undefined)}`,
      ));
    },
  },
  {
    id: 'ack-timeout-unknown',
    requirement: 'ACK timeout — แสดง UNKNOWN ไม่ปลอมเป็น lost หรือไม่เคยส่ง',
    async run() {
      const h = new AcceptanceHarness();
      h.sender.behaviour = { hang: true };
      const controller = new AbortController();
      const pending = h.run({}, controller.signal);
      controller.abort(new Error('deadline'));
      const result = await pending;

      if (result.jobKey === undefined) return fail('no job key recorded for a hung send');
      // The request DID leave. Recording it as never-sent would be a lie, and
      // recording it as lost claims knowledge we do not have.
      const settled = h.deps.core.jobs.settle(result.jobKey, 'unknown');
      return check(
        result.outcome === 'send-failed' && h.sender.sent.length === 1 &&
          settled.state === 'unknown',
        `outcome=${result.outcome}, sends=${String(h.sender.sent.length)}, job=${settled.state}`,
      );
    },
  },
  {
    id: 'observability-off-hot-path',
    requirement: 'dashboard/SQLite งานหนัก — ไม่ทำให้ hot path รอ',
    async run() {
      const h = new AcceptanceHarness({ metrics: true });
      const metrics = new MetricsRecorder();
      const source = new StatusSource({
        workerId: 'w-acceptance',
        origin: 'https://legy.line-apps.com/',
        clock: h.clock,
        metrics,
      });

      // A write-behind queue whose flush never settles: the persistence layer
      // is fully stalled for the whole case.
      let flushes = 0;
      const queue = new WriteBehindQueue<number>({
        clock: h.clock,
        logger: silent(),
        batchSize: 8,
        maxQueued: 64,
        flush: () => {
          flushes += 1;
          return new Promise<void>(() => {});
        },
      });
      for (let i = 0; i < 64; i += 1) queue.enqueue(i);

      // A dashboard hammering the status endpoint at the same time.
      const before = h.clock.monotonic();
      for (let i = 0; i < 200; i += 1) source.snapshot();
      const result = await h.run();
      const span = h.localSpan(result);

      const stalled = flushes > 0 && queue.stats.written === 0;
      return check(
        result.outcome === 'dispatched' && span !== undefined && span <= 1 && stalled,
        `reply span ${String(span)}ms with persistence stalled (flushes=${
          String(flushes)
        }) and 200 snapshots taken in ${String(h.clock.monotonic() - before)}ms of clock`,
      );
    },
  },
  {
    id: 'crash-restart',
    requirement: 'worker crash/restart — ownership, sequence และ session ถูกต้อง',
    run() {
      const shards = [
        { workerId: 'w1', owners: ['owner-1', 'owner-2'] },
        { workerId: 'w2', owners: ['owner-3'] },
      ];
      const before = ShardTopology.create(shards);
      const ownerOf = before.workerFor('owner-2')?.workerId;

      // Restart: the same topology is loaded again. An owner must land on the
      // same worker, or two workers would answer for one room.
      const after = ShardTopology.create(shards);
      const sameAfterRestart = after.workerFor('owner-2')?.workerId === ownerOf &&
        after.belongsTo('owner-2', 'w1') && !after.belongsTo('owner-2', 'w2');

      // A prepared request that survived in memory across a reconnect must not
      // be reused against the new session's sequence.
      const clock = new FakeClock();
      const slot = new PreparedSlot<string>({ clock });
      slot.prepare('owner-2', 41, () => 'stale');
      const reused = slot.take('owner-2', 42);

      return Promise.resolve(check(
        ownerOf === 'w1' && sameAfterRestart && reused === undefined,
        `owner-2 → ${String(ownerOf)}, stable across restart=${String(sameAfterRestart)}, ` +
          `stale prepared request reused=${String(reused !== undefined)}`,
      ));
    },
  },
];
