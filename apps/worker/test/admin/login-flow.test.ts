import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Client } from '@evex/linejs';
import type { LineLoginOptions } from '../../src/adapters/linejs/login.ts';
import { LoginFlow } from '../../src/admin/login-flow.ts';
import { ValidationError } from '../../src/errors/base.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import { MemorySessionStore } from '../../src/session/store.ts';

/**
 * `LoginFlow` wraps `loginToLine`, which needs a real LINE account to run for
 * real — so every test here injects `loginFn`. What is under test is the
 * state machine, not LINEJS.
 */

/** Flushes several microtask ticks — robust to exactly how many .then/.catch/
 * .finally links sit between the injected promise settling and LoginFlow
 * updating its own state, rather than hardcoding a tick count. */
const settle = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

interface Gate {
  resolve: (client: Client) => void;
  reject: (err: unknown) => void;
  opts: LineLoginOptions;
}

const make = (onSuccess?: () => void | Promise<void>) => {
  const clock = new FakeClock();
  let gate: Gate | undefined;
  const loginFn = (opts: LineLoginOptions): Promise<Client> =>
    new Promise<Client>((resolve, reject) => {
      gate = { resolve, reject, opts };
    });
  const flow = new LoginFlow({
    botId: 'bot-1',
    device: 'DESKTOPWIN',
    storagePath: '/tmp/does-not-matter.json',
    sessions: new MemorySessionStore(),
    logger: new Logger({ level: 'error', sink: () => {} }),
    clock,
    loginFn: loginFn as unknown as typeof import('../../src/adapters/linejs/login.ts').loginToLine,
    onSuccess,
  });
  return { flow, clock, gate: () => gate };
};

describe('LoginFlow', () => {
  test('starts idle', () => {
    expect(make().flow.state).toEqual({ status: 'idle' });
  });

  test('start() moves to running and records when it began', () => {
    const { flow, clock } = make();
    clock.advance(5_000);
    flow.start();
    expect(flow.state).toMatchObject({ status: 'running', startedAtMono: 5_000 });
  });

  test('a second start() while one is running is refused — no competing login', () => {
    const { flow } = make();
    flow.start();
    expect(() => flow.start()).toThrow(ValidationError);
  });

  test('onQrUrl and onPincode from the underlying login populate state as they arrive', () => {
    const { flow, gate } = make();
    flow.start();
    expect(flow.state).toMatchObject({ qrUrl: undefined, pin: undefined });

    gate()?.opts.onQrUrl?.('https://line.me/R/ti/p/abc123');
    expect(flow.state).toMatchObject({ status: 'running', qrUrl: 'https://line.me/R/ti/p/abc123' });

    gate()?.opts.onPincode?.('1234');
    expect(flow.state).toMatchObject({ status: 'running', pin: '1234' });
    // The QR url set earlier is not clobbered by the pincode arriving.
    expect(flow.state).toMatchObject({ qrUrl: 'https://line.me/R/ti/p/abc123' });
  });

  test('a successful login moves to success and stamps the time it finished', async () => {
    const { flow, clock, gate } = make();
    flow.start();
    clock.advance(9_000);
    gate()?.resolve({ authToken: 'tok' } as unknown as Client);
    await settle();
    expect(flow.state).toEqual({ status: 'success', savedAtMs: 9_000 });
  });

  test('a successful login invokes the connection callback once', async () => {
    let calls = 0;
    const { flow, gate } = make(() => {
      calls += 1;
    });
    flow.start();
    gate()?.resolve({ authToken: 'tok' } as unknown as Client);
    await settle();
    expect(calls).toBe(1);
  });

  test('a failed login moves to error with the message, and frees the flow to run again', async () => {
    const { flow, gate } = make();
    flow.start();
    gate()?.reject(new Error('LINE ปฏิเสธ'));
    await settle();
    expect(flow.state).toEqual({ status: 'error', message: 'LINE ปฏิเสธ' });
    // Not stuck "running" forever — a fresh attempt can start.
    expect(() => flow.start()).not.toThrow();
  });

  test('a non-Error rejection still produces a readable message', async () => {
    const { flow, gate } = make();
    flow.start();
    gate()?.reject('boom');
    await settle();
    expect(flow.state).toEqual({ status: 'error', message: 'boom' });
  });

  test('reset() returns to idle after a terminal state', async () => {
    const { flow, gate } = make();
    flow.start();
    gate()?.reject(new Error('x'));
    await settle();
    flow.reset();
    expect(flow.state).toEqual({ status: 'idle' });
  });

  test('reset() mid-flight is refused — must not orphan a running LINEJS login', () => {
    const { flow } = make();
    flow.start();
    expect(() => flow.reset()).toThrow(ValidationError);
    expect(flow.state.status).toBe('running');
  });

  test('passes botId, device and storagePath through to the login call', () => {
    const { flow, gate } = make();
    flow.start();
    expect(gate()?.opts).toMatchObject({
      botId: 'bot-1',
      device: 'DESKTOPWIN',
      storagePath: '/tmp/does-not-matter.json',
      method: { kind: 'qr' },
    });
  });
});

describe('LoginFlow.elapsedMs', () => {
  test('undefined while idle', () => {
    expect(make().flow.elapsedMs).toBeUndefined();
  });

  test('tracks the clock from the moment start() was called', () => {
    const { flow, clock } = make();
    clock.advance(1_000);
    flow.start();
    expect(flow.elapsedMs).toBe(0);
    clock.advance(7_500);
    expect(flow.elapsedMs).toBe(7_500);
  });

  test('undefined again once the attempt settles', async () => {
    const { flow, gate } = make();
    flow.start();
    gate()?.resolve({ authToken: 'tok' } as unknown as Client);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(flow.elapsedMs).toBeUndefined();
  });
});
