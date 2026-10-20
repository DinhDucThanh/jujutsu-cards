import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  GameEngine,
  createSeededRandom,
  type MatchConfig,
} from '../../src/engine/index.js';
import { OnlineGuest, OnlineHost, type GuestHooks, type HostHooks } from '../../src/net/online.js';
import type { BoardStatePayload, GameConfigPayload, NetworkPacket } from '../../src/net/network.js';

const P1 = 'p1';
const P2 = 'p2';

function matchConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    matchId: 'rematch-match',
    boardMode: BOARD_MODE.DUAL,
    players: [
      { id: P1, characterId: 'satoru_gojo' },
      { id: P2, characterId: 'yuji_itadori' },
    ],
    boardSize: 16,
    trapCount: 0,
    synergyPairCount: 1,
    startingHp: 200,
    boardClearReward: 'RANDOM_AUTO',
    ...overrides,
  };
}

class Wire {
  readonly toHost: NetworkPacket[] = [];
  readonly toGuest: NetworkPacket[] = [];
  /** Frames already consumed by the other side, kept so a test can inspect the history. */
  readonly hostHistory: NetworkPacket[] = [];
  readonly guestHistory: NetworkPacket[] = [];
  hostSends(packet: NetworkPacket): void {
    this.toGuest.push(packet);
    this.hostHistory.push(packet);
  }
  guestSends(packet: NetworkPacket): void {
    this.toHost.push(packet);
    this.guestHistory.push(packet);
  }
  flushHost(host: OnlineHost): void {
    while (this.toHost.length > 0) host.handlePacket(this.toHost.shift() as NetworkPacket, 1);
  }
  flushGuest(guest: OnlineGuest): void {
    while (this.toGuest.length > 0) guest.handlePacket(this.toGuest.shift() as NetworkPacket, 0);
  }
}

function createSession() {
  const wire = new Wire();
  const clock = { value: 0 };
  let config = matchConfig();
  let engine = new GameEngine(config, createSeededRandom(21));
  let host: OnlineHost;

  const hostStatuses: string[] = [];
  const guestPicks: string[] = [];
  const rematchVotes: boolean[] = [];
  const guestHooks = {
    matchStarts: [] as GameConfigPayload[],
    rematchStarts: [] as GameConfigPayload[],
    snapshots: [] as BoardStatePayload[],
    events: [] as string[],
  };

  const hooksFor = (): HostHooks => ({
    onGuestJoined: () => {},
    onGuestCharacter: (characterId) => guestPicks.push(characterId),
    onRematchVote: (vote) => rematchVotes.push(vote),
    onEngineResult: (result) => host.publish(result.events),
    onStatus: (status) => hostStatuses.push(status.state),
  });

  host = new OnlineHost(config, engine, (packet) => wire.hostSends(packet), () => clock.value, hooksFor());

  const guestHooksFor = (): GuestHooks => ({
    onReady: () => {},
    onConfig: () => {},
    onMatchStart: (received) => guestHooks.matchStarts.push(received),
    onRematchStart: (received) => guestHooks.rematchStarts.push(received),
    onSnapshot: (snapshot, events) => {
      guestHooks.snapshots.push(snapshot);
      guestHooks.events.push(...events.map((event) => event.type));
    },
    onStatus: () => {},
  });
  const guest = new OnlineGuest((packet) => wire.guestSends(packet), () => clock.value, guestHooksFor());

  const connect = (): void => {
    guest.requestJoin('Guest');
    wire.flushHost(host);
    const started = engine.start(0);
    if (!started.ok) throw new Error(started.code);
    host.announce('K7QP4', 'Host', started.events);
    wire.flushGuest(guest);
  };

  /** Launches a new match on the same room, as the host does after both votes. */
  const rematch = (): void => {
    config = { ...config, matchId: `rematch-${Date.now()}` };
    engine = new GameEngine(config, createSeededRandom(99));
    host = new OnlineHost(config, engine, (packet) => wire.hostSends(packet), () => clock.value, hooksFor());
    const started = engine.start(0);
    if (!started.ok) throw new Error(started.code);
    host.announceRematch('K7QP4', 'Host', started.events);
    wire.flushGuest(guest);
  };

  return {
    wire,
    clock,
    guest,
    host,
    get engine() {
      return engine;
    },
    guestHooks,
    guestPicks,
    rematchVotes,
    connect,
    rematch,
  };
}

describe('co-op lobby handshake', () => {
  it('launches with an explicit START_MATCH and the first public snapshot', () => {
    const session = createSession();
    session.connect();

    expect(session.guestHooks.matchStarts).toHaveLength(1);
    expect(session.guestHooks.matchStarts[0]?.roomCode).toBe('K7QP4');
    expect(session.guestHooks.matchStarts[0]?.boardClearReward).toBe('RANDOM_AUTO');
    expect(session.guest.publicView).toEqual(session.engine.getPublicView());

    const types = session.wire.hostHistory.map((packet) => packet.type);
    expect(types).toContain('START_MATCH');
    expect(types).toContain('SYNC_GAME_CONFIG');
  });

  it('routes the guest sorcerer pick to the host lobby', () => {
    const session = createSession();
    session.connect();

    session.guest.selectCharacter('sukuna');
    session.wire.flushHost(session.host);

    expect(session.guestPicks).toEqual(['sukuna']);
    expect(session.host.guestCharacterId).toBe('sukuna');
    // The pick does not start anything by itself: the host still has to launch.
    expect(session.wire.hostHistory.filter((packet) => packet.type === 'START_MATCH')).toHaveLength(1);
  });

  it('ignores an unknown character id instead of putting it in the lobby', () => {
    const session = createSession();
    session.connect();

    session.host.handlePacket(
      {
        type: 'P2_SELECT_CHARACTER',
        senderIndex: 1,
        payload: { characterId: 'not_a_sorcerer' },
        timestamp: Date.now(),
      },
      1,
    );

    expect(session.guestPicks).toEqual([]);
    expect(session.host.guestCharacterId).toBeNull();
  });
});

describe('seamless rematch handshake', () => {
  it('starts a rematch over the same connection, with fresh boards', () => {
    const session = createSession();
    session.connect();
    const firstView = session.guest.publicView;
    session.guestHooks.matchStarts.length = 0;

    session.rematch();

    expect(session.guestHooks.matchStarts).toHaveLength(0);
    expect(session.guestHooks.rematchStarts).toHaveLength(1);
    expect(session.guest.publicView).toEqual(session.engine.getPublicView());
    expect(session.guest.publicView).not.toEqual(firstView);
    // No new room, no new join: the only new packets are the rematch announcements.
    expect(session.wire.toHost).toHaveLength(0);
    const types = session.wire.hostHistory.map((packet) => packet.type);
    expect(types).toContain('START_REMATCH_MATCH');
  });

  it('forwards VOTE_REMATCH to the host once per packet', () => {
    const session = createSession();
    session.connect();

    session.guest.voteRematch();
    session.wire.flushHost(session.host);
    session.guest.voteRematch();
    session.wire.flushHost(session.host);

    expect(session.rematchVotes).toEqual([true, true]);
  });
});
