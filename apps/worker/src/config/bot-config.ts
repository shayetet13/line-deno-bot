import { ConfigError } from '../errors/base.ts';
import { MATCH_KINDS, type MatchKind, type RuleSpec } from '../core/rules/types.ts';
import { DEFAULT_FAST_ROUTE_THRESHOLD_MS } from '../transport/lane.ts';

/**
 * Per-bot configuration: which rooms, which senders, which rules.
 *
 * Separate from {@link ../config/env.ts} on purpose. Env holds knobs that tune
 * the machinery (TTLs, limits, timeouts); this holds the answers to "what is
 * this bot actually for", which change per account and per game and must be
 * editable without a redeploy.
 *
 * Validation is hand-rolled and collects every problem before throwing (same
 * reasoning as ADR-0004): a config with four mistakes should report four, not
 * make the operator find them one restart at a time.
 */

export interface BotConfig {
  botId: string;
  /** Owner this bot answers for. Sharding and the room-answer claim key off
   * this, so it must be the real owner id, not the bot id. */
  ownerId: string;
  talk: boolean;
  square: boolean;
  /** Square chats to give a dedicated poll, most important first. */
  dedicatedRooms: readonly string[];
  /** Rooms selected on the groups page. Absent keeps the historical
   * behaviour (answer every room); once the operator saves a selection the
   * worker answers only those destinations. */
  selectedRooms?: readonly string[] | undefined;
  slotBudget: number;
  /** Sender ids allowed to start a job. `undefined` (key absent or `null`) =
   * anyone; an empty array closes the bot completely. Deliberately different. */
  allowedSenders: readonly string[] | undefined;
  rules: readonly RuleSpec[];
  /**
   * When true the worker runs the whole pipeline but never posts. Default TRUE
   * — a bot that posts into a real room on its first start because someone
   * forgot a flag is a worse failure than one that stays quiet.
   */
  dryRun: boolean;
  /** Owned HTTP/2 lanes for the send path. 0 = let the runtime pick. */
  lanes: number;
  /** Low-numbered owned lanes kept free of continuous poll traffic. */
  sendReservedLanes: number;
  /** How many of those reply lanes are held back as congestion spares — idle
   * until every primary reply lane is busy. Carved out of
   * `sendReservedLanes`: 8 reserved with 4 spare means four primary lanes
   * carrying replies and four waiting for overflow. */
  sendSpareLanes: number;
  /** A reply send at or under this keeps its lane and earns a rabbit; over it
   * — on a lane it had to itself — the lane earns a turtle and the next reply
   * picks a different one. Tunable because the achievable floor is a property
   * of the route, not of this code: too low and nothing ever qualifies, so
   * the pool falls back to plain fastest-lane routing. */
  fastRouteThresholdMs: number;
  /** Keep the send origin hot between jobs. */
  warmIntervalMs: number;
  /** How often a dedicated poll (see `dedicatedRooms`) re-checks a watched
   * room. Tighter = lower worst-case inbound latency on that room, at the
   * cost of more requests per polled room. 0 = poll again immediately after
   * each round settles (Playbook §5.4). */
  pollIntervalMs: number;
  /** Hold the next dedicated room poll briefly after a reply starts. This
   * prevents LINE's per-account poll handling from delaying that send. */
  pollQuietMs: number;
  /** How many fetches a dedicated poll races per round, all against the same
   * cursor — whichever returns first wins, shrinking the window in which a
   * message that lands mid-flight stays invisible. 1 (default) keeps a
   * single fetch in flight, self-throttling to one round-trip at a time
   * regardless of `pollIntervalMs`. Costs one extra concurrent request per
   * added width. */
  squarePollRaceWidth: number;
  /** How many dedicated-poll fetches stay in flight, launched evenly across
   * one round trip, once the backlog is drained. Shrinks the window in which
   * a newly posted message is invisible from ~1 RTT to ~RTT / N. 1 (default)
   * keeps one fetch at a time. Cannot be combined with
   * `squarePollRaceWidth > 1`. */
  squarePollStagger: number;
  /** Gap between background read-only probes of the reply lanes (see
   * `transport/reply-scout.ts`). Each probe measures one lane, keeps it warm,
   * and lets the pin move to a lane that has become measurably faster. 0
   * turns the scout off and leaves replies on the reply-path pin alone. */
  replyProbeIntervalMs: number;
}

class Problems {
  readonly list: string[] = [];

  add(message: string): void {
    this.list.push(message);
  }

  str(value: unknown, path: string, fallback?: string): string {
    if (typeof value === 'string' && value.length > 0) return value;
    if (fallback !== undefined) return fallback;
    this.add(`${path}: expected a non-empty string`);
    return '';
  }

  bool(value: unknown, path: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    this.add(`${path}: expected true or false`);
    return fallback;
  }

  int(value: unknown, path: string, fallback: number, min = 0): number {
    if (value === undefined) return fallback;
    if (Number.isInteger(value) && (value as number) >= min) return value as number;
    this.add(`${path}: expected an integer >= ${String(min)}`);
    return fallback;
  }

  strings(value: unknown, path: string): readonly string[] {
    if (!Array.isArray(value)) {
      this.add(`${path}: expected an array of strings`);
      return [];
    }
    const out: string[] = [];
    value.forEach((entry, i) => {
      if (typeof entry === 'string' && entry.length > 0) out.push(entry);
      else this.add(`${path}[${String(i)}]: expected a non-empty string`);
    });
    return out;
  }
}

function readRule(raw: unknown, index: number, p: Problems): RuleSpec | undefined {
  const path = `rules[${String(index)}]`;
  if (typeof raw !== 'object' || raw === null) {
    p.add(`${path}: expected an object`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  if (typeof kind !== 'string' || !(MATCH_KINDS as readonly string[]).includes(kind)) {
    p.add(`${path}.kind: expected one of ${MATCH_KINDS.join('|')}`);
    return undefined;
  }
  const id = p.str(r['id'], `${path}.id`);
  const pattern = p.str(r['pattern'], `${path}.pattern`);
  const reply = p.str(r['reply'], `${path}.reply`);
  const priority = p.int(r['priority'], `${path}.priority`, 0, -1_000_000);
  if (r['flags'] !== undefined) {
    p.add(`${path}.flags: regex rules are no longer supported; use exact, prefix, or contains`);
  }
  if (id === '' || pattern === '' || reply === '') return undefined;
  return {
    id,
    priority,
    kind: kind as MatchKind,
    pattern,
    reply,
  };
}

/** Parses an already-decoded JSON value. Split from file reading so it can be
 * tested without touching the disk. */
export function parseBotConfig(raw: unknown, source = '<inline>'): BotConfig {
  const p = new Problems();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source}: expected a JSON object at the top level`);
  }
  const o = raw as Record<string, unknown>;

  const botId = p.str(o['botId'], 'botId');
  const ownerId = p.str(o['ownerId'], 'ownerId');

  const rulesRaw = o['rules'];
  const rules: RuleSpec[] = [];
  if (!Array.isArray(rulesRaw)) {
    p.add('rules: expected an array');
  } else if (rulesRaw.length === 0) {
    p.add('rules: at least one rule is required — a bot with no rules answers nothing');
  } else {
    rulesRaw.forEach((entry, i) => {
      const rule = readRule(entry, i, p);
      if (rule !== undefined) rules.push(rule);
    });
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) p.add(`rules: duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
  }

  // `null` reads as "no allowlist" so the key can stay visible in the file;
  // an empty array still means "allow nobody".
  const allowedRaw = o['allowedSenders'];
  const allowedSenders = allowedRaw === undefined || allowedRaw === null
    ? undefined
    : p.strings(allowedRaw, 'allowedSenders');

  const talk = p.bool(o['talk'], 'talk', false);
  const square = p.bool(o['square'], 'square', true);
  if (!talk && !square) p.add('talk and square are both false — nothing would be received');

  const dedicatedRooms = o['dedicatedRooms'] === undefined
    ? []
    : p.strings(o['dedicatedRooms'], 'dedicatedRooms');
  const selectedRooms = o['selectedRooms'] === undefined || o['selectedRooms'] === null
    ? undefined
    : p.strings(o['selectedRooms'], 'selectedRooms');

  const lanes = p.int(o['lanes'], 'lanes', 0);
  const sendReservedLanes = p.int(
    o['sendReservedLanes'],
    'sendReservedLanes',
    lanes > 1 ? 1 : 0,
  );
  if (sendReservedLanes >= lanes && sendReservedLanes !== 0) {
    p.add('sendReservedLanes: must be less than lanes so poll traffic has a fallback lane');
  }

  const sendSpareLanes = p.int(o['sendSpareLanes'], 'sendSpareLanes', 0);
  if (sendSpareLanes > 0 && sendSpareLanes >= sendReservedLanes) {
    p.add(
      'sendSpareLanes: must be less than sendReservedLanes so at least one primary reply lane is left',
    );
  }
  // A quiet window delays the next trigger after a reply. It is opt-in because
  // one-shot races value the next keyword more than avoiding a small amount of
  // same-account poll contention; VPS1 production also runs with 0ms.
  const pollQuietMs = p.int(o['pollQuietMs'], 'pollQuietMs', 0);
  if (pollQuietMs > 40) p.add('pollQuietMs: expected an integer between 0 and 40');

  // Unlike every other poll knob, this one is a direct concurrency
  // multiplier: it fires `squarePollRaceWidth` simultaneous fetches per
  // dedicated room, every round. A typo or an over-eager "make it faster"
  // edit (e.g. 50) would turn `pollIntervalMs: 0` into a sustained flood
  // against LINE with no other guard rail in front of it.
  const squarePollRaceWidth = p.int(o['squarePollRaceWidth'], 'squarePollRaceWidth', 1, 1);
  if (squarePollRaceWidth > 4) {
    p.add('squarePollRaceWidth: expected an integer between 1 and 4');
  }
  // Same flood guard: each step is one more request in flight per room.
  const squarePollStagger = p.int(o['squarePollStagger'], 'squarePollStagger', 1, 1);
  if (squarePollStagger > 4) {
    p.add('squarePollStagger: expected an integer between 1 and 4');
  }
  if (squarePollStagger > 1 && squarePollRaceWidth > 1) {
    p.add('squarePollStagger: cannot be combined with squarePollRaceWidth > 1');
  }

  // One probe per interval, spread over the reply lanes. Below 200ms the
  // probes stop being background work; the scout is off at 0.
  const replyProbeIntervalMs = p.int(o['replyProbeIntervalMs'], 'replyProbeIntervalMs', 1_000, 0);
  if (replyProbeIntervalMs > 0 && replyProbeIntervalMs < 200) {
    p.add('replyProbeIntervalMs: expected 0 (off) or an integer >= 200');
  }

  const config: BotConfig = {
    botId,
    ownerId,
    talk,
    square,
    dedicatedRooms,
    selectedRooms,
    slotBudget: p.int(o['slotBudget'], 'slotBudget', 4),
    allowedSenders,
    rules,
    // Absent means dry run. Posting for real is an explicit `false`.
    dryRun: p.bool(o['dryRun'], 'dryRun', true),
    lanes,
    sendReservedLanes,
    sendSpareLanes,
    fastRouteThresholdMs: p.int(
      o['fastRouteThresholdMs'],
      'fastRouteThresholdMs',
      DEFAULT_FAST_ROUTE_THRESHOLD_MS,
      1,
    ),
    warmIntervalMs: p.int(o['warmIntervalMs'], 'warmIntervalMs', 15_000, 1_000),
    // 0 is a real, designed mode ("poll again immediately" — square-poll.ts,
    // Playbook §5.4), not a typo to guard against.
    pollIntervalMs: p.int(o['pollIntervalMs'], 'pollIntervalMs', 100, 0),
    pollQuietMs,
    squarePollRaceWidth,
    squarePollStagger,
    replyProbeIntervalMs,
  };

  if (p.list.length > 0) {
    throw new ConfigError(`invalid bot config (${source}):\n- ${p.list.join('\n- ')}`, {
      source,
      errors: p.list,
    });
  }
  return config;
}

export async function loadBotConfig(path: string): Promise<BotConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err: unknown) {
    throw new ConfigError(
      `cannot read bot config "${path}": ${err instanceof Error ? err.message : String(err)}`,
      { path },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    throw new ConfigError(
      `bot config "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { path },
    );
  }
  return parseBotConfig(parsed, path);
}
