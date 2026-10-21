import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The transport imports `Peer` from peerjs; the fake keeps the test offline and lets each
// test fire the signaling events in the order a real server would.
vi.mock('peerjs', async () => {
  const { FakePeer } = await import('../helpers/fake-peer.js');
  return { Peer: FakePeer };
});

import {
  HANDSHAKE_FAILED,
  HANDSHAKE_TIMEOUT_MS,
  HOST_GUEST_UNREACHABLE,
  HOST_ROOM_READY,
  ICE_SERVERS,
  PEER_OPEN_TIMEOUT_MS,
  ROOM_CONNECT_FAILED,
  ROOM_CONNECT_TIMEOUT_MS,
  SIGNALING_ATTEMPTS,
  SIGNALING_FAILED,
  SIGNALING_RETRY_DELAY_MS,
  hostRoom,
  joinRoom,
  type PeerRoom,
  type PeerStatus,
} from '../../src/net/peer.js';
import type { NetworkPacket } from '../../src/net/network.js';
import { FakePeer } from '../helpers/fake-peer.js';

const PING = {
  type: 'PING_PONG',
  senderIndex: 1,
  payload: { nonce: 1 },
  timestamp: 1,
} as unknown as NetworkPacket;

const rooms: PeerRoom[] = [];

function record(): { events: PeerStatus[]; onStatus: (status: PeerStatus) => void } {
  const events: PeerStatus[] = [];
  return { events, onStatus: (status) => events.push(status) };
}

function room(create: (onStatus: (status: PeerStatus) => void) => PeerRoom, onStatus: (status: PeerStatus) => void): PeerRoom {
  const opened = create(onStatus);
  rooms.push(opened);
  return opened;
}

afterEach(() => {
  for (const opened of rooms.splice(0)) opened.close();
  FakePeer.reset();
  vi.useRealTimers();
});

describe('ICE configuration', () => {
  it("lists Google's STUN servers one per entry, then the Open Relay TURN fallbacks", () => {
    expect(ICE_SERVERS.map((server) => server.urls)).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302',
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ]);
  });

  it('hands the STUN list to both the hosting and the joining peer', () => {
    const host = record();
    room((onStatus) => hostRoom('K7QP4', { onPacket: () => {}, onStatus }), host.onStatus);
    const guest = record();
    room((onStatus) => joinRoom('K7QP4', { onPacket: () => {}, onStatus }), guest.onStatus);

    expect(FakePeer.instances).toHaveLength(2);
    for (const peer of FakePeer.instances) {
      const config = peer.options.config as RTCConfiguration;
      expect(config.iceServers).toEqual([...ICE_SERVERS]);
      expect(peer.options.debug).toBe(1);
    }
  });
});

describe('hostRoom lifecycle', () => {
  it('claims the room code and tells the host the room is ready', () => {
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();

    expect(peer.id).toBe('jjk-sorcery-K7QP4');
    expect(events[0]?.state).toBe('signaling');

    peer.claim();

    expect(events.at(-1)).toEqual({
      state: 'waiting',
      detail: HOST_ROOM_READY,
    });
  });

  it('reports connecting, then connected, as a guest dials in', () => {
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();

    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);
    expect(events.at(-1)).toEqual({ state: 'connecting', detail: 'Connecting players…' });

    incoming.arrive();
    // The host sends nothing on open: it waits for the guest's greeting.
    expect(incoming.sent).toHaveLength(0);
    expect(events.at(-1)?.state).toBe('connecting');

    incoming.emit('data', { type: 'HANDSHAKE_INIT', payload: { role: 'GUEST' } });

    expect(incoming.sent[0]).toEqual({ type: 'HANDSHAKE_ACK', payload: { role: 'HOST' } });
    expect(events.at(-1)).toEqual({ state: 'connected', detail: 'Player 2 connected' });
  });

  it('drops game packets that arrive before the greeting', () => {
    const packets: unknown[] = [];
    const { onStatus } = record();
    room(
      (status) =>
        hostRoom('K7QP4', {
          onPacket: (packet) => packets.push(packet),
          onStatus: status,
        }),
      onStatus,
    );
    const peer = FakePeer.last();
    peer.claim();
    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);
    incoming.arrive();

    const packet = { type: 'PING_PONG', senderIndex: 1, payload: { nonce: 1 }, timestamp: 1 };
    incoming.emit('data', packet);
    expect(packets).toHaveLength(0);

    incoming.emit('data', { type: 'HANDSHAKE_INIT', payload: { role: 'GUEST' } });
    incoming.emit('data', { __p2p: 'chunk', seq: 0, total: 1, data: JSON.stringify(packet) });
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ type: 'PING_PONG' });
  });

  it('returns to waiting when the guest never greets the host', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);
    incoming.arrive();

    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 10);

    expect(incoming.closed).toBe(true);
    expect(events.at(-1)?.state).toBe('waiting');
    // "Try again" belongs to the guest: the host's room never stopped working.
    expect(events.at(-1)?.detail).toBe(`${HOST_GUEST_UNREACHABLE} The room is still open.`);
    expect(events.some((event) => event.detail.includes(HANDSHAKE_FAILED))).toBe(false);
  });

  it('returns to waiting when a guest connection ends', () => {
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);
    incoming.arrive();
    incoming.emit('data', { type: 'HANDSHAKE_INIT', payload: { role: 'GUEST' } });

    incoming.close();
    expect(events.at(-1)).toEqual({ state: 'waiting', detail: 'The other player disconnected.' });
  });

  it('rebuilds a stuck signaling socket instead of waiting on a dead one', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const first = FakePeer.last();

    vi.advanceTimersByTime(PEER_OPEN_TIMEOUT_MS);

    // The stuck socket is dropped at once, and the retry waits out its backoff.
    expect(first.destroyed).toBe(true);
    expect(FakePeer.instances).toHaveLength(1);
    const retry = events.find((event) => event.detail.includes('retrying'));
    expect(retry?.state).toBe('signaling');
    expect(retry?.detail).toContain(`attempt 2 of ${SIGNALING_ATTEMPTS}`);

    vi.advanceTimersByTime(SIGNALING_RETRY_DELAY_MS + 10);
    expect(FakePeer.instances).toHaveLength(2);
    // The retry claims the same id, so the code the host is about to share never changes.
    expect(FakePeer.last().id).toBe('jjk-sorcery-K7QP4');
    FakePeer.last().claim();
    expect(events.at(-1)?.detail).toBe(HOST_ROOM_READY);
  });

  it('retries a network error and opens the room on the second socket', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);

    FakePeer.last().emit('error', { type: 'network', message: 'offline' });
    expect(FakePeer.instances).toHaveLength(1);

    vi.advanceTimersByTime(SIGNALING_RETRY_DELAY_MS + 10);
    expect(FakePeer.instances).toHaveLength(2);
    FakePeer.last().claim();
    expect(events.at(-1)).toEqual({
      state: 'waiting',
      detail: HOST_ROOM_READY,
    });
  });

  it('reports a dead matchmaking service after the last attempt', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);

    vi.advanceTimersByTime(
      PEER_OPEN_TIMEOUT_MS + SIGNALING_RETRY_DELAY_MS + PEER_OPEN_TIMEOUT_MS + 10,
    );

    expect(events.at(-1)).toEqual({ state: 'error', detail: SIGNALING_FAILED });
    expect(FakePeer.instances).toHaveLength(SIGNALING_ATTEMPTS);
  });

  it('keeps the room open indefinitely while no guest arrives', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();

    const opened = events.length;
    vi.advanceTimersByTime(60_000);

    // A minute of waiting is silence: no timer closes the room, and the socket that claimed
    // the code is still the one the guest will dial.
    expect(events.slice(opened)).toEqual([]);
    expect(peer.destroyed).toBe(false);
    expect(peer.reconnects).toBe(0);

    // The guest who finally shows up still connects to the same room.
    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);
    incoming.arrive();
    incoming.emit('data', { type: 'HANDSHAKE_INIT', payload: { role: 'GUEST' } });
    expect(events.at(-1)).toEqual({ state: 'connected', detail: 'Player 2 connected' });
  });

  it('never hands the host the guest\u2019s room-code message', () => {
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);

    // ICE gives up on the path: the guest has a join to retry, the host has a room that is
    // still open and a code that is still valid.
    incoming.emit('iceStateChanged', 'failed');

    expect(events.at(-1)).toEqual({
      state: 'waiting',
      detail: `${HOST_GUEST_UNREACHABLE} The room is still open.`,
    });
    expect(events.some((event) => event.detail.includes(ROOM_CONNECT_FAILED))).toBe(false);
    expect(events.some((event) => event.state === 'error')).toBe(false);
    expect(peer.destroyed).toBe(false);

    // The close that follows a dead channel must not replace the reason with "left".
    incoming.emit('close');
    expect(events.at(-1)?.detail).toBe(`${HOST_GUEST_UNREACHABLE} The room is still open.`);
  });

  it('treats a broken inbound channel as a failed attempt, not a room error', () => {
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);
    incoming.arrive();

    incoming.emit('error', { type: 'webrtc', message: 'connection failed' });

    expect(events.at(-1)).toEqual({
      state: 'waiting',
      detail: `${HOST_GUEST_UNREACHABLE} The room is still open.`,
    });
    expect(events.some((event) => event.state === 'error')).toBe(false);
  });
});

describe('joinRoom lifecycle', () => {
  it('dials the room id once signaling opens and reports the connection', () => {
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();

    const dial = peer.dials[0];
    if (!dial) throw new Error('the guest never dialed');
    expect(dial.peer).toBe('jjk-sorcery-K7QP4');
    // JSON, stated on the initiating side, is what the host inherits for the pair.
    expect(dial.options).toMatchObject({ reliable: true, serialization: 'json' });
    expect(events.at(-1)?.state).toBe('connecting');

    dial.arrive();
    // The guest speaks first: JOIN goes out on open, and `connected` waits for the answer.
    expect(dial.sent[0]).toEqual({ type: 'HANDSHAKE_INIT', payload: { role: 'GUEST' } });
    expect(events.at(-1)?.state).toBe('connecting');

    dial.emit('data', { type: 'HANDSHAKE_ACK', payload: { role: 'HOST' } });
    expect(events.at(-1)).toEqual({ state: 'connected', detail: 'Connected to the host' });
  });

  it('gives up when the host never answers the greeting', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    peer.dials[0]?.arrive();

    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 10);

    expect(events.at(-1)).toEqual({ state: 'error', detail: HANDSHAKE_FAILED });
    expect(peer.destroyed).toBe(true);
  });

  it('drops the join deadline as soon as the channel opens', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    peer.dials[0]?.arrive();

    // The room answered the dial, so a greeting that never lands is a handshake problem.
    // Telling the player to check the code would send them to correct what is already right.
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 10);

    expect(events.at(-1)).toEqual({ state: 'error', detail: HANDSHAKE_FAILED });
    expect(events.some((event) => event.detail === ROOM_CONNECT_FAILED)).toBe(false);
  });

  it('gives up with the room-code message when the dial never opens', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();

    vi.advanceTimersByTime(ROOM_CONNECT_TIMEOUT_MS);

    expect(events.at(-1)).toEqual({ state: 'error', detail: ROOM_CONNECT_FAILED });
    expect(peer.destroyed).toBe(true);
  });

  it('gives up as soon as ICE reports a failed negotiation', () => {
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    const dial = peer.dials[0];
    if (!dial) throw new Error('the guest never dialed');

    dial.emit('iceStateChanged', 'failed');

    expect(events.at(-1)).toEqual({ state: 'error', detail: ROOM_CONNECT_FAILED });
    expect(peer.destroyed).toBe(true);
  });

  it('does not fire the join deadline after a successful connection', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    peer.dials[0]?.arrive();
    peer.dials[0]?.emit('data', { type: 'HANDSHAKE_ACK', payload: { role: 'HOST' } });

    vi.advanceTimersByTime(ROOM_CONNECT_TIMEOUT_MS * 2);

    expect(events.at(-1)?.state).toBe('connected');
    expect(peer.destroyed).toBe(false);
  });

  it('reports a missing room from the signaling server error', () => {
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();

    peer.emit('error', { type: 'peer-unavailable', message: 'no such peer' });

    expect(events.at(-1)).toEqual({
      state: 'error',
      detail: 'No room with that code. Check the five characters and try again.',
    });
    expect(peer.destroyed).toBe(true);
  });

  it('reports the signaling failure after the retry is spent', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);

    vi.advanceTimersByTime(
      PEER_OPEN_TIMEOUT_MS + SIGNALING_RETRY_DELAY_MS + PEER_OPEN_TIMEOUT_MS + 10,
    );

    expect(events.at(-1)).toEqual({ state: 'error', detail: SIGNALING_FAILED });
  });
});

describe('room transport', () => {
  beforeEach(() => {
    FakePeer.reset();
  });

  it('sends packets only once the channel is open', () => {
    const { onStatus } = record();
    const joiner = room(
      (status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }),
      onStatus,
    );
    const peer = FakePeer.last();
    peer.claim();
    const dial = peer.dials[0];
    if (!dial) throw new Error('the guest never dialed');

    joiner.send(PING);
    expect(dial.sent).toHaveLength(0);

    dial.arrive();
    // The greeting is the guest's first frame; the packet follows it.
    expect(dial.sent).toHaveLength(1);
    joiner.send(PING);
    expect(dial.sent).toHaveLength(2);
    expect(dial.sent[1]).toMatchObject({ __p2p: 'chunk', seq: 0, total: 1 });
  });

  it('reassembles a packet split across several frames', () => {
    const packets: unknown[] = [];
    const { onStatus } = record();
    room(
      (status) =>
        joinRoom('K7QP4', {
          onPacket: (packet) => packets.push(packet),
          onStatus: status,
        }),
      onStatus,
    );
    const peer = FakePeer.last();
    peer.claim();
    const dial = peer.dials[0];
    if (!dial) throw new Error('the guest never dialed');
    dial.arrive();
    dial.emit('data', { type: 'HANDSHAKE_ACK', payload: { role: 'HOST' } });

    const json = JSON.stringify(PING);
    const mid = Math.floor(json.length / 2);
    dial.emit('data', { __p2p: 'chunk', seq: 0, total: 2, data: json.slice(0, mid) });
    expect(packets).toHaveLength(0);
    dial.emit('data', { __p2p: 'chunk', seq: 1, total: 2, data: json.slice(mid) });

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ type: 'PING_PONG' });
  });
});
