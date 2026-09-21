import { parseArgs } from '@std/cli/parse-args';
import { unsafeRoomId } from '@line-first/contracts';
import { type Device, resumeOrLogin } from '../adapters/linejs/login.ts';
import { LinejsSender } from '../adapters/linejs/sender.ts';
import type { SendCommand } from '../adapters/types.ts';
import { ConfigError } from '../errors/base.ts';
import { systemClock } from '../lib/clock.ts';
import { withTimeout } from '../lib/with-timeout.ts';
import { Logger } from '../logging/logger.ts';
import { LatencyRing } from '../metrics/ring.ts';
import { Trace } from '../metrics/trace.ts';
import { FileSessionStore } from '../session/store.ts';
import { createWarmHttpClient } from '../warm/http-client.ts';
import { createOwnedLanePool } from '../transport/index.ts';
import { TransportWarmer } from '../warm/warmer.ts';
import { measureClockOffset } from './clock-skew.ts';
import { writeErr, writeLine } from './console.ts';

const SEND_BUDGET_MS = 19;
const SEND_GUARDRAIL_MS = 23;
const SEND_TIMEOUT_MS = 15_000;

const USAGE = `
Measures send RTT: transport_submit -> ack_complete, both on one monotonic
clock, so the figure is exact regardless of NTP quality. This is the number
that decides races (Playbook §2); inbound is LINE's to control, this is ours.

  deno run -A apps/worker/src/cli/bench.ts --bot-id <id> [options]

THIS POSTS REAL MESSAGES. Point it at a room you own.

Options
  --bot-id <id>       Required. Must already have a stored session.
  --room <mid>        Target room. Omit to send to yourself on Talk (safe default).
  --surface <s>       talk (default) | square.  --surface square requires --room.
  --count <n>         Messages to send (default 10).
  --interval-ms <n>   Gap between sends (default 1500). Keep it polite.
  --text <s>          Body to send (default a short marker).
  --warm-seconds <n>  Keep the send origin hot for n seconds before measuring,
                      through a shared pooled connection (Phase 3). 0 = cold.
  --lanes <n>         Route sends through an owned pool of n HTTP/2 lanes
                      (Phase 4). 0 = let the runtime pick the socket.
  --sessions-dir <p>  Default .sessions
`.trim();

interface BenchConfig {
  botId: string;
  dir: string;
  room: string | undefined;
  surface: 'talk' | 'square';
  count: number;
  intervalMs: number;
  text: string;
  warmSeconds: number;
  lanes: number;
}

function parse(args: string[]): BenchConfig {
  const flags = parseArgs(args, {
    string: [
      'bot-id',
      'room',
      'surface',
      'count',
      'interval-ms',
      'text',
      'warm-seconds',
      'lanes',
      'sessions-dir',
    ],
    boolean: ['help'],
    default: {
      surface: 'talk',
      count: '10',
      'interval-ms': '1500',
      text: '.',
      'warm-seconds': '0',
      lanes: '0',
      'sessions-dir': '.sessions',
    },
  });
  if (flags.help) {
    writeLine(USAGE);
    Deno.exit(0);
  }
  const botId = flags['bot-id'];
  if (botId === undefined || botId.length === 0) {
    throw new ConfigError('--bot-id is required (see --help)');
  }
  if (flags.surface !== 'talk' && flags.surface !== 'square') {
    throw new ConfigError(`--surface must be talk or square, got "${flags.surface}"`);
  }
  if (flags.surface === 'square' && (flags.room === undefined || flags.room.length === 0)) {
    throw new ConfigError('--surface square needs an explicit --room');
  }
  const count = Number(flags.count);
  const intervalMs = Number(flags['interval-ms']);
  const warmSeconds = Number(flags['warm-seconds']);
  if (!Number.isInteger(count) || count < 1) throw new ConfigError('--count must be >= 1');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new ConfigError('--interval-ms must be >= 0');
  }
  if (!Number.isFinite(warmSeconds) || warmSeconds < 0) {
    throw new ConfigError('--warm-seconds must be >= 0');
  }
  const lanes = Number(flags.lanes);
  if (!Number.isInteger(lanes) || lanes < 0) {
    throw new ConfigError('--lanes must be an integer >= 0');
  }
  return {
    botId,
    dir: flags['sessions-dir'],
    room: flags.room,
    surface: flags.surface,
    count,
    intervalMs,
    text: flags.text,
    warmSeconds,
    lanes,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function report(ring: LatencyRing, failures: number, config: BenchConfig): void {
  const snap = ring.snapshot();
  writeLine('');
  writeLine('── send RTT ───────────────────────────────────');
  writeLine(`surface / room        : ${config.surface} / ${config.room ?? '(self)'}`);
  writeLine(`sent ok / failed      : ${String(snap?.count ?? 0)} / ${String(failures)}`);
  if (snap === undefined) {
    writeLine('no successful sends — nothing to report');
    return;
  }
  writeLine(
    `min / p50 / p95 / max : ${snap.min.toFixed(1)} / ${snap.p50.toFixed(1)} / ` +
      `${snap.p95.toFixed(1)} / ${snap.max.toFixed(1)} ms`,
  );
  writeLine(`mean                  : ${snap.mean.toFixed(1)} ms`);
  writeLine('');
  const verdict = snap.p50 <= SEND_BUDGET_MS
    ? `p50 is inside the ${String(SEND_BUDGET_MS)}ms budget`
    : snap.p50 <= SEND_GUARDRAIL_MS
    ? `p50 is over the ${String(SEND_BUDGET_MS)}ms budget but inside the ${
      String(SEND_GUARDRAIL_MS)
    }ms guardrail`
    : `p50 is over the ${String(SEND_GUARDRAIL_MS)}ms guardrail (Playbook §7.10)`;
  writeLine(`verdict: ${verdict}`);
  writeLine('');
  writeLine(
    config.warmSeconds > 0
      ? `warmed the origin for ${String(config.warmSeconds)}s first, on a shared pooled connection.`
      : 'cold run: no warm-up. Compare with --warm-seconds to see the handshake cost.',
  );
  writeLine('Single-clock span — no NTP caveat. Owned HTTP/2 lanes are still Phase 4.');
}

async function main(): Promise<number> {
  const config = parse(Deno.args);
  const logger = new Logger({ level: 'warn' });
  const sessions = new FileSessionStore(config.dir);
  const stored = await sessions.load(config.botId);
  if (stored === null) {
    throw new ConfigError(`no stored session for "${config.botId}" — run \`deno task login\``);
  }

  // Phase 4: an owned lane pool takes priority over the Phase 3 warm client —
  // it already owns several pooled connections and routes between them.
  const lanePool = config.lanes > 0
    ? createOwnedLanePool({ clock: systemClock, logger, lanes: config.lanes })
    : undefined;
  const warmClient = lanePool === undefined && config.warmSeconds > 0
    ? createWarmHttpClient()
    : undefined;
  const httpFetch = lanePool?.fetch ?? warmClient;
  const warmer = warmClient === undefined ? undefined : new TransportWarmer({
    clock: systemClock,
    logger,
    fetchFn: (info, init) => warmClient(info, init),
    intervalMs: 5_000,
  });

  const client = await resumeOrLogin({
    botId: config.botId,
    device: (stored.extra.device as Device | undefined) ?? 'DESKTOPWIN',
    method: { kind: 'authToken', authToken: stored.authToken },
    storagePath: `${config.dir}/${encodeURIComponent(config.botId)}.linejs.json`,
    sessions,
    logger,
    ...(httpFetch === undefined ? {} : { httpFetch }),
  });

  if (warmer !== undefined) {
    writeLine(
      `warming ${config.surface === 'square' ? 'legy' : 'legy'} for ${
        String(config.warmSeconds)
      }s...`,
    );
    await warmer.start();
    await sleep(config.warmSeconds * 1_000);
    const s = warmer.status;
    writeLine(
      `warm: ${String(s.probes)} probes, ${String(s.consecutiveFailures)} failing, ` +
        `last rtt ${s.lastRttMs === undefined ? '?' : `${s.lastRttMs.toFixed(1)}ms`}, ready=${
          String(warmer.ready)
        }`,
    );
  }

  const target = config.room ?? (await client.getMyProfile()).mid;
  const offset = await measureClockOffset();
  if (offset !== undefined) {
    writeLine(
      `host clock offset: ${String(offset.offsetMs)}ms (±${String(offset.uncertaintyMs)}ms via ` +
        `${offset.source}) — not used below; send RTT is single-clock`,
    );
  }
  writeLine(`sending ${String(config.count)} message(s) to ${config.surface}:${target}`);
  writeLine('');

  const sender = new LinejsSender(client, systemClock);
  const ring = new LatencyRing(Math.max(config.count, 8));
  let failures = 0;

  for (let i = 0; i < config.count; i += 1) {
    const cmd: SendCommand = {
      surface: config.surface,
      roomId: unsafeRoomId(target),
      text: config.text,
    };
    const trace = new Trace(systemClock);
    trace.mark('transport_submit');
    const res = await withTimeout((s) => sender.send(cmd, s), {
      timeoutMs: SEND_TIMEOUT_MS,
      label: 'bench-send',
    }).catch(() => undefined);
    trace.mark('ack_complete');
    const rtt = trace.span('transport_submit', 'ack_complete');

    if (res?.ok === true && rtt !== undefined) {
      ring.add(rtt);
      writeLine(`#${String(i + 1).padStart(3)}  send=${rtt.toFixed(1)}ms`);
    } else {
      failures += 1;
      writeLine(`#${String(i + 1).padStart(3)}  FAILED`);
    }
    if (i + 1 < config.count) await sleep(config.intervalMs);
  }

  report(ring, failures, config);
  if (lanePool !== undefined) {
    for (const st of lanePool.stats) {
      writeLine(
        `  lane ${String(st.id)}: ${st.state} inflight=${String(st.inFlight)} ` +
          `median=${st.medianRttMs === undefined ? '?' : `${st.medianRttMs.toFixed(1)}ms`}`,
      );
    }
  }
  warmer?.stop();
  warmClient?.close();
  lanePool?.close();
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err: unknown) {
    writeErr(`bench failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
