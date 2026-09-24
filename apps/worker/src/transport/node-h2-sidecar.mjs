import { resolve4, resolve6 } from 'node:dns/promises';
import { connect as connectHttp2, constants } from 'node:http2';
import { createInterface } from 'node:readline';
import { connect as connectTls } from 'node:tls';

const forbiddenHeaders = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);

const sessions = new Map();
const activeStreams = new Map();
const tlsTickets = new Map();
const publicAddressCache = new Map();
const publicRotations = new Map();

async function publicAddressFor(hostname) {
  const cached = publicAddressCache.get(hostname);
  if (cached?.length) {
    const rotation = publicRotations.get(hostname) ?? 0;
    publicRotations.set(hostname, rotation + 1);
    return cached[rotation % cached.length];
  }

  // `dns.resolve*` asks the configured DNS resolver directly.  Do not use
  // getaddrinfo here: it consults /etc/hosts, whose Square pins are correct
  // for RPC but have repeatedly reset LINE's long-lived /PUSH endpoint.
  const [ipv6, ipv4] = await Promise.all([
    resolve6(hostname).catch(() => []),
    resolve4(hostname).catch(() => []),
  ]);
  const family = process.env.LINE_IP_FAMILY;
  const addresses = family === '4'
    ? [...ipv4, ...ipv6]
    : family === '6'
    ? [...ipv6, ...ipv4]
    : [...ipv6, ...ipv4];
  if (addresses.length === 0) throw new Error(`no public DNS addresses for ${hostname}`);
  publicAddressCache.set(hostname, addresses);
  publicRotations.set(hostname, 1);
  return addresses[0];
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function discardSession(key, session) {
  if (sessions.get(key)?.session === session) sessions.delete(key);
}

// `/PUSH` is a distinct LINE service from the Square RPCs the owned reply
// lanes use, resolved through public DNS explicitly: the OS resolver would
// otherwise consult /etc/hosts and silently return the Square-pinned
// addresses, which have repeatedly reset LINE's long-lived /PUSH endpoint.
async function sessionFor(laneId, origin) {
  const key = `${laneId}|${origin}`;
  const existing = sessions.get(key);
  if (existing && !existing.session.closed && !existing.session.destroyed) return existing;

  const url = new URL(origin);
  const address = await publicAddressFor(url.hostname);
  // Tickets are kept per session key, not per origin: bots sharing this
  // process must not resume each other's TLS sessions.
  const ticket = tlsTickets.get(key);
  const session = connectHttp2(origin, {
    createConnection: () => {
      const socket = connectTls({
        host: address,
        port: Number(url.port || 443),
        servername: url.hostname,
        ALPNProtocols: ['h2'],
        ...(ticket ? { session: ticket } : {}),
      });
      socket.setNoDelay(true);
      socket.on('session', (nextTicket) => tlsTickets.set(key, nextTicket));
      return socket;
    },
  });
  const entry = { session, address };
  sessions.set(key, entry);
  session.on('goaway', () => {
    discardSession(key, session);
    session.close();
  });
  session.on('error', () => discardSession(key, session));
  session.on('close', () => discardSession(key, session));
  session.unref();
  return entry;
}

// `/PUSH` is unlike a normal Thrift RPC: its request body stays writable and
// its response stays readable for the lifetime of the session.  Proxy its
// chunks over stdio rather than buffering either side, otherwise the client
// and LINE wait on one another and the push path silently dies.
async function handlePushStart(message) {
  const { id, laneId, url: rawUrl, method } = message;
  const url = new URL(rawUrl);
  const origin = url.origin;
  let entry;
  let stream;
  try {
    entry = await sessionFor(laneId, origin);
    const headers = {
      ':method': method,
      ':scheme': url.protocol.slice(0, -1),
      ':authority': url.host,
      ':path': `${url.pathname}${url.search}`,
      'accept-encoding': 'identity',
    };
    for (const [name, value] of message.headers) {
      const lower = name.toLowerCase();
      if (!forbiddenHeaders.has(lower) && lower !== 'accept-encoding') headers[lower] = value;
    }
    stream = entry.session.request(headers, { endStream: false });
    activeStreams.set(id, stream);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeStreams.delete(id);
      emit(result);
    };
    stream.once('response', (received) => {
      const responseHeaders = [];
      for (const [name, value] of Object.entries(received)) {
        if (name.startsWith(':') || value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.push([name, item]));
        else responseHeaders.push([name, String(value)]);
      }
      emit({
        type: 'push-headers',
        id,
        ok: true,
        status: Number(received[':status'] ?? 0),
        headers: responseHeaders,
        remoteAddress: entry.address,
        remoteOrigin: origin,
      });
    });
    stream.on('data', (chunk) => emit({ type: 'push-data', id, body: chunk.toString('base64') }));
    stream.once(
      'error',
      (error) => finish({ type: 'push-error', id, ok: false, error: error.message }),
    );
    stream.once(
      'aborted',
      () => finish({ type: 'push-error', id, ok: false, error: 'HTTP/2 push stream aborted' }),
    );
    stream.once('end', () => finish({ type: 'push-end', id, ok: true }));
    stream.once('close', () => {
      if (!settled && !stream.readableEnded) {
        finish({
          type: 'push-error',
          id,
          ok: false,
          error: 'HTTP/2 push stream closed before end',
        });
      }
    });
  } catch (error) {
    activeStreams.delete(id);
    emit({
      type: 'push-error',
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === 'cancel') {
      activeStreams.get(message.id)?.close(constants.NGHTTP2_CANCEL);
      return;
    }
    if (message.type === 'push-data') {
      activeStreams.get(message.id)?.write(Buffer.from(message.body, 'base64'));
      return;
    }
    if (message.type === 'push-end') {
      activeStreams.get(message.id)?.end();
      return;
    }
    if (message.type === 'push-start') void handlePushStart(message);
  } catch (error) {
    emit({ id: 0, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

input.on('close', () => {
  for (const { session } of sessions.values()) session.destroy();
  process.exit(0);
});
