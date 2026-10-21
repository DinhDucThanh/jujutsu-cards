import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerStatus } from '../../src/net/peer.js';

// The transport imports `Peer` from peerjs; the fake keeps the test offline and lets each
// test fire the signaling events in the order a real server would.
vi.mock('peerjs', async () => {
  const { FakePeer } = await import('../helpers/fake-peer.js');
  return { Peer: FakePeer };
});

import {
  ICE_SERVERS,
  ROOM_CONNECT_FAILED,
  ROOM_CONNECT_TIMEOUT_MS,
  SIGNALING_FAILED,
  SIGNALING_TIMEOUT_MS,
  hostRoom,
  joinRoom,
  type PeerRoom,
} from '../../src/net/peer.js';
import type { NetworkPacket } from '../../src/net/network.js';
import { FakePeer } from '../helpers/fake-peer.js';

const PING = { type: 'PING_PONG', senderIndex: 1, payload: { nonce: 1 } } as unknown as NetworkPacket;

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
  it("lists Google's STUN servers one per entry", () => {
    expect(ICE_SERVERS.map((server) => server.urls)).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302',
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
      detail: '🟢 Room created! Share the code with your friend.',
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
    expect(events.at(-1)).toEqual({ state: 'connected', detail: 'Player 2 connected' });
  });

  it('returns to waiting when a guest connection ends', () => {
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();
    const incoming = peer.connect('guest');
    peer.emit('connection', incoming);
    incoming.arrive();

    incoming.close();
    expect(events.at(-1)).toEqual({ state: 'waiting', detail: 'The other player disconnected.' });
  });

  it('reports a signaling server that never answers instead of waiting forever', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => hostRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);

    vi.advanceTimersByTime(SIGNALING_TIMEOUT_MS);
    expect(events.at(-1)).toEqual({ state: 'error', detail: SIGNALING_FAILED });
  });
});

describe('joinRoom lifecycle', () => {
  it('dials the room id once signaling opens and reports the connection', () => {
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);
    const peer = FakePeer.last();
    peer.claim();

    expect(peer.dials[0]?.peer).toBe('jjk-sorcery-K7QP4');
    expect(events.at(-1)?.state).toBe('connecting');

    peer.dials[0]?.arrive();
    expect(events.at(-1)).toEqual({ state: 'connected', detail: 'Connected to the host' });
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

  it('reports the signaling failure when the socket never opens', () => {
    vi.useFakeTimers();
    const { events, onStatus } = record();
    room((status) => joinRoom('K7QP4', { onPacket: () => {}, onStatus: status }), onStatus);

    vi.advanceTimersByTime(SIGNALING_TIMEOUT_MS);

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
    joiner.send(PING);
    expect(dial.sent).toHaveLength(1);
  });
});
