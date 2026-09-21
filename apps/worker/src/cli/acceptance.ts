import { parseArgs } from '@std/cli/parse-args';
import { formatReport, runAcceptance } from '../acceptance/report.ts';
import { writeErr, writeLine } from './console.ts';

const USAGE = `
Runs the Phase 10 acceptance table (Phases §18) and prints the result.

  deno task acceptance [--json] [--out <file>]

Every case is an in-process replay against the real pipeline with a fake clock,
so it is deterministic and touches no LINE account. It proves CORRECTNESS.
It does not measure live latency — use \`deno task bench\` on the production
host for that.

Exit code is 1 if any case fails, so this is usable as a release gate.

Options
  --json        Emit the report as JSON instead of a table.
  --out <file>  Also write the JSON report to this path.
`.trim();

async function main(): Promise<number> {
  const flags = parseArgs(Deno.args, { boolean: ['help', 'json'], string: ['out'] });
  if (flags.help === true) {
    writeLine(USAGE);
    return 0;
  }

  const report = await runAcceptance();
  const json = JSON.stringify(report, null, 2);
  writeLine(flags.json === true ? json : formatReport(report));

  if (typeof flags.out === 'string' && flags.out !== '') {
    await Deno.writeTextFile(flags.out, json);
    writeErr(`report written to ${flags.out}`);
  }
  return report.failed === 0 ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main());
