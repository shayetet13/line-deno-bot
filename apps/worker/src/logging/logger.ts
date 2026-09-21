import { LOG_LEVELS, type LogLevel } from '../config/constants.ts';
import { type Clock, systemClock } from '../lib/clock.ts';

export type LogFields = Record<string, unknown>;

export interface LogRecord extends LogFields {
  level: LogLevel;
  time: string;
  msg: string;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  base?: LogFields;
  clock?: Clock;
}

/** Top-level field names never written verbatim (`CLAUDE .md` §4 logging). */
const REDACT_KEYS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'secret',
  'authorization',
  'cookie',
]);

const ENCODER = new TextEncoder();

// stdout can be a slow pipe (especially under a service supervisor).  Writing
// synchronously would pause the one JS event loop shared by every bot and turn
// a log burst into a receive/send latency spike.  Keep ordering, but place I/O
// behind a small bounded queue; a saturated log sink may lose diagnostics, not
// LINE messages.
const STDOUT_QUEUE_MAX = 1_024;
const stdoutQueue: Uint8Array[] = [];
let stdoutDraining = false;

const defaultSink: LogSink = (record) => {
  if (stdoutQueue.length >= STDOUT_QUEUE_MAX) return;
  stdoutQueue.push(ENCODER.encode(`${JSON.stringify(record)}\n`));
  if (stdoutDraining) return;
  stdoutDraining = true;
  queueMicrotask(() => void drainStdout());
};

async function drainStdout(): Promise<void> {
  try {
    while (stdoutQueue.length > 0) {
      const line = stdoutQueue.shift();
      if (line !== undefined) await Deno.stdout.write(line);
    }
  } catch {
    // Logging must never fail the worker or delay a reply retry/recovery path.
  } finally {
    stdoutDraining = false;
    if (stdoutQueue.length > 0) {
      stdoutDraining = true;
      queueMicrotask(() => void drainStdout());
    }
  }
}

const severity = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

/** Structured JSON logger. Pass a correlation id via {@link child} so every line
 * of a request carries it. Metrics/logging must stay off the hot path
 * (Playbook §6.2) — this class only formats and hands off to a sink. */
export class Logger {
  readonly #level: LogLevel;
  readonly #sink: LogSink;
  readonly #base: LogFields;
  readonly #clock: Clock;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? 'info';
    this.#sink = options.sink ?? defaultSink;
    this.#base = options.base ?? {};
    this.#clock = options.clock ?? systemClock;
  }

  child(bindings: LogFields): Logger {
    return new Logger({
      level: this.#level,
      sink: this.#sink,
      base: { ...this.#base, ...redact(bindings) },
      clock: this.#clock,
    });
  }

  debug(msg: string, fields?: LogFields): void {
    this.#emit('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.#emit('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.#emit('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.#emit('error', msg, fields);
  }

  #emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (severity(level) < severity(this.#level)) return;
    const record: LogRecord = {
      ...this.#base,
      ...(fields ? redact(fields) : {}),
      level,
      time: new Date(this.#clock.now()).toISOString(),
      msg,
    };
    this.#sink(record);
  }
}

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}
