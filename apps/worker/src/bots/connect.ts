import { unsafeBotId, unsafeOwnerId } from '@line-first/contracts';
import type { Client } from '@evex/linejs';
import type { BotConfig } from '../config/bot-config.ts';
import type { WorkerConfig } from '../config/env.ts';
import { createRacingInbound } from '../adapters/linejs/racing-inbound.ts';
import { type Device, resumeStoredSession } from '../adapters/linejs/login.ts';
import { LinejsSender } from '../adapters/linejs/sender.ts';
import { installLaneRoleHints, type SendPreflightResult } from '../adapters/linejs/lane-role.ts';
import { installReqseqTimer, installThriftEncodeTimer } from '../adapters/linejs/thrift-timing.ts';
import { SquarePollQuietGate } from '../adapters/linejs/poll-quiet.ts';
import { DryRunSender } from '../adapters/dry-run.ts';
import type { Sender } from '../adapters/types.ts';
import { systemClock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import type { SessionStore } from '../session/store.ts';
import { createH2PushFetch, createOwnedLanePool } from '../transport/index.ts';
import { ReplyRouteScout } from '../transport/reply-scout.ts';
import { createWarmHttpClient } from '../warm/http-client.ts';
import { HOT_SEND_ORIGIN, TransportWarmer } from '../warm/warmer.ts';
import { RecoveryExecutor } from '../worker/recovery-executor.ts';
import { Worker } from '../worker/worker.ts';

/** Forces out `BufferedFileStorage`'s debounced write, if that is what the
 * client's session storage happens to be — duck-typed rather than an
 * `instanceof` so a client built with a different `storage` (a test's
 * `MemoryStorage`, say) is simply a no-op here instead of a type error. */
export async function flushSessionStorage(client: Client): Promise<void> {
  const storage = client.base.storage as { flushNow?: () => Promise<void> };
  await storage.flushNow?.();
}

export async function connectToLine(opts: {
  bot: BotConfig;
  env: WorkerConfig;
  dryRun: boolean;
  showText: boolean;
  device: Device;
  linejsStoragePath: string;
  sessions: SessionStore;
  logger: Logger;
  /** Called by the recovery ladder when a rung needs the bot's connection
   * rebuilt. The caller (`BotHost`) restarts only THIS bot: other people's
   * bots share the process and must not notice. */
  onRecoveryRestart: (rung: string) => void;
}) {
  const { bot, env, dryRun, showText, device, linejsStoragePath, sessions, logger } = opts;
  const restartForRecovery = (rung: string): void => {
    logger.warn('recovery restarting bot connection', { rung });
    opts.onRecoveryRestart(rung);
  };

  // Owned lanes replace the runtime's socket choice for LINEJS's transport.
  // With lanes: 0 the runtime pools for us and there is nothing to own.
  const lanePool = bot.lanes > 0
    ? createOwnedLanePool({
      clock: systemClock,
      logger,
      lanes: bot.lanes,
      sendReservedLanes: bot.sendReservedLanes,
      sendSpareLanes: bot.sendSpareLanes,
      fastRouteThresholdMs: bot.fastRouteThresholdMs,
      // Keep the instantaneous lane-switch line separate from the tail
      // admission limit. A 20–23ms reply is still usable, while only a
      // sustained send p95 above the pool's 27ms ceiling loses eligibility.
      // Passing the switch threshold here used to make one normal 21–22ms
      // sample exclude a healthy route and churn the pinned connection.
    })
    : undefined;
  const warmClient = lanePool === undefined ? createWarmHttpClient() : undefined;
  const httpFetch = lanePool === undefined ? warmClient : lanePool.fetch;
  const pushClient = createH2PushFetch({ origin: 'https://legy.line-apps.com' });

  try {
    // resumeStoredSession, not resumeOrLogin: this process is unattended (no
    // terminal to show a QR, no operator to type a password), so there is no
    // second method to usefully fall back to. Passing the stored token again
    // AS the fallback method is exactly the mistake that took the account
    // offline once already — see resumeOrLogin's own docs. It throws
    // PermanentAuthError when there is no session, or LINE rejected it; the
    // caller catches that and falls back to a dashboard-only process instead
    // of exiting.
    const client = await resumeStoredSession({
      botId: bot.botId,
      device,
      storagePath: linejsStoragePath,
      sessions,
      logger,
      ...(httpFetch === undefined ? {} : { httpFetch }),
      // `/PUSH` keeps its request body open for the connection lifetime. The
      // owned lane transport buffers request bodies for tiny Thrift RPCs, so
      // routing PUSH through it deadlocked before a socket was opened and every
      // retry stranded another poll lane. A separate Node H2 sidecar preserves
      // full duplex streaming and remains independent from reply lanes.
      httpPushFetch: pushClient,
    });
    // LINEJS keeps its PUSH reconnect loop detached. Surface only terminal
    // pusher errors here — logging every frame would itself add work to the hot
    // path, while suppressing these errors previously made a connected-but-dead
    // push stream indistinguishable from a healthy slow loser.
    client.base.on('log', ({ type, data }) => {
      if (!type.startsWith('LegyPusherError')) return;
      logger.warn('LINE push transport error', {
        type,
        reason: data instanceof Error ? data.message : String(data),
      });
    });

    // The hint is consumed and removed by LanePool. Install only when that pool
    // exists; a plain runtime fetch must never leak the private header to LINE.
    const laneHints = lanePool === undefined ? undefined : installLaneRoleHints(client);

    const pollQuiet = new SquarePollQuietGate(
      systemClock,
      bot.dedicatedRooms.slice(0, bot.slotBudget),
      bot.pollQuietMs,
    );

    // The worker must never make a real reply pay TCP/TLS setup while changing
    // away from a >23ms route. Prepare the complete reply band before listening.
    await lanePool?.primeSendLanes(HOT_SEND_ORIGIN);
    // HEAD only proves that TCP/TLS is up; Talk noop did not predict Square's
    // 19-23ms send path. Use a read-only Square RPC for the actual room on every
    // exact reply lane, and keep those probes separate from real send p50/p95.
    // With the scout on, take enough rounds that it can rank every lane — and
    // pin the fastest — before the first key can arrive.
    // Only an OpenChat id can take a Square read: a Talk or OA id would make
    // every probe fail.
    const preflightRoom = bot.dedicatedRooms[0] ??
      bot.selectedRooms?.find((room) => room.startsWith('m'));
    const scoutOn = bot.replyProbeIntervalMs > 0 && lanePool !== undefined;
    const preflight = laneHints === undefined || preflightRoom === undefined
      ? undefined
      : await preflightRounds(
        laneHints,
        bot.sendReservedLanes,
        preflightRoom,
        scoutOn ? STARTUP_PREFLIGHT_ROUNDS : 1,
      );
    const scout = lanePool === undefined || laneHints === undefined ||
        preflightRoom === undefined || !scoutOn
      ? undefined
      : new ReplyRouteScout({
        pool: lanePool,
        probe: (laneId) => laneHints.probeSendLane(laneId, preflightRoom),
        clock: systemClock,
        logger,
        intervalMs: bot.replyProbeIntervalMs,
        warmOrigin: SQUARE_RPC_ORIGIN,
      });
    scout?.evaluate();
    if (preflight !== undefined) {
      const failed = preflight.filter((probe) => !probe.ok);
      logger.info('reply lane preflight complete', {
        lanes: preflight.length,
        passed: preflight.length - failed.length,
        failed: failed.map((probe) => probe.laneId),
      });
      for (const probe of failed) {
        logger.warn('reply lane preflight failed', { lane: probe.laneId, reason: probe.reason });
      }
    }

    const sendWarmFetch = lanePool?.fetchFor('send');
    const maintainedWarmFetch = lanePool === undefined || sendWarmFetch === undefined
      ? httpFetch
      : async (info: string, init?: RequestInit): Promise<Response> => {
        // Age rotation is background-only. If a poll lane needs replacement,
        // connect and probe it here before normal poll routing can see it.
        await lanePool.maintain(info);
        return await sendWarmFetch(info, init);
      };

    const warmer = new TransportWarmer({
      clock: systemClock,
      logger,
      intervalMs: bot.warmIntervalMs,
      ...(maintainedWarmFetch === undefined ? {} : { fetchFn: maintainedWarmFetch }),
    });

    const { adapter, polledRooms, setRooms } = createRacingInbound({
      client,
      botId: unsafeBotId(bot.botId),
      ownerId: unsafeOwnerId(bot.ownerId),
      clock: systemClock,
      logger,
      talk: bot.talk,
      square: bot.square,
      dedicatedRooms: bot.dedicatedRooms,
      slotBudget: bot.slotBudget,
      pollIntervalMs: bot.pollIntervalMs,
      pollRaceWidth: bot.squarePollRaceWidth,
      pollStagger: bot.squarePollStagger,
      pollQuiet,
      pushStatus: () => pushClient.pushHealth,
    });

    // Installed even in dry-run mode: LinejsSender simply never runs when
    // DryRunSender is the active sender, so there is nothing for the timer to
    // measure yet, but the client is the same one a later `dryRun: false` will
    // use without a restart-order dependency to get wrong.
    const sender: Sender = dryRun
      ? new DryRunSender(systemClock, logger, showText)
      : new LinejsSender(client, systemClock, pollQuiet);

    const worker = new Worker({
      bot,
      env,
      adapter,
      sender,
      clock: systemClock,
      logger,
      racer: adapter,
      warmer,
      lanePool,
      pushHealth: adapter,
      recovery: new RecoveryExecutor({
        logger,
        lanePool,
        hooks: {
          // Poll/PUSH objects cannot be safely rebuilt beneath the synchronous
          // inbound sink. A supervised process restart reconstructs both, clears
          // any stuck H2 stream, and is deliberately scheduled off the reply path.
          rearmPoll: () => restartForRecovery('rearm-poll'),
          reconnectSession: () => restartForRecovery('reconnect-session'),
          restartWorker: () => restartForRecovery('restart-worker'),
        },
      }),
    });
    // `native-encode-relay` (docs/experiments.md) already measured writeThrift
    // itself at ~0.06ms — not the bottleneck. `sequence_prep` (getReqseq, the
    // storage-backed sequence allocation LINEJS awaits before encoding) was the
    // planned next layer to check and was never actually wired up. Both ride on
    // the existing `SpanName`s (metrics/trace.ts) so they show up in
    // `/api/status` next to `send` with zero new plumbing.
    installThriftEncodeTimer(
      client,
      systemClock,
      (sample) => worker.metrics.recordSpan('protocol_prep', sample.encodeMs),
    );
    installReqseqTimer(
      client,
      systemClock,
      (sample) => worker.metrics.recordSpan('sequence_prep', sample.durationMs),
    );
    return {
      worker,
      adapter,
      polledRooms,
      setRooms,
      warmer,
      lanePool,
      scout,
      warmClient,
      pushClient,
      client,
    };
  } catch (error: unknown) {
    // `BotHost` owns a fully constructed runtime, but it cannot tear down a
    // half-built one. Close every transport created above here so a rejected
    // session or failed preflight does not accumulate sockets across retries.
    pushClient.close();
    lanePool?.close();
    warmClient?.close();
    throw error;
  }
}

export type LineRuntime = Awaited<ReturnType<typeof connectToLine>>;

/** Where Square RPCs go in LINEJS's default (plain LEGY) mode. A re-rolled
 * reply lane opens its connection here before it is probed. */
const SQUARE_RPC_ORIGIN = 'https://legy.line-apps.com/SQ1';
/** The scout ranks a lane only after three probes; take them at startup. */
const STARTUP_PREFLIGHT_ROUNDS = 3;

/** Runs the startup preflight `rounds` times and reports the last round —
 * the one taken on connections that are warm by then. */
async function preflightRounds(
  hints: { preflightSendLanes: (lanes: number, room: string) => Promise<SendPreflightResult[]> },
  lanes: number,
  room: string,
  rounds: number,
): Promise<SendPreflightResult[]> {
  let last: SendPreflightResult[] = [];
  for (let round = 0; round < rounds; round += 1) {
    last = await hints.preflightSendLanes(lanes, room);
  }
  return last;
}
