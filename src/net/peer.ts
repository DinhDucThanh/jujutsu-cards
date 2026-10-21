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

/**
 * How long one signaling socket gets to open before it is treated as half-open.
 *
 * The public server registers a room in well under a second, so this is not a patience
 * setting: a websocket handshake can stay pending for the browser's ~25-second timeout,
 * producing no `open` and no `error` at all. That is the "Contacting the matchmaking
 * service…" hang. Two and a half seconds covers a slow mobile handshake and is short
 * enough that nobody waits on a socket that is going nowhere.
 */
export const PEER_OPEN_TIMEOUT_MS = 2_500;
/** Sockets tried per room, the first one included. */
export const SIGNALING_ATTEMPTS = 2;
/** Backoff before the retry, so a busy server is not hammered. */
export const SIGNALING_RETRY_DELAY_MS = 1_200;
/** How long a guest waits for a dialed connection to open before giving up. */
export const ROOM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The transport greeting. No game packet may cross the channel until it has completed.
 *
 * The guest speaks first — the host never sends on open — so a message can only be in
 * flight once the receiver has proven it is listening. That is what makes a Web-to-Web
 * handshake deterministic: the guest knows the host heard it before it starts the match,
 * and the host knows the guest can hear it before it announces one.
 */
export const P2P_HANDSHAKE = { INIT: 'HANDSHAKE_INIT', ACK: 'HANDSHAKE_ACK' } as const;
/** How long either side waits for the greeting before the channel is called dead. */
export const HANDSHAKE_TIMEOUT_MS = 4_000;
/** Reported to the guest when the channel opens but the greeting never completes. */
export const HANDSHAKE_FAILED = 'The data channel opened but the handshake never completed. Try again.';

/**
 * Characters of JSON per frame. PeerJS's JSON channel rejects anything at or above its
 * 16,300-byte MTU instead of chunking it, and escaping inflates a JSON string, so the
 * transport splits packets itself. A 36-card snapshot is ~20KB and must still fit.
 */
const CHUNK_CHARS = 6_000;
/** A ceiling on reassembly, so a hostile frame cannot ask for unbounded memory. */
const MAX_CHUNKS = 256;

/**
 * The one message a failed join owes the player. It names both likely causes — a mistyped
 * code and a network that cannot reach the other peer — because the two look identical
 * from this side of the handshake.
 */
export const ROOM_CONNECT_FAILED = 'Could not connect to room. Please check the room code or try again.';

/**
 * What the host is told when a dial-in dies before it becomes a player.
 *
 * The host's room is not what failed, so it is never handed the guest's message: "check the
 * room code and try again" is advice the host cannot act on, and printing it on the waiting
 * screen reads as though the room had expired. The room is still there, and the next guest
 * on a reachable network can still join it.
 */
export const HOST_GUEST_UNREACHABLE = 'A player could not reach this room.';

/**
 * The host's waiting detail, and the only thing that closes that screen is the player.
 *
 * Waiting for a guest is not a request with a deadline: the room id stays registered on the
 * signaling server for as long as the host leaves the screen open, so nothing here may be
 * torn down on a timer.
 */
export const HOST_ROOM_READY = '🟢 Room ready! Waiting for Player 2...';

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

/** What a caller wants to know when a connection is proven, ends, or its ICE dies. */
interface ConnectionHooks {
  /** The channel opened. Sent before the greeting, so a dial deadline can be dropped. */
  readonly onOpen?: () => void;
  /** The greeting completed in both directions: game packets may flow. */
  readonly onVerified: () => void;
  /** The channel closed after being usable (or was closed by the other side). */
  readonly onClosed: (detail: string) => void;
  /** No candidate pair worked, or the greeting never completed. */
  readonly onFailed: (detail: string) => void;
}

/** One slice of an encoded packet, carried inside the JSON frame. */
interface ChunkFrame {
  readonly __p2p: 'chunk';
  readonly seq: number;
  readonly total: number;
  readonly data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHandshake(raw: unknown, type: string): boolean {
  return isRecord(raw) && raw.type === type;
}

function isChunkFrame(raw: unknown): raw is ChunkFrame {
  if (!isRecord(raw) || raw.__p2p !== 'chunk') return false;
  const { seq, total, data } = raw;
  if (typeof seq !== 'number' || typeof total !== 'number' || typeof data !== 'string') return false;
  return (
    Number.isInteger(seq) &&
    Number.isInteger(total) &&
    total > 0 &&
    total <= MAX_CHUNKS &&
    seq >= 0 &&
    seq < total
  );
}

/**
 * Sends one greeting frame. Guarded on `open` because a DataChannel that is closing throws
 * synchronously in some browsers, and a greeting that cannot be sent is a room that cannot
 * exist — the caller's handshake timer turns that into a clear failure.
 */
function sendGreeting(connection: DataConnection, type: string): void {
  if (!connection.open) return;
  try {
    connection.send({ type, payload: { role: type === P2P_HANDSHAKE.INIT ? 'GUEST' : 'HOST' } });
  } catch (error) {
    console.warn('[P2P] handshake frame failed:', error);
  }
}

/**
 * Sends one packet as JSON slices.
 *
 * JSON is the serializer every browser implements identically; the price is PeerJS's hard
 * 16,300-byte frame limit, which it enforces by dropping the message instead of chunking
 * it. A 36-card snapshot is about 20KB, so the transport slices its own frames. The data
 * channel is ordered and reliable, so the slices arrive in order.
 */
function sendPacket(connection: DataConnection, packet: NetworkPacket): void {
  if (!connection.open) return;
  const json = encodePacket(packet);
  const total = Math.max(1, Math.ceil(json.length / CHUNK_CHARS));
  for (let seq = 0; seq < total; seq += 1) {
    const frame: ChunkFrame = {
      __p2p: 'chunk',
      seq,
      total,
      data: json.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS),
    };
    try {
      connection.send(frame);
    } catch (error) {
      console.warn('[P2P] packet frame failed:', error);
      return;
    }
  }
}

/**
 * Wires a data connection to the greeting, the packet handler and the lifecycle.
 *
 * The greeting is strictly two-way. The guest speaks first on open; the host sends nothing
 * until it hears that greeting, and both sides only report `connected` once the answer has
 * crossed the wire. No game packet is accepted before then, so a state update can never be
 * pushed at a channel whose listener on the other side is not attached yet.
 */
function attachConnection(
  connection: DataConnection,
  from: SeatIndex,
  role: 'HOST' | 'GUEST',
  handlers: RoomHandlers,
  hooks: ConnectionHooks,
): void {
  let verified = false;
  /** Set once a failure has been reported, so the close that follows it stays silent. */
  let dead = false;
  let handshakeTimer: Timer | null = null;
  let chunks: { readonly total: number; readonly parts: string[]; filled: number } | null = null;
  /** The detail this side owes on failure: the guest owns the join, the host owns the room. */
  const unreachable = role === 'HOST' ? HOST_GUEST_UNREACHABLE : ROOM_CONNECT_FAILED;

  const stopTimer = (): void => {
    handshakeTimer = clear(handshakeTimer);
  };

  /**
   * Reports a terminal failure exactly once, and never after the channel has verified.
   *
   * A failed ICE negotiation or a broken channel is followed by `close`, which would
   * otherwise overwrite the reason the player needs with "the other player disconnected".
   */
  const fail = (detail: string): void => {
    if (verified || dead) return;
    dead = true;
    stopTimer();
    hooks.onFailed(detail);
  };

  const verify = (): void => {
    if (verified) return;
    verified = true;
    stopTimer();
    hooks.onVerified();
  };

  const begin = (): void => {
    // A channel already reported dead (ICE gave up on it) must not greet anyone.
    if (verified || dead) return;
    // The dial reached the other side: whatever happens next is a handshake problem, not a
    // wrong-room-code one, so the guest's join deadline is dropped before the greeting.
    hooks.onOpen?.();
    if (role === 'GUEST') {
      console.info('[P2P] DataChannel opened on Guest — sending JOIN handshake');
      sendGreeting(connection, P2P_HANDSHAKE.INIT);
    } else {
      console.info('[P2P] DataChannel opened on Host — waiting for the guest handshake');
    }
    // Both sides give the greeting a few seconds. A channel that opens but never carries
    // it is exactly as dead as one that never opened, and must not leave a spinner behind.
    handshakeTimer = globalThis.setTimeout(() => {
      handshakeTimer = null;
      if (verified || dead) return;
      console.warn('[P2P] the data channel opened but the greeting never arrived');
      // Report the reason the player needs before closing, so the `close` that follows it
      // does not describe the channel as the other player leaving. "Try again" is advice
      // for the guest whose join this was; the host is told a player could not reach it.
      fail(role === 'HOST' ? unreachable : HANDSHAKE_FAILED);
      try {
        connection.close();
      } catch {
        // Already closed by the other side.
      }
    }, HANDSHAKE_TIMEOUT_MS);
  };

  connection.on('open', begin);
  // The host can be handed a connection that is already open, after the answer handshake.
  if (connection.open) begin();

  connection.on('data', (raw: unknown) => {
    if (isHandshake(raw, P2P_HANDSHAKE.ACK)) {
      if (role !== 'GUEST' || verified) return;
      console.info('[P2P] Handshake verified');
      verify();
      return;
    }
    if (isHandshake(raw, P2P_HANDSHAKE.INIT)) {
      if (role !== 'HOST') return;
      console.info('[P2P] Guest handshake received — sending WELCOME');
      sendGreeting(connection, P2P_HANDSHAKE.ACK);
      verify();
      return;
    }
    // Nothing else may travel before the greeting: a packet that arrives early is a bug in
    // the sender, and acting on it would run a command on a half-open channel.
    if (!verified) return;

    if (isChunkFrame(raw)) {
      // A slice only belongs to a group started by its own first frame: a mismatch means the
      // earlier group was abandoned, and reassembling across the two would corrupt the JSON.
      if (raw.seq === 0 || chunks === null || chunks.total !== raw.total) {
        if (raw.seq !== 0) {
          chunks = null;
          return;
        }
        chunks = { total: raw.total, parts: new Array<string>(raw.total), filled: 0 };
      }
      const buffer = chunks;
      if (buffer === null) return;
      if (buffer.parts[raw.seq] === undefined) {
        buffer.parts[raw.seq] = raw.data;
        buffer.filled += 1;
      }
      if (buffer.filled === buffer.total) {
        const json = buffer.parts.join('');
        chunks = null;
        const packet = decodePacket(json);
        if (packet) handlers.onPacket(packet, from);
      }
      return;
    }

    // A single unframed packet: an older peer, or a test double.
    const packet = typeof raw === 'string' ? decodePacket(raw) : null;
    if (packet) handlers.onPacket(packet, from);
  });

  connection.on('close', () => {
    stopTimer();
    if (dead) return;
    hooks.onClosed('The other player disconnected.');
  });
  connection.on('error', (error) => {
    const detail = describeError(error as { type?: string; message?: string });
    // A guest's broken channel is a join the guest has to retry. On the host it is one
    // failed dial-in, not a fault in the room, so it never becomes an error on that screen.
    if (role === 'GUEST' && !verified && !dead) handlers.onStatus({ state: 'error', detail });
    fail(role === 'HOST' ? unreachable : detail);
  });
  // ICE has its own verdict, and it arrives before the data channel ever opens. Without
  // this listener a blocked path is indistinguishable from a slow one and the screen keeps
  // its spinner until the connection timeout, long after the browser knew it had failed.
  connection.on('iceStateChanged', (state) => {
    if (state === 'failed') fail(unreachable);
  });
}

/** A timer handle that can be cancelled more than once, used for the join deadlines. */
type Timer = ReturnType<typeof globalThis.setTimeout>;

function clear(timer: Timer | null): null {
  if (timer !== null) globalThis.clearTimeout(timer);
  return null;
}

/** Errors that mean the server was unreachable, not that the room code is wrong. */
const RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  'network',
  'server-error',
  'socket-error',
  'socket-closed',
]);

interface OpenPeerOptions {
  /** The id to claim, or null to let the server assign one. */
  readonly id: string | null;
  /** True once the room is closed or given up on: no further attempts are made. */
  readonly closed: () => boolean;
  /** The socket registered with the signaling server. */
  readonly onOpen: (peer: Peer) => void;
  /** An attempt stalled or failed; another one follows after `retryInMs`. */
  readonly onRetry: (attempt: number, retryInMs: number) => void;
  /** Every attempt is spent. */
  readonly onGiveUp: (detail: string) => void;
}

interface OpenPeer {
  close(): void;
}

/**
 * Opens a PeerJS peer and keeps trying when the signaling socket will not open.
 *
 * A room used to hang on "Contacting the matchmaking service…" because a websocket
 * handshake can stay pending for the browser's ~25-second timeout: no `open`, no `error`,
 * nothing to react to. Every attempt now has its own deadline, a stuck socket is discarded
 * and dialled again, and the player is only told the room failed once the attempts are
 * spent — roughly four seconds worst case instead of twenty-five. A retry claims the same
 * id, so the room code the host is about to share never changes under them.
 */
function openPeer(options: OpenPeerOptions): OpenPeer {
  let current: Peer | null = null;
  let attempt = 1;
  let deadline: Timer | null = null;
  let retry: Timer | null = null;
  let stopped = false;

  const stop = (): void => {
    stopped = true;
    deadline = clear(deadline);
    retry = clear(retry);
    const peer = current;
    current = null;
    try {
      peer?.destroy();
    } catch {
      // Already torn down, by the browser or by a close racing the deadline.
    }
  };

  /**
   * Discards `peer` and either dials again or reports the failure. A socket that already
   * opened is never salvaged: the room owns it from that point on, and throwing it away
   * would kill a working handshake over a signaling blip that no longer matters.
   */
  const salvage = (peer: Peer, detail: string = SIGNALING_FAILED): void => {
    if (stopped || options.closed() || current !== peer) return;
    deadline = clear(deadline);
    current = null;
    try {
      peer.destroy();
    } catch {
      // Already down.
    }
    if (attempt >= SIGNALING_ATTEMPTS) {
      stop();
      options.onGiveUp(detail);
      return;
    }
    attempt += 1;
    options.onRetry(attempt, SIGNALING_RETRY_DELAY_MS);
    retry = globalThis.setTimeout(() => {
      retry = null;
      start();
    }, SIGNALING_RETRY_DELAY_MS);
  };

  const start = (): void => {
    if (stopped || options.closed()) return;
    const id = options.id;
    const peer = id === null ? new Peer({ ...PEER_OPTIONS }) : new Peer(id, { ...PEER_OPTIONS });
    current = peer;
    // A healthy socket opens in well under a second; reaching this deadline means the
    // handshake is stuck, and waiting longer is waiting on nothing.
    deadline = globalThis.setTimeout(() => {
      deadline = null;
      salvage(peer);
    }, PEER_OPEN_TIMEOUT_MS);

    let opened = false;
    peer.on('open', () => {
      if (stopped || options.closed() || current !== peer) return;
      opened = true;
      deadline = clear(deadline);
      options.onOpen(peer);
    });
    peer.on('error', (error) => {
      if (opened || stopped || options.closed() || current !== peer) return;
      const detail = describeError(error as { type?: string; message?: string });
      const type = (error as { type?: string }).type ?? '';
      // An unreachable server is worth another socket; a taken id or a missing room is not.
      if (RETRYABLE_ERRORS.has(type)) salvage(peer, detail);
      else {
        stop();
        options.onGiveUp(detail);
      }
    });
  };

  start();
  return { close: stop };
}

/** Opens a room and waits for the guest to dial in. */
export function hostRoom(code: string, handlers: RoomHandlers): PeerRoom {
  let connection: DataConnection | null = null;
  let closed = false;

  handlers.onStatus({ state: 'signaling', detail: 'Contacting the matchmaking service…' });

  const link = openPeer({
    // The id must come from the code: the guest has nothing else to dial. A server-assigned
    // id is a 36-character UUID, so neither it nor a five-character suffix of it can be
    // typed into the join field — the code would address no one.
    id: peerIdForRoom(code),
    closed: () => closed,
    onOpen: (peer) => {
      if (closed) return;
      handlers.onStatus({ state: 'waiting', detail: HOST_ROOM_READY });
      peer.on('connection', (incoming) => {
        // One guest per room: a second dial-in is turned away rather than fought over.
        if (connection) {
          incoming.close();
          return;
        }
        connection = incoming;
        // The dial-in is not a connection yet: ICE still has to find a path through both NATs.
        handlers.onStatus({ state: 'connecting', detail: 'Connecting players…' });
        // The host sends nothing here. Its first frame is the answer to the guest's greeting,
        // sent from inside `attachConnection` once that greeting has arrived.
        attachConnection(incoming, 1, 'HOST', handlers, {
          onVerified: () => {
            if (!closed) handlers.onStatus({ state: 'connected', detail: 'Player 2 connected' });
          },
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
      });
      peer.on('disconnected', () => {
        if (closed) return;
        handlers.onStatus({ state: 'disconnected', detail: 'Signaling lost, reconnecting…' });
        peer.reconnect();
      });
    },
    onRetry: (attempt, retryInMs) => {
      if (closed) return;
      handlers.onStatus({
        state: 'signaling',
        detail: `The matchmaking service is not answering — retrying in ${Math.round(retryInMs / 1000)}s (attempt ${attempt} of ${SIGNALING_ATTEMPTS})…`,
      });
    },
    onGiveUp: (detail) => handlers.onStatus({ state: 'error', detail }),
  });

  return {
    code,
    send(packet) {
      if (connection) sendPacket(connection, packet);
    },
    close() {
      closed = true;
      link.close();
      connection?.close();
      connection = null;
      handlers.onStatus({ state: 'disconnected', detail: 'Room closed' });
    },
  };
}

/** Dials a room code; the guest's PeerJS id is assigned by the signaling server. */
export function joinRoom(code: string, handlers: RoomHandlers): PeerRoom {
  let connection: DataConnection | null = null;
  let closed = false;
  let terminated = false;
  let connectTimer: Timer | null = null;
  let link: OpenPeer | null = null;

  /**
   * Gives up on the room exactly once. The peer is destroyed so a retry starts from a clean
   * signaling socket and a corrected code can be tried without the old attempt answering
   * first.
   */
  const giveUp = (detail: string): void => {
    if (closed || terminated) return;
    terminated = true;
    connectTimer = clear(connectTimer);
    try {
      connection?.close();
    } catch {
      // Already closed by the other side: nothing left to release.
    }
    connection = null;
    link?.close();
    handlers.onStatus({ state: 'error', detail });
  };

  handlers.onStatus({ state: 'signaling', detail: 'Contacting the matchmaking service…' });

  link = openPeer({
    // Nobody dials the guest, so its id is the server's to choose.
    id: null,
    closed: () => closed || terminated,
    onOpen: (peer) => {
      if (closed || terminated) return;
      handlers.onStatus({ state: 'connecting', detail: `Finding room ${code}…` });
      // `serialization: 'json'` is stated here, on the initiating side, because that is the
      // side that chooses it for the pair: binarypack is what fails silently between two
      // browser bundles. The host inherits this from the connection's metadata.
      const dial = peer.connect(peerIdForRoom(code), { reliable: true, serialization: 'json' });
      connection = dial;
      attachConnection(dial, 0, 'GUEST', handlers, {
        // The room answered: from here on a failure is a handshake failure, and saying
        // "check the room code" would send the player to correct something that is right.
        onOpen: () => {
          connectTimer = clear(connectTimer);
        },
        onVerified: () => {
          connectTimer = clear(connectTimer);
          if (!closed && !terminated) handlers.onStatus({ state: 'connected', detail: 'Connected to the host' });
        },
        onClosed: (detail) => {
          connection = null;
          if (!closed && !terminated) handlers.onStatus({ state: 'disconnected', detail });
        },
        onFailed: giveUp,
      });
      // A dial that never opens is not a wait worth leaving the player in.
      connectTimer = globalThis.setTimeout(() => giveUp(ROOM_CONNECT_FAILED), ROOM_CONNECT_TIMEOUT_MS);
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
    },
    onRetry: (attempt, retryInMs) => {
      if (closed || terminated) return;
      handlers.onStatus({
        state: 'signaling',
        detail: `The matchmaking service is not answering — retrying in ${Math.round(retryInMs / 1000)}s (attempt ${attempt} of ${SIGNALING_ATTEMPTS})…`,
      });
    },
    onGiveUp: giveUp,
  });

  return {
    code,
    send(packet) {
      if (connection) sendPacket(connection, packet);
    },
    close() {
      closed = true;
      connectTimer = clear(connectTimer);
      try {
        connection?.close();
      } catch {
        // Already gone.
      }
      connection = null;
      link?.close();
      handlers.onStatus({ state: 'disconnected', detail: 'Left the room' });
    },
  };
}
