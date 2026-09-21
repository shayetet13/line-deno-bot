import type { Client } from '@evex/linejs';
import type { RawLineMessage } from './normalize.ts';
import type { SquareEventFetcher, SquareEventPage } from './square-poll.ts';

/** The bits of a per-chat square event we read. `fetchSquareChatEvents` uses
 * `SEND_MESSAGE` / `RECEIVE_MESSAGE` — NOT the `NOTIFICATION_MESSAGE` shape the
 * account-wide push stream uses (LINEJS `SquareChat.listen`). */
interface LooseSquareMessage {
  message?: {
    id?: unknown;
    to?: unknown;
    from?: unknown;
    text?: unknown;
    createdTime?: unknown;
  };
}

interface LooseSquareEvent {
  type?: string;
  payload?: {
    sendMessage?: { squareMessage?: LooseSquareMessage };
    receiveMessage?: { squareMessage?: LooseSquareMessage };
  };
}

interface LooseFetchResult {
  events?: readonly LooseSquareEvent[];
  syncToken?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toRawMessage(event: LooseSquareEvent): RawLineMessage | null {
  const sm = event.type === 'SEND_MESSAGE'
    ? event.payload?.sendMessage?.squareMessage
    : event.type === 'RECEIVE_MESSAGE'
    ? event.payload?.receiveMessage?.squareMessage
    : undefined;
  const m = sm?.message;
  if (m?.id === undefined) return null;
  return {
    to: { id: str(m.to) },
    from: { id: str(m.from) },
    text: str(m.text),
    raw: { message: { id: str(m.id), createdTime: m.createdTime } },
  };
}

/**
 * Builds the {@link SquareEventFetcher} the poll adapter needs, backed by
 * LINEJS's per-chat event fetch (`fetchSquareChatEvents` — the true dedicated
 * room cursor, Playbook §5.1).
 */
export function makeLinejsSquareFetcher(client: Client, squareChatMid: string): SquareEventFetcher {
  return async (syncToken: string | undefined, signal: AbortSignal): Promise<SquareEventPage> => {
    const result = (await client.base.square.fetchSquareChatEvents({
      squareChatMid,
      ...(syncToken === undefined ? {} : { syncToken }),
      // Empty pages dominate this latency path. Fifty matches the proven VPS1
      // cursor while still draining bursts without enlarging every response.
      limit: 50,
      signal,
    })) as LooseFetchResult;

    const messages: RawLineMessage[] = [];
    for (const event of result.events ?? []) {
      const raw = toRawMessage(event);
      if (raw !== null) messages.push(raw);
    }
    return {
      messages,
      pageWasEmpty: (result.events ?? []).length === 0,
      syncToken: typeof result.syncToken === 'string' ? result.syncToken : undefined,
    };
  };
}
