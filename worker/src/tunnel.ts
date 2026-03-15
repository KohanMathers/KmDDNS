/**
 * TunnelSession Durable Object — one instance per active tunnel, keyed by token hash.
 *
 * Binary frame format:
 *   [type: 1 byte][connId: 4 bytes BE][length: 4 bytes BE][data: length bytes]
 *
 * Frame types:
 *   0x01 CONNECT    DO → host       New player connection
 *   0x02 DATA       both            Raw TCP payload
 *   0x03 DISCONNECT both            Connection closed
 *   0x04 ACK        host → DO       Host accepted connection
 */

const FRAME_CONNECT    = 0x01;
const FRAME_DATA       = 0x02;
const FRAME_DISCONNECT = 0x03;
const FRAME_ACK        = 0x04;

const HEADER_LEN = 9; // 1 + 4 + 4

function encodeFrame(type: number, connId: number, data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_LEN + data.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, type);
  view.setUint32(1, connId, false);
  view.setUint32(5, data.byteLength, false);
  new Uint8Array(buf, HEADER_LEN).set(data);
  return buf;
}

function decodeFrame(buf: ArrayBuffer): { type: number; connId: number; data: Uint8Array } | null {
  if (buf.byteLength < HEADER_LEN) return null;
  const view = new DataView(buf);
  const type   = view.getUint8(0);
  const connId = view.getUint32(1, false);
  const length = view.getUint32(5, false);
  if (buf.byteLength < HEADER_LEN + length) return null;
  const data = new Uint8Array(buf, HEADER_LEN, length);
  return { type, connId, data };
}

export class TunnelSession implements DurableObject {
  private readonly state: DurableObjectState;

  // Tags set on accepted WebSockets so we can retrieve them via state.getWebSockets()
  private static readonly TAG_HOST  = 'host';
  private static readonly TAG_RELAY = 'relay';

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Upgrade must be WebSocket
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    if (url.pathname.endsWith('/relay')) {
      // Relay connection — auth via X-Relay-Secret checked by the Worker before routing here
      this.state.acceptWebSocket(server, [TunnelSession.TAG_RELAY]);
    } else {
      // Host (mod) connection — auth via Bearer token checked by the Worker
      this.state.acceptWebSocket(server, [TunnelSession.TAG_HOST]);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message === 'string') return; // ignore text frames

    const frame = decodeFrame(message);
    if (frame === null) return;

    const tags = this.state.getTags(ws);
    const isHost  = tags.includes(TunnelSession.TAG_HOST);
    const isRelay = tags.includes(TunnelSession.TAG_RELAY);

    if (isRelay) {
      if (frame.type === FRAME_DATA || frame.type === FRAME_DISCONNECT) {
        const hosts = this.state.getWebSockets(TunnelSession.TAG_HOST);
        for (const h of hosts) {
          h.send(message);
        }
      }
      if (frame.type === FRAME_CONNECT) {
        const hosts = this.state.getWebSockets(TunnelSession.TAG_HOST);
        for (const h of hosts) {
          h.send(message);
        }
      }
    } else if (isHost) {
      if (
        frame.type === FRAME_DATA ||
        frame.type === FRAME_DISCONNECT ||
        frame.type === FRAME_ACK
      ) {
        const relays = this.state.getWebSockets(TunnelSession.TAG_RELAY);
        for (const r of relays) {
          r.send(message);
        }
      }
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const tags = this.state.getTags(ws);

    if (tags.includes(TunnelSession.TAG_HOST)) {
      const relays = this.state.getWebSockets(TunnelSession.TAG_RELAY);
      for (const r of relays) {
        try { r.close(1001, 'Host disconnected'); } catch { /* ignore */ }
      }
    } else if (tags.includes(TunnelSession.TAG_RELAY)) {
      const hosts = this.state.getWebSockets(TunnelSession.TAG_HOST);
      const disconnectFrame = encodeFrame(FRAME_DISCONNECT, 0, new Uint8Array(0));
      for (const h of hosts) {
        try { h.send(disconnectFrame); } catch { /* ignore */ }
      }
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.error('[TunnelSession] WebSocket error:', error);
    this.webSocketClose(ws, 1011, 'Error', false);
  }
}
