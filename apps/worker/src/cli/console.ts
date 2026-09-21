const ENCODER = new TextEncoder();

/** Writes a line to stdout without going through `console` (lint: no-console). */
export const writeLine = (text = ''): void => {
  Deno.stdout.writeSync(ENCODER.encode(`${text}\n`));
};

/** Writes a line to stderr. */
export const writeErr = (text: string): void => {
  Deno.stderr.writeSync(ENCODER.encode(`${text}\n`));
};
