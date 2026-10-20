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
 * brokered, and the default PeerJS configuration already carries Google's STUN servers,
 * which is what makes a room work both across a LAN and across the internet.
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
      return 'The matchmaking service is unreachable. Check your connection and retry.';
    case 'webrtc':
      return 'The direct connection failed (firewall or NAT). A different network may work.';
    case 'browser-incompatible':
      return 'This browser does not support WebRTC, so online play is unavailable.';
    default:
      return error.message ?? 'Connection error.';
  }
}

/**
 * Signaling and ICE configuration, stated explicitly rather than left to the defaults.
 *
 * `0.peerjs.com` is PeerJS's free public signaling service: it introduces the two peers
 * and then gets out of the way, because gameplay runs on a WebRTC data channel. The STUN
 * servers let each peer discover its public address, which covers most home networks and
 * LANs; the TURN relay is the fallback for symmetric NAT, where a direct path cannot be
 * negotiated and both players would otherwise see "connecting" forever.
 */
const PEER_OPTIONS = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 0,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:global.stun.twilio.com:3478' },
      {
        urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  },
} as const;

/** Wires a data connection to the packet handler and mirrors its lifecycle as status. */
function attachConnection(
  connection: DataConnection,
  from: SeatIndex,
  handlers: RoomHandlers,
  onClosed: (detail: string) => void,
): void {
  connection.on('data', (raw: unknown) => {
    // The channel carries JSON strings; `decodePacket` rejects anything else.
    const packet = decodePacket(typeof raw === 'string' ? raw : null);
    if (packet) handlers.onPacket(packet, from);
  });
  connection.on('close', () => onClosed('The other player disconnected.'));
  connection.on('error', (error) => {
    handlers.onStatus({ state: 'error', detail: describeError(error as { type?: string; message?: string }) });
  });
}

/** Opens a room and waits for the guest to dial in. */
export function hostRoom(code: string, handlers: RoomHandlers): PeerRoom {
  const peer = new Peer(peerIdForRoom(code), { ...PEER_OPTIONS });
  let connection: DataConnection | null = null;
  let closed = false;

  handlers.onStatus({ state: 'signaling', detail: 'Opening the room…' });

  peer.on('open', () => {
    if (!closed) handlers.onStatus({ state: 'waiting', detail: 'Waiting for player 2…' });
  });
  peer.on('connection', (incoming) => {
    // One guest per room: a second dial-in is turned away rather than fought over.
    if (connection) {
      incoming.close();
      return;
    }
    connection = incoming;
    attachConnection(incoming, 1, handlers, (detail) => {
      connection = null;
      if (!closed) handlers.onStatus({ state: 'waiting', detail });
    });
    // `incoming.open` can already be true when the host answers after the handshake.
    const announce = (): void => handlers.onStatus({ state: 'connected', detail: 'Player 2 connected' });
    if (incoming.open) announce();
    else incoming.on('open', announce);
  });
  peer.on('error', (error) => {
    if (!closed) handlers.onStatus({ state: 'error', detail: describeError(error) });
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

  handlers.onStatus({ state: 'signaling', detail: 'Contacting the matchmaking service…' });

  peer.on('open', () => {
    if (closed) return;
    handlers.onStatus({ state: 'connecting', detail: `Joining room ${code}…` });
    const dial = peer.connect(peerIdForRoom(code), { reliable: true });
    connection = dial;
    attachConnection(dial, 0, handlers, (detail) => {
      connection = null;
      if (!closed) handlers.onStatus({ state: 'disconnected', detail });
    });
    dial.on('open', () => {
      if (!closed) handlers.onStatus({ state: 'connected', detail: 'Connected to the host' });
    });
  });
  peer.on('error', (error) => {
    if (!closed) handlers.onStatus({ state: 'error', detail: describeError(error) });
  });

  return {
    code,
    send(packet) {
      if (connection?.open) connection.send(encodePacket(packet));
    },
    close() {
      closed = true;
      connection?.close();
      connection = null;
      peer.destroy();
      handlers.onStatus({ state: 'disconnected', detail: 'Left the room' });
    },
  };
}
