import { describe, expect, it } from 'vitest';
import {
  NETWORK_PROTOCOL_VERSION,
  asBoardState,
  asGameConfig,
  asMatchStart,
  asP2SelectCharacter,
  asPingPong,
  asVoteRematch,
  decodePacket,
  encodePacket,
  makePacket,
  type NetworkPacket,
} from '../../src/net/network.js';
import { createRoomCode, normalizeRoomCode, peerIdForRoom } from '../../src/net/room-code.js';

const sample: NetworkPacket = makePacket('PING_PONG', 1, { nonce: 42 }, 1_700_000_000_000);

describe('network protocol', () => {
  it('round-trips a packet through the wire format', () => {
    const decoded = decodePacket(encodePacket(sample));
    expect(decoded).toEqual(sample);
    expect(decoded && asPingPong(decoded.payload)?.nonce).toBe(42);
  });

  it('rejects malformed frames instead of throwing', () => {
    expect(decodePacket(undefined)).toBeNull();
    expect(decodePacket(42)).toBeNull();
    expect(decodePacket('')).toBeNull();
    expect(decodePacket('{')).toBeNull();
    expect(decodePacket('null')).toBeNull();
    expect(decodePacket('[]')).toBeNull();
    // Unknown message type, bad seat, non-object payload, missing timestamp.
    expect(decodePacket(JSON.stringify({ type: 'DROP_TABLE', senderIndex: 0, payload: {}, timestamp: 1 }))).toBeNull();
    expect(decodePacket(JSON.stringify({ type: 'PING_PONG', senderIndex: 2, payload: {}, timestamp: 1 }))).toBeNull();
    expect(decodePacket(JSON.stringify({ type: 'PING_PONG', senderIndex: 0, payload: 'x', timestamp: 1 }))).toBeNull();
    expect(decodePacket(JSON.stringify({ type: 'PING_PONG', senderIndex: 0, payload: {} }))).toBeNull();
  });

  it('checks the payloads the match logic consumes', () => {
    expect(asPingPong({ nonce: 1 })).toEqual({ nonce: 1 });
    expect(asPingPong({ nonce: 'late' })).toBeNull();

    const config = {
      roomCode: 'K7QP4',
      boardMode: 'DUAL',
      boardSize: 16,
      startingHp: 200,
      trapCount: 2,
      synergyPairCount: 1,
      boardClearReward: 'RANDOM_AUTO',
      players: [
        { id: 'p1', characterId: 'satoru_gojo' },
        { id: 'p2', characterId: 'yuji_itadori' },
      ],
      hostName: 'Host',
    };
    expect(asGameConfig(config)?.players[1]?.characterId).toBe('yuji_itadori');
    expect(asGameConfig({ ...config, boardMode: 'THREE_BOARDS' })).toBeNull();
    expect(asGameConfig({ ...config, boardSize: 12 })).toBeNull();
    expect(asGameConfig({ ...config, boardClearReward: 'LATER' })).toBeNull();
    expect(asGameConfig({ ...config, players: [config.players[0]] })).toBeNull();

    expect(asP2SelectCharacter({ characterId: 'sukuna' })).toEqual({ characterId: 'sukuna' });
    expect(asP2SelectCharacter({ characterId: '' })).toBeNull();
    expect(asVoteRematch({ vote: true })).toEqual({ vote: true });
    expect(asVoteRematch({ vote: 'yes' })).toBeNull();

    const initialState = { view: { boards: [], players: [], result: null }, queue: [], events: [], sentAt: 0 };
    expect(asMatchStart({ config, initialState })?.config.roomCode).toBe('K7QP4');
    expect(asMatchStart({ config, initialState: { ...initialState, sentAt: 'soon' } })).toBeNull();
    expect(asMatchStart({ config: { ...config, boardSize: 12 }, initialState })).toBeNull();

    expect(
      asBoardState({ view: { boards: [], players: [], result: null }, queue: [], events: [], sentAt: 0 }),
    ).not.toBeNull();
    expect(asBoardState({ view: { boards: 'nope' }, queue: [], events: [], sentAt: 0 })).toBeNull();
    expect(
      asBoardState({ view: { boards: [], players: [], result: null }, queue: [], events: [], sentAt: 'soon' }),
    ).toBeNull();
  });

  it('pins the protocol revision', () => {
    // Revision 2 adds the co-op lobby pick, explicit start packets and rematch votes.
    expect(NETWORK_PROTOCOL_VERSION).toBe(2);
  });
});

describe('room codes', () => {
  it('accepts a typed code in any case, spacing or dashes', () => {
    expect(normalizeRoomCode('k7qp4')).toBe('K7QP4');
    expect(normalizeRoomCode(' K7Q-P4 ')).toBe('K7QP4');
  });

  it('rejects codes that cannot be a room', () => {
    expect(normalizeRoomCode('K7QP')).toBeNull();
    expect(normalizeRoomCode('K7QP40')).toBeNull();
    expect(normalizeRoomCode('K7QO4')).toBeNull(); // letter O never appears in a code
    expect(normalizeRoomCode('K7QI4')).toBeNull(); // nor letter I
    expect(normalizeRoomCode('')).toBeNull();
  });

  it('generates codes from the unambiguous alphabet', () => {
    const code = createRoomCode();
    expect(code).toHaveLength(5);
    expect(normalizeRoomCode(code)).toBe(code);
    // Injected entropy keeps the generator deterministic and testable.
    expect(createRoomCode(() => 0)).toBe('AAAAA');
    expect(peerIdForRoom('K7QP4')).toBe('jjk-sorcery-K7QP4');
  });
});
