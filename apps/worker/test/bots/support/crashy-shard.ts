/**
 * A stand-in bot shard for crash tests: it answers like the real one, except
 * that a request for `/crash` throws outside any handler, which kills the
 * worker the way an uncaught error inside a real shard would.
 */
import type { ShardCall, ShardReply } from '../../../src/bots/shard-protocol.ts';

interface Scope {
  onmessage: ((event: MessageEvent<ShardCall>) => void) | null;
  postMessage(message: ShardReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as Scope;
const started = new Set<string>();

scope.onmessage = (event: MessageEvent<ShardCall>): void => {
  const call = event.data;
  if (call.op === 'start') started.add(call.botId);
  if (call.op === 'http' && call.request.url.endsWith('/crash')) {
    setTimeout(() => {
      throw new Error('boom');
    }, 0);
    return;
  }
  if (call.op === 'http') {
    const body = new TextEncoder().encode(JSON.stringify({ started: [...started] })).buffer;
    scope.postMessage({ id: call.id, ok: true, value: { status: 200, headers: [], body } }, [body]);
    return;
  }
  scope.postMessage({ id: call.id, ok: true });
};
