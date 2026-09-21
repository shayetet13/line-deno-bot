/**
 * How far this host's clock is from true time, and how much to trust that.
 *
 * Two sources, best first:
 *
 *  - `chrony`     — microsecond accurate, with an honest uncertainty derived
 *                   from the NTP root delay/dispersion. Use this wherever it
 *                   exists (i.e. the Linux measurement hosts).
 *  - `http-date`  — last resort for hosts without chrony. The `Date` header is
 *                   truncated to the second, so its uncertainty is ±500 ms or
 *                   worse: enough to spot a clock that is a second out, useless
 *                   for anything near the 11 ms inbound budget.
 */

const REFERENCE_URLS = [
  'https://obs.line-apps.com/',
  'https://line.me/',
] as const;

const DEFAULT_SAMPLES = 5;
const REQUEST_TIMEOUT_MS = 6_000;
const HEADER_QUANTISATION_MS = 500;
const SEC_TO_MS = 1_000;

export type ClockSource = 'chrony' | 'http-date';

export interface ClockOffset {
  source: ClockSource;
  /** Positive = this host's clock is ahead of true time. */
  offsetMs: number;
  /** How wrong `offsetMs` could be. Compare against your budget before
   * believing any wall-clock-derived latency. */
  uncertaintyMs: number;
  detail: string;
}

/** `true` when the offset is large enough to matter for `budgetMs`. */
export const offsetMatters = (offset: ClockOffset, budgetMs: number): boolean =>
  Math.abs(offset.offsetMs) > budgetMs || offset.uncertaintyMs > budgetMs;

// ── chrony ───────────────────────────────────────────────────────────────────

const CHRONY_FIELDS = {
  systemTime: /^System time\s*:\s*([\d.]+)\s+seconds\s+(fast|slow)\s+of/m,
  rootDelay: /^Root delay\s*:\s*([\d.]+)\s+seconds/m,
  rootDispersion: /^Root dispersion\s*:\s*([\d.]+)\s+seconds/m,
  stratum: /^Stratum\s*:\s*(\d+)/m,
} as const;

function parseChrony(text: string): ClockOffset | undefined {
  const time = CHRONY_FIELDS.systemTime.exec(text);
  if (time?.[1] === undefined) return undefined;
  const magnitudeMs = Number(time[1]) * SEC_TO_MS;
  if (!Number.isFinite(magnitudeMs)) return undefined;

  // chrony reports the host as "fast of" (ahead) or "slow of" (behind) NTP.
  const offsetMs = time[2] === 'slow' ? -magnitudeMs : magnitudeMs;
  const delayMs = Number(CHRONY_FIELDS.rootDelay.exec(text)?.[1] ?? 0) * SEC_TO_MS;
  const dispersionMs = Number(CHRONY_FIELDS.rootDispersion.exec(text)?.[1] ?? 0) * SEC_TO_MS;
  const stratum = CHRONY_FIELDS.stratum.exec(text)?.[1] ?? '?';

  return {
    source: 'chrony',
    offsetMs: Number(offsetMs.toFixed(3)),
    // Standard NTP error bound: dispersion plus half the round-trip delay.
    uncertaintyMs: Number((dispersionMs + delayMs / 2).toFixed(3)),
    detail: `stratum ${stratum}`,
  };
}

async function readChrony(): Promise<ClockOffset | undefined> {
  try {
    const output = await new Deno.Command('chronyc', {
      args: ['tracking'],
      stdout: 'piped',
      stderr: 'null',
    }).output();
    if (!output.success) return undefined;
    return parseChrony(new TextDecoder().decode(output.stdout));
  } catch {
    return undefined; // not installed, or --allow-run withheld
  }
}

// ── HTTP Date fallback ───────────────────────────────────────────────────────

interface Reading {
  offsetMs: number;
  rttMs: number;
  url: string;
}

async function readOnce(url: string): Promise<Reading | undefined> {
  const before = Date.now();
  const response = await fetch(url, {
    method: 'HEAD',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
  const after = Date.now();
  if (response === undefined) return undefined;
  await response.body?.cancel();

  const header = response.headers.get('date');
  if (header === null) return undefined;
  const secondStartMs = Date.parse(header);
  if (!Number.isFinite(secondStartMs)) return undefined;

  // `Date` is truncated to the second: the response was generated somewhere in
  // [secondStart, secondStart + 1000). Compare against the midpoint so readings
  // are not biased ~500 ms high, and carry the rest as uncertainty.
  const serverMs = secondStartMs + HEADER_QUANTISATION_MS;
  return { offsetMs: Math.round((before + after) / 2 - serverMs), rttMs: after - before, url };
}

async function readHttpDate(samples: number): Promise<ClockOffset | undefined> {
  const readings: Reading[] = [];
  for (const url of REFERENCE_URLS) {
    for (let i = 0; i < samples; i += 1) {
      const reading = await readOnce(url);
      if (reading !== undefined) readings.push(reading);
    }
    if (readings.length > 0) break;
  }
  if (readings.length === 0) return undefined;

  // Lowest round trip wins, for the reason NTP prefers it: a fast exchange
  // leaves the least room for the true offset to hide in.
  const best = readings.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
  return {
    source: 'http-date',
    offsetMs: best.offsetMs,
    uncertaintyMs: Math.round(best.rttMs / 2) + HEADER_QUANTISATION_MS,
    detail: `${String(readings.length)} samples via ${best.url}`,
  };
}

/**
 * Measures this host's clock offset, preferring chrony.
 *
 * NEVER subtract the result from a latency figure — report it alongside, so a
 * reader can judge how much of that figure is clock error (Phases §5).
 */
export async function measureClockOffset(samples = DEFAULT_SAMPLES): Promise<
  ClockOffset | undefined
> {
  return (await readChrony()) ?? (await readHttpDate(samples));
}
