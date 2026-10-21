import { Peer, type DataConnection } from 'peerjs';
import {
  decodePacket,
  encodePacket,
  type NetworkPacket,
  type SeatIndex,
} from './network.js';
import { peerIdForRoom } from './room-code.js';

export { ROOM_ID_PREFIX, createRoomCode, normalizeRoomCode, peerIdForRoom } from './room-code.js';

/**
 * Room transport over WebRTC.
 *
 * The host claims a PeerJS id derived from the room code on the public cloud signaling
 * server; the guest dials that id. Once the data channel opens, gameplay never touches a
 * game server — every packet is peer to peer. Only signaling (the introduction) is
 * brokered, and the ICE configuration below is what lets that introduction reach a peer
 * behind a home router or a mobile carrier's NAT.
 */

export interface PeerStatus {
  readonly state: 'signaling' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error';
  readonly detail: string;
}

export interface RoomHandlers {
  readonly onPacket: (packet: NetworkPacket, from: SeatIndex) => void;
  readonly onStatus: (status: PeerStatus) => void;
}

export interface PeerRoom {
  readonly code: string;
  send(packet: NetworkPacket): void;
  close(): void;
}

/** How long a peer waits for the signaling socket before the room is called dead. */
export const SIGNALING_TIMEOUT_MS = 10_000;
/** How long a guest waits for a dialed connection to open before giving up. */
export const ROOM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The one message a failed join owes the player. It names both likely causes — a mistyped
 * code and a network that cannot reach the other peer — because the two look identical
 * from this side of the handshake.
 */
export const ROOM_CONNECT_FAILED = 'Could not connect to room. Please check the room code or try again.';

/** Reported when the signaling socket itself never opens. */
export const SIGNALING_FAILED = 'Could not reach the matchmaking service. Check your connection and try again.';

/**
 * Google's public STUN servers, stated one per entry rather than bundled into a single
 * `urls` array. A STUN server only answers "what does the internet think my address is?",
 * so a handful of independent hosts is the difference between a room that works on a home
 * Wi-Fi and one that never leaves "connecting". They are tried in order as ICE gathers.
 *
 * A STUN server cannot help when both sides sit behind symmetric NAT (some 4G carriers and
 * corporate firewalls): that path needs a TURN relay, which is a separate, credentialed
 * service rather than something a public list can provide.
 */
export const ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

/**
 * Signaling and ICE configuration, stated explicitly rather than left to the defaults.
 *
 * `0.peerjs.com` is PeerJS's free public signaling service: it introduces the two peers
 * and then gets out of the way, because gameplay runs on a WebRTC data channel. The ICE
 * servers are copied into a mutable array because `RTCConfiguration` promises one.
 */
const PEER_CONFIG: RTCConfiguration = { iceServers: [...ICE_SERVERS] };

const PEER_OPTIONS = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  // 1 = errors only: enough to diagnose a failed ICE negotiation in the console.
  debug: 1 as const,
  config: PEER_CONFIG,
};

function describeError(error: { type?: string; message?: string }): string {
  switch (error.type) {
    case 'unavailable-id':
      return 'That room code is already in use. Start a room again for a fresh code.';
    case 'peer-unavailable':
      return 'No room with that code. Check the five characters and try again.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return SIGNALING_FAILED;
    case 'webrtc':
      return ROOM_CONNECT_FAILED;
    case 'browser-incompatible':
      return 'This browser does not support WebRTC, so online play is unavailable.';
    default:
      return error.message ?? 'Connection error.';
  }
}

/** What a caller wants to know when a connection ends or its ICE negotiation dies. */
interface ConnectionHooks {
  /** The channel closed after being usable (or was closed by the other side). */
  readonly onClosed: (detail: string) => void;
  /** No candidate pair ever worked: the two networks cannot reach each other directly. */
  readonly onFailed: (detail: string) => void;
}

/** Wires a data connection to the packet handler and mirrors its lifecycle as status. */
function attachConnection(
  connection: DataConnection,
  from: SeatIndex,
  handlers: RoomHandlers,
  hooks: ConnectionHooks,
): void {
  connection.on('data', (raw: unknown) => {
    // The channel carries JSON strings; `decodePacket` rejects anything else.
    const packet = decodePacket(typeof raw === 'string' ? raw : null);
    if (packet) handlers.onPacket(packet, from);
  });
  connection.on('close', () => hooks.onClosed('The other player disconnected.'));
  connection.on('error', (error) => {
    const detail = describeError(error as { type?: string; message?: string });
    handlers.onStatus({ state: 'error', detail });
    hooks.onFailed(detail);
  });
  // ICE has its own verdict, and it arrives before the data channel ever opens. Without
  // this listener a blocked path is indistinguishable from a slow one and the screen keeps
  // its spinner until the connection timeout, long after the browser knew it had failed.
  connection.on('iceStateChanged', (state) => {
    if (state === 'failed') hooks.onFailed(ROOM_CONNECT_FAILED);
  });
}

/** A timer handle that can be cancelled more than once, used for the join deadlines. */
type Timer = ReturnType<typeof globalThis.setTimeout>;

function clear(timer: Timer | null): null {
  if (timer !== null) globalThis.clearTimeout(timer);
  return null;
}

/** Opens a room and waits for the guest to dial in. */
export function hostRoom(code: string, handlers: RoomHandlers): PeerRoom {
  const peer = new Peer(peerIdForRoom(code), { ...PEER_OPTIONS });
  let connection: DataConnection | null = null;
  let closed = false;
  let signalingTimer: Timer | null = null;

  handlers.onStatus({ state: 'signaling', detail: 'Contacting the matchmaking service…' });

  // A code that never gets claimed is a dead end, so it reports instead of spinning.
  signalingTimer = globalThis.setTimeout(() => {
    signalingTimer = null;
    if (!closed) handlers.onStatus({ state: 'error', detail: SIGNALING_FAILED });
  }, SIGNALING_TIMEOUT_MS);

  peer.on('open', () => {
    signalingTimer = clear(signalingTimer);
    if (!closed) {
      handlers.onStatus({ state: 'waiting', detail: '🟢 Room created! Share the code with your friend.' });
    }
  });

  peer.on('connection', (incoming) => {
    // One guest per room: a second dial-in is turned away rather than fought over.
    if (connection) {
      incoming.close();
      return;
    }
    connection = incoming;
    // The dial-in is not a connection yet: ICE still has to find a path through both NATs.
    handlers.onStatus({ state: 'connecting', detail: 'Connecting players…' });
    attachConnection(incoming, 1, handlers, {
      onClosed: (detail) => {
        connection = null;
        if (!closed) handlers.onStatus({ state: 'waiting', detail });
      },
      onFailed: (detail) => {
        // The room itself is still open: a different guest on a reachable network can join.
        connection = null;
        if (!closed) handlers.onStatus({ state: 'waiting', detail: `${detail} The room is still open.` });
      },
    });
    // `incoming.open` can already be true when the host answers after the handshake.
    const announce = (): void => {
      if (!closed) handlers.onStatus({ state: 'connected', detail: 'Player 2 connected' });
    };
    if (incoming.open) announce();
    else incoming.on('open', announce);
  });

  peer.on('error', (error) => {
    if (closed) return;
    handlers.onStatus({ state: 'error', detail: describeError(error) });
  });
  peer.on('disconnected', () => {
    if (closed) return;
    handlers.onStatus({ state: 'disconnected', detail: 'Signaling lost, reconnecting…' });
    peer.reconnect();
  });

  return {
    code,
    send(packet) {
      if (connection?.open) connection.send(encodePacket(packet));
    },
    close() {
      closed = true;
      signalingTimer = clear(signalingTimer);
      connection?.close();
      connection = null;
      peer.destroy();
      handlers.onStatus({ state: 'disconnected', detail: 'Room closed' });
    },
  };
}

/** Dials a room code; the guest's PeerJS id is assigned by the signaling server. */
export function joinRoom(code: string, handlers: RoomHandlers): PeerRoom {
  const peer = new Peer({ ...PEER_OPTIONS });
  let connection: DataConnection | null = null;
  let closed = false;
  let terminated = false;
  let signalingTimer: Timer | null = null;
  let connectTimer: Timer | null = null;

  const clearTimers = (): void => {
    signalingTimer = clear(signalingTimer);
    connectTimer = clear(connectTimer);
  };

  /**
   * Gives up on the room exactly once. The peer is destroyed so a retry starts from a clean
   * signaling socket and a fresh code can be tried without the old attempt answering first.
   */
  const giveUp = (detail: string): void => {
    if (closed || terminated) return;
    terminated = true;
    clearTimers();
    try {
      connection?.close();
    } catch {
      // Already closed by the other side: nothing left to release.
    }
    connection = null;
    peer.destroy();
    handlers.onStatus({ state: 'error', detail });
  };

  handlers.onStatus({ state: 'signaling', detail: 'Contacting the matchmaking service…' });
  signalingTimer = globalThis.setTimeout(() => giveUp(SIGNALING_FAILED), SIGNALING_TIMEOUT_MS);

  peer.on('open', () => {
    if (closed || terminated) return;
    signalingTimer = clear(signalingTimer);
    handlers.onStatus({ state: 'connecting', detail: `Finding room ${code}…` });
    const dial = peer.connect(peerIdForRoom(code), { reliable: true });
    connection = dial;
    attachConnection(dial, 0, handlers, {
      onClosed: (detail) => {
        connection = null;
        if (!closed && !terminated) handlers.onStatus({ state: 'disconnected', detail });
      },
      onFailed: giveUp,
    });
    // A dial that never opens is not a wait worth leaving the player in.
    connectTimer = globalThis.setTimeout(() => giveUp(ROOM_CONNECT_FAILED), ROOM_CONNECT_TIMEOUT_MS);
    dial.on('open', () => {
      if (closed || terminated) return;
      clearTimers();
      handlers.onStatus({ state: 'connected', detail: 'Connected to the host' });
    });
  });

  peer.on('error', (error) => {
    if (closed || terminated) return;
    const detail = describeError(error as { type?: string; message?: string });
    // Once the data channel is open, losing the signaling socket does not stop the match.
    if (connection?.open) {
      handlers.onStatus({ state: 'error', detail });
      return;
    }
    giveUp(detail);
  });
  peer.on('disconnected', () => {
    if (closed || terminated || connection?.open) return;
    handlers.onStatus({ state: 'disconnected', detail: 'Signaling lost, reconnecting…' });
    peer.reconnect();
  });

  return {
    code,
    send(packet) {
      if (connection?.open) connection.send(encodePacket(packet));
    },
    close() {
      closed = true;
      clearTimers();
      try {
        connection?.close();
      } catch {
        // Already gone.
      }
      connection = null;
      peer.destroy();
      handlers.onStatus({ state: 'disconnected', detail: 'Left the room' });
    },
  };
}
