import { parseArgs } from '@std/cli/parse-args';
import {
  type Device,
  type LineLoginOptions,
  type LoginMethod,
  resumeOrLogin,
} from '../adapters/linejs/login.ts';
import { ConfigError } from '../errors/base.ts';
import { Logger } from '../logging/logger.ts';
import { FileSessionStore } from '../session/store.ts';
import { writeErr, writeLine } from './console.ts';
import { renderQr } from './qr.ts';

export const DEVICES: readonly Device[] = [
  'DESKTOPWIN',
  'DESKTOPMAC',
  'ANDROID',
  'ANDROIDSECONDARY',
  'IOS',
  'IOSIPAD',
  'WATCHOS',
  'WEAROS',
];

const USAGE = `
Log a LINE self-bot account in and store its session.

  deno run -A apps/worker/src/cli/login.ts --bot-id <id> [options]

Options
  --bot-id <id>        Required. Our internal id for this account.
  --method <m>         qr (default) | password | token
  --device <d>         ${DEVICES.join(' | ')}   (default DESKTOPWIN)
  --device-model <s>   Device name shown in LINE's own device list
                        (default: a plausible name for --device, never
                        LINEJS's own default which names the library)
  --device-system <s>  System name shown alongside it
  --sessions-dir <p>   Where to store sessions (default .sessions)
  --force              Ignore any stored session and re-authenticate.

Secrets come from the environment, never from flags:
  LINE_EMAIL, LINE_PASSWORD   for --method password
  LINE_PINCODE                optional, for --method password
  LINE_AUTH_TOKEN             for --method token
`.trim();

const requireEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new ConfigError(`missing required environment variable ${name}`);
  }
  return value;
};

function chooseMethod(method: string): LoginMethod {
  if (method === 'token') return { kind: 'authToken', authToken: requireEnv('LINE_AUTH_TOKEN') };
  if (method === 'password') {
    return {
      kind: 'password',
      email: requireEnv('LINE_EMAIL'),
      password: requireEnv('LINE_PASSWORD'),
      pincode: Deno.env.get('LINE_PINCODE'),
    };
  }
  if (method !== 'qr') throw new ConfigError(`unknown --method "${method}"`);
  return { kind: 'qr' };
}

function chooseDevice(device: string): Device {
  const match = DEVICES.find((d) => d === device);
  if (match === undefined) throw new ConfigError(`unknown --device "${device}"`);
  return match;
}

function buildOptions(args: string[]): LineLoginOptions & { force: boolean; dir: string } {
  const flags = parseArgs(args, {
    string: ['bot-id', 'method', 'device', 'device-model', 'device-system', 'sessions-dir'],
    boolean: ['force', 'help'],
    default: { method: 'qr', device: 'DESKTOPWIN', 'sessions-dir': '.sessions' },
  });
  if (flags.help) {
    writeLine(USAGE);
    Deno.exit(0);
  }
  const botId = flags['bot-id'];
  if (botId === undefined || botId.length === 0) {
    throw new ConfigError('--bot-id is required (see --help)');
  }
  const dir = flags['sessions-dir'];
  return {
    dir,
    botId,
    device: chooseDevice(flags.device),
    method: chooseMethod(flags.method),
    storagePath: `${dir}/${encodeURIComponent(botId)}.linejs.json`,
    sessions: new FileSessionStore(dir),
    logger: new Logger({ level: 'info' }),
    deviceModelName: flags['device-model'],
    deviceSystemName: flags['device-system'],
    onQrUrl: (url) => {
      writeLine('');
      writeLine(renderQr(url));
      writeLine('สแกน QR ด้านบนด้วยแอป LINE ของบัญชีนี้ (หรือเปิดลิงก์บนเครื่องนั้น):');
      writeLine(`  ${url}`);
      writeLine('');
      writeLine('!! LINE ให้เวลาประมาณ 2 นาที — ช้ากว่านั้นจะได้ 410 และต้องรันใหม่');
      writeLine('');
    },
    onPincode: (pin) => {
      writeLine('');
      writeLine(`>> ใส่ PIN นี้ในแอป LINE: ${pin}`);
      writeLine('');
    },
    force: flags.force,
  };
}

async function main(): Promise<number> {
  const opts = buildOptions(Deno.args);
  await Deno.mkdir(opts.dir, { recursive: true });
  if (opts.force) await opts.sessions.remove(opts.botId);
  await resumeOrLogin(opts);
  writeLine('');
  writeLine(`Session stored for bot "${opts.botId}".`);
  writeLine(`  session:  ${opts.storagePath.replace('.linejs.json', '.json')}`);
  writeLine(`  linejs:   ${opts.storagePath}`);
  writeLine('Keep these files secret — they are the account credentials.');
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err: unknown) {
    writeErr(`login failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
