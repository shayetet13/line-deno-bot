import { parseArgs } from '@std/cli/parse-args';
import { unsafeBotId, unsafeOwnerId } from '@line-first/contracts';
import { LinejsInboundAdapter } from '../adapters/linejs/inbound.ts';
import { createRacingInbound } from '../adapters/linejs/racing-inbound.ts';
import { RacingInboundAdapter } from '../adapters/racing.ts';
import type { InboundAdapter } from '../adapters/types.ts';
import { type Device, resumeOrLogin } from '../adapters/linejs/login.ts';
import type { InboundEvent } from '../adapters/types.ts';
import { ConfigError } from '../errors/base.ts';
import { systemClock } from '../lib/clock.ts';
import { Logger } from '../logging/logger.ts';
import { MetricsRecorder } from '../metrics/recorder.ts';
import { ReadinessFsm } from '../readiness/state.ts';
import { StatusSource } from '../observability/snapshot.ts';
import { startStatusServer } from '../observability/server.ts';
import { HOT_SEND_ORIGIN } from '../warm/warmer.ts';
import { FileSessionStore } from '../session/store.ts';
import { type ClockOffset, measureClockOffset, offsetMatters } from './clock-skew.ts';
import { writeErr, writeLine } from './console.ts';

const USAGE = `
Watch a logged-in account and report what the connector actually delivers.
Answers the Phase 1b questions: does a push carry the message body, how long
does inbound take, and what arrives on Talk vs Square.

  deno run -A apps/worker/src/cli/probe.ts --bot-id <id> [options]

Options
  --bot-id <id>        Required. Must already have a stored session.
  --sessions-dir <p>   Default .sessions
  --seconds <n>        Stop automatically after n seconds (default: run until Ctrl+C)
  --talk / --no-talk   Listen to Talk       (default on)
  --square/--no-square Listen to OpenChat   (default on)
  --show-text          Print message bodies. OFF by default — rooms are private.
  --race <mid,mid...>  Also run a dedicated poll of these square-chats and race
                       them against push; reports which source saw each first.
  --slots <n>          Max dedicated polls (default 4). Rooms past the budget
                       are covered by push alone (Playbook §5.4).
  --serve <port>       Also serve the operator console on http://127.0.0.1:port
`.trim();

/** Phase 0 target for `event createdTime → payload ready` (Phases §5). */
const INBOUND_BUDGET_MS = 11;

interface Sample {
  surface: string;
  inboundMs: number | undefined;
}

const percentile = (sorted: readonly number[], p: number): number | undefined => {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
};

/** Shortens an id so traces stay useful without pasting full room/user mids. */
const short = (id: string): string => (id.length <= 10 ? id : `${id.slice(0, 8)}…`);

function describe(event: InboundEvent, showText: boolean, inboundMs: number | undefined): string {
  const parts = [
    `[${event.surface}]`,
    `msg=${short(event.messageId)}`,
    `room=${short(event.roomId)}`,
    `from=${short(event.senderId)}`,
    `len=${String(event.text.length)}`,
    `inbound=${inboundMs === undefined ? 'unknown' : `${String(inboundMs)}ms`}`,
  ];
  if (showText) parts.push(`text=${JSON.stringify(event.text)}`);
  return parts.join(' ');
}

function summarise(
  samples: readonly Sample[],
  adapter: InboundAdapter,
  skew: ClockOffset | undefined,
): void {
  const known = samples.map((s) => s.inboundMs).filter((v): v is number => v !== undefined).sort(
    (a, b) => a - b,
  );
  const bySurface = new Map<string, number>();
  for (const s of samples) bySurface.set(s.surface, (bySurface.get(s.surface) ?? 0) + 1);

  writeLine('');
  writeLine('── probe summary ──────────────────────────────');
  writeLine(`events                : ${String(samples.length)}`);
  for (const [surface, count] of bySurface) writeLine(`  ${surface.padEnd(20)}: ${String(count)}`);
  if (adapter instanceof LinejsInboundAdapter) {
    writeLine(`backlog drained       : ${String(adapter.drainedCount)}`);
    writeLine(`dropped (queue full)  : ${String(adapter.droppedCount)}`);
  }
  writeLine(`inbound samples       : ${String(known.length)} of ${String(samples.length)}`);
  if (known.length > 0) {
    const min = known[0] ?? 0;
    const max = known[known.length - 1] ?? 0;
    writeLine(
      `  min / p50 / p95 / max: ${String(min)}ms / ${String(percentile(known, 50))}ms / ` +
        `${String(percentile(known, 95))}ms / ${String(max)}ms`,
    );
    writeLine(`  spread (max − min)  : ${String(max - min)}ms`);
  }
  if (skew !== undefined) {
    writeLine(
      `host clock offset     : ${String(skew.offsetMs)}ms (±${String(skew.uncertaintyMs)}ms, ` +
        `${skew.source}: ${skew.detail})`,
    );
  }
  writeLine('');
  writeLine('Reading this:');
  writeLine("  inbound = local wall clock − createdTime, so it carries this host's");
  writeLine('  clock offset as a CONSTANT. Trust the spread, not the absolute value:');
  writeLine('    small spread → offset dominates; that spread is the real jitter.');
  writeLine('    large spread → genuine delivery jitter (Phases §5).');
  writeLine('  Absolute inbound is only meaningful when the clock offset above is');
  writeLine(
    `  well inside the ${String(INBOUND_BUDGET_MS)}ms budget — chrony gives that, the HTTP Date`,
  );
  writeLine('  fallback (±500ms) does not. Send RTT and the Phase 5 receive-path race');
  writeLine('  are measured on one clock and stay valid either way.');
}

interface ProbeConfig {
  botId: string;
  dir: string;
  seconds: number | undefined;
  talk: boolean;
  square: boolean;
  showText: boolean;
  raceRooms: readonly string[];
  slots: number;
  servePort: number | undefined;
}

function parse(args: string[]): ProbeConfig {
  const flags = parseArgs(args, {
    string: ['bot-id', 'sessions-dir', 'seconds', 'race', 'slots', 'serve'],
    boolean: ['talk', 'square', 'show-text', 'help'],
    default: {
      'sessions-dir': '.sessions',
      talk: true,
      square: true,
      'show-text': false,
      slots: '4',
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
  const seconds = flags.seconds === undefined ? undefined : Number(flags.seconds);
  if (seconds !== undefined && !Number.isFinite(seconds)) {
    throw new ConfigError('--seconds must be a number');
  }
  const raceRooms = (flags.race ?? '').split(',').map((r) => r.trim()).filter((r) => r.length > 0);
  const slots = Number(flags.slots);
  if (!Number.isInteger(slots) || slots < 0) {
    throw new ConfigError('--slots must be an integer >= 0');
  }
  const servePort = flags.serve === undefined ? undefined : Number(flags.serve);
  if (servePort !== undefined && (!Number.isInteger(servePort) || servePort < 1)) {
    throw new ConfigError('--serve must be a port number');
  }
  return {
    botId,
    dir: flags['sessions-dir'],
    seconds,
    talk: flags.talk,
    square: flags.square,
    showText: flags['show-text'],
    raceRooms,
    slots,
    servePort,
  };
}

async function main(): Promise<number> {
  const cfg = parse(Deno.args);
  const logger = new Logger({ level: 'info' });
  const sessions = new FileSessionStore(cfg.dir);
  const stored = await sessions.load(cfg.botId);
  if (stored === null) {
    throw new ConfigError(`no stored session for "${cfg.botId}" — run \`deno task login\` first`);
  }

  const client = await resumeOrLogin({
    botId: cfg.botId,
    device: (stored.extra.device as Device | undefined) ?? 'DESKTOPWIN',
    method: { kind: 'authToken', authToken: stored.authToken },
    storagePath: `${cfg.dir}/${encodeURIComponent(cfg.botId)}.linejs.json`,
    sessions,
    logger,
  });

  const controller = new AbortController();
  const botId = unsafeBotId(cfg.botId);
  const ownerId = unsafeOwnerId('probe-owner');
  let adapter: InboundAdapter;
  let racer: RacingInboundAdapter | undefined;
  if (cfg.raceRooms.length === 0) {
    adapter = new LinejsInboundAdapter({
      client,
      botId,
      ownerId,
      clock: systemClock,
      logger,
      talk: cfg.talk,
      square: cfg.square,
    });
  } else {
    const built = createRacingInbound({
      client,
      botId,
      ownerId,
      clock: systemClock,
      logger,
      talk: cfg.talk,
      square: cfg.square,
      dedicatedRooms: cfg.raceRooms,
      slotBudget: cfg.slots,
    });
    adapter = built.adapter;
    racer = built.adapter;
    writeLine(`dedicated poll slots: ${built.polledRooms.length}/${String(cfg.raceRooms.length)}`);
  }

  const samples: Sample[] = [];
  const stop = (): void => {
    controller.abort();
    void adapter.stop();
  };
  try {
    Deno.addSignalListener('SIGINT', stop);
  } catch {
    // Signals are not available everywhere; --seconds still bounds the run.
  }
  if (cfg.seconds !== undefined) setTimeout(stop, cfg.seconds * 1_000);

  // The console reads only these already-assembled objects, so a dashboard
  // left open adds nothing to the reply path (Playbook §13.3).
  const metrics = new MetricsRecorder();
  const readiness = new ReadinessFsm(systemClock, logger);
  readiness.set({ sessionValid: true, rulesLoaded: true, senderReady: true });
  const server = cfg.servePort === undefined ? undefined : startStatusServer({
    logger,
    port: cfg.servePort,
    source: new StatusSource({
      workerId: `probe-${cfg.botId}`,
      origin: HOT_SEND_ORIGIN,
      clock: systemClock,
      metrics,
      readiness,
      ...(racer === undefined ? {} : { race: racer }),
    }),
  });

  const skew = await measureClockOffset();
  if (skew !== undefined) {
    writeLine(
      `host clock offset: ${String(skew.offsetMs)}ms (±${String(skew.uncertaintyMs)}ms via ` +
        `${skew.source})` +
        (offsetMatters(skew, INBOUND_BUDGET_MS)
          ? `  <-- coarser than the ${
            String(INBOUND_BUDGET_MS)
          }ms budget; absolute inbound is not resolvable`
          : '  <-- fine enough to trust absolute inbound'),
    );
  }

  await adapter.start(controller.signal);
  readiness.set({ receiverSubscribed: true, backlogDrained: true });
  if (server !== undefined) {
    writeLine(`console: http://${server.hostname}:${String(server.port)}/`);
  }
  writeLine('listening — Ctrl+C to stop and print the summary');
  writeLine('');

  for await (const event of adapter.events()) {
    const inboundMs = event.serviceEventTimeMs === undefined
      ? undefined
      : Date.now() - event.serviceEventTimeMs;
    samples.push({ surface: event.surface, inboundMs });
    metrics.count(`surface.${event.surface}`);
    metrics.count(`source.${event.source}`);
    if (inboundMs !== undefined) metrics.recordSpan('inbound', inboundMs);
    writeLine(describe(event, cfg.showText, inboundMs));
  }

  await server?.shutdown();
  summarise(samples, adapter, skew);
  if (racer !== undefined) {
    const st = racer.stats;
    writeLine('');
    writeLine('── source race ────────────────────────────────');
    writeLine(`delivered             : ${String(st.delivered)}`);
    writeLine(`duplicates suppressed : ${String(st.duplicatesSuppressed)}`);
    for (const [src, n] of Object.entries(st.wins)) {
      writeLine(`  won first by ${src.padEnd(14)}: ${String(n)}`);
    }
    writeLine('');
    writeLine('"won first" = that source delivered the message-id before the other.');
    writeLine('A non-zero dedicated-poll count is inbound jitter this can claw back.');
  }
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err: unknown) {
    writeErr(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
