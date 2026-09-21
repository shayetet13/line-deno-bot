import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Logger, type LogRecord } from '../../src/logging/logger.ts';
import { FakeClock } from '../../src/lib/clock.ts';

const collector = (): { records: LogRecord[]; sink: (r: LogRecord) => void } => {
  const records: LogRecord[] = [];
  return { records, sink: (r) => void records.push(r) };
};

describe('Logger', () => {
  test('drops records below the configured level', () => {
    const { records, sink } = collector();
    const log = new Logger({ level: 'warn', sink });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  test('emits a structured record with clock-derived time and message', () => {
    const { records, sink } = collector();
    const clock = new FakeClock(0);
    new Logger({ level: 'info', sink, clock }).info('hello', { a: 1 });
    expect(records[0]).toMatchObject({
      level: 'info',
      msg: 'hello',
      a: 1,
      time: '1970-01-01T00:00:00.000Z',
    });
  });

  test('child merges bindings and later fields win', () => {
    const { records, sink } = collector();
    const log = new Logger({ sink }).child({ requestId: 'req-1', scope: 'base' });
    log.info('x', { scope: 'call' });
    expect(records[0]).toMatchObject({ requestId: 'req-1', scope: 'call' });
  });

  test('redacts sensitive top-level keys in both bindings and fields', () => {
    const { records, sink } = collector();
    const log = new Logger({ sink }).child({ token: 'abc' });
    log.error('boom', { password: 'p', Authorization: 'Bearer z', safe: 'ok' });
    expect(records[0]).toMatchObject({
      token: '[redacted]',
      password: '[redacted]',
      Authorization: '[redacted]',
      safe: 'ok',
    });
  });
});
