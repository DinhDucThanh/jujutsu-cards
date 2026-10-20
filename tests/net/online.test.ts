import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_STATE,
  COURTROOM_PHASE,
  GAME_CONSTANTS,
  GameEngine,
  type CardSubjectId,
  createSeededRandom,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
} from '../../src/engine/index.js';
import { OnlineGuest, OnlineHost, type GuestHooks, type HostHooks } from '../../src/net/online.js';
import type { BoardStatePayload, GameConfigPayload, NetworkPacket } from '../../src/net/network.js';

const P1 = 'p1';
const P2 = 'p2';

function matchConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    matchId: 'net-match',
    boardMode: BOARD_MODE.DUAL,
    players: [
      { id: P1, characterId: 'satoru_gojo' },
      { id: P2, characterId: 'yuji_itadori' },
    ],
    boardSize: 16,
    trapCount: 0,
    synergyPairCount: 1,
    startingHp: 200,
    ...overrides,
  };
}

/** A synchronous stand-in for the data channel, so ordering is asserted deterministically. */
class Wire {
  readonly toHost: NetworkPacket[] = [];
  readonly toGuest: NetworkPacket[] = [];
  /** Everything the host ever sent, including frames the guest already consumed. */
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
    while (this.toHost.length > 0) {
      const packet = this.toHost.shift() as NetworkPacket;
      host.handlePacket(packet, 1);
    }
  }

  flushGuest(guest: OnlineGuest): void {
    while (this.toGuest.length > 0) {
      const packet = this.toGuest.shift() as NetworkPacket;
      guest.handlePacket(packet, 0);
    }
  }
}

function createMatch(options: { config?: MatchConfig } = {}) {
  const config = options.config ?? matchConfig();
  const wire = new Wire();
  const clock = { value: 0 };
  const engine = new GameEngine(config, createSeededRandom(11));

  const guestHooks = {
    ready: [] as string[],
    configs: [] as GameConfigPayload[],
    snapshots: [] as BoardStatePayload[],
    events: [] as GameEvent[],
    statuses: [] as string[],
  };
  const hostStatuses: string[] = [];
  const engineResults: EngineResult[] = [];
  let joinedName: string | null = null;

  let host: OnlineHost;
  const hostHooks: HostHooks = {
    onGuestJoined: (name) => {
      joinedName = name;
    },
    // Mirrors the app: a command is shown locally and then published to the guest.
    onEngineResult: (result) => {
      engineResults.push(result);
      host.publish(result.events);
    },
    onStatus: (status) => hostStatuses.push(status.state),
  };
  host = new OnlineHost(
    config,
    engine,
    (packet) => wire.hostSends(packet),
    () => clock.value,
    hostHooks,
  );

  const hooks: GuestHooks = {
    onReady: (ready) => guestHooks.ready.push(ready.roomCode),
    onConfig: (received) => guestHooks.configs.push(received),
    onSnapshot: (snapshot, events) => {
      guestHooks.snapshots.push(snapshot);
      guestHooks.events.push(...events);
    },
    onStatus: (status) => guestHooks.statuses.push(status.state),
  };
  const guest = new OnlineGuest(
    (packet) => wire.guestSends(packet),
    () => clock.value,
    hooks,
  );

  const connect = (): void => {
    guest.requestJoin('Guest');
    wire.flushHost(host);
    host.publish(engine.start(0).events);
    host.announce('K7QP4', 'Host');
    wire.flushGuest(guest);
  };

  return {
    config,
    wire,
    clock,
    engine,
    host,
    guest,
    guestHooks,
    hostStatuses,
    engineResults,
    getJoined: () => joinedName,
    connect,
  };
}

describe('online match protocol', () => {
  it('completes the handshake and publishes the host match to the guest', () => {
    const match = createMatch();
    match.connect();

    expect(match.getJoined()).toBe('Guest');
    expect(match.guestHooks.configs).toHaveLength(1);
    expect(match.guestHooks.configs[0]?.boardSize).toBe(16);
    expect(match.guestHooks.configs[0]?.hostName).toBe('Host');
    expect(match.guestHooks.snapshots).toHaveLength(1);

    const snapshot = match.guestHooks.snapshots[0];
    expect(snapshot?.view.boards.map((board) => board.ownerId)).toEqual([P1, P2]);
    expect(snapshot?.view.players.map((player) => player.id)).toEqual([P1, P2]);
    // The guest renders from the host's view, not from its own simulation.
    expect(match.guest.publicView).toEqual(match.engine.getPublicView());
  });

  it('never sends a face-down card identity', () => {
    const match = createMatch();
    match.connect();

    const wireText = JSON.stringify(match.wire.toGuest);
    expect(wireText).not.toContain('"characterId":"sukuna"');
    for (const snapshot of match.guestHooks.snapshots) {
      for (const board of snapshot.view.boards) {
        for (const card of board.cards) {
          if (card.state !== CARD_STATE.HIDDEN) continue;
          expect(card.characterId).toBeNull();
          expect(card.pairId).toBeNull();
          expect(card.type).toBeNull();
        }
      }
    }
  });

  it('applies a guest flip on the host engine and shows it back to the guest', () => {
    const match = createMatch();
    match.connect();

    const guestBoard = match.guest.publicView?.boards.find((board) => board.ownerId === P2);
    const hidden = guestBoard?.cards.find((card) => card.state === CARD_STATE.HIDDEN);
    expect(hidden).toBeDefined();

    match.guest.flip(hidden?.id ?? '', P2);
    match.wire.flushHost(match.host);
    match.wire.flushGuest(match.guest);

    const hostCard = match.engine
      .getPublicView()
      .boards.find((board) => board.boardId === P2)
      ?.cards.find((card) => card.id === hidden?.id);
    expect(hostCard?.state).toBe(CARD_STATE.REVEALED);
    expect(hostCard?.revealedBy).toBe(P2);

    const revealed = match.guest.publicView?.boards
      .find((board) => board.boardId === P2)
      ?.cards.find((card) => card.id === hidden?.id);
    expect(revealed?.state).toBe(CARD_STATE.REVEALED);
    expect(revealed?.revealedBy).toBe(P2);
  });

  it('routes a guest skill cast to the host engine', () => {
    const match = createMatch();
    match.connect();

    match.guest.cast('SKILL');
    match.wire.flushHost(match.host);

    // No CE yet, so the engine refuses the cast — but it was the guest's own seat that
    // asked, and the refusal comes from the authoritative host.
    const last = match.engineResults.at(-1);
    expect(last?.ok).toBe(false);
    expect(last && !last.ok ? last.code : null).toBe('INSUFFICIENT_CE');
  });

  it('ignores a packet that claims the host seat', () => {
    const match = createMatch();
    match.connect();

    const before = match.engine.getPublicView();
    match.host.handlePacket(
      {
        type: 'ACTION_FLIP_CARD',
        senderIndex: 0,
        payload: { cardId: 'p2:0', boardId: P2 },
        timestamp: Date.now(),
      },
      1,
    );
    expect(match.engine.getPublicView()).toEqual(before);
  });

  it('refuses a guest command aimed at the host grid', () => {
    const match = createMatch();
    match.connect();

    const hostBoard = match.guest.publicView?.boards.find((board) => board.ownerId === P1);
    const hidden = hostBoard?.cards.find((card) => card.state === CARD_STATE.HIDDEN);
    const before = match.engine.getPublicView();

    match.guest.flip(hidden?.id ?? '', P1);
    match.wire.flushHost(match.host);
    match.wire.flushGuest(match.guest);

    const after = match.engine.getPublicView().boards.find((board) => board.boardId === P1);
    const card = after?.cards.find((candidate) => candidate.id === hidden?.id);
    expect(card?.state).toBe(CARD_STATE.HIDDEN);
    expect(before.boards.find((board) => board.boardId === P1)?.cards).toEqual(after?.cards);
  });

  it('rejects a guest on another protocol revision', () => {
    const match = createMatch();
    match.host.handlePacket(
      {
        type: 'ROOM_JOIN_REQUEST',
        senderIndex: 1,
        payload: { protocol: 99, guestName: 'Future' },
        timestamp: Date.now(),
      },
      1,
    );

    const ready = match.wire.toGuest.find((packet) => packet.type === 'ROOM_READY');
    expect(ready?.payload).toMatchObject({ accepted: false });
    expect(match.getJoined()).toBeNull();
  });

  it('streams damage, domain and match-result events as their own packets', () => {
    const match = createMatch();
    match.connect();
    match.guestHooks.events.length = 0;

    const damage: GameEvent = {
      type: 'DAMAGE_DEALT',
      sourceId: P1,
      targetId: P2,
      dealt: 22,
      absorbed: 3,
      critical: false,
      piercing: false,
      cause: 'MATCH',
    };
    const domain: GameEvent = {
      type: 'ULTIMATE_ACTIVATED',
      playerId: P1,
      characterId: 'satoru_gojo',
      ultimateId: 'unlimited_void',
      name: 'Unlimited Void',
      cost: 100,
      ultimateType: 'DOMAIN',
      domainId: 'unlimited_void',
      turnsRemaining: 2,
      vfx: 'DOMAIN',
    };
    const ending: GameEvent = {
      type: 'MATCH_ENDED',
      result: { winnerId: P1, reason: 'KNOCKOUT', endedAt: 1234 },
    };
    match.host.publish([damage, domain, ending]);
    match.wire.flushGuest(match.guest);

    const types = match.wire.hostHistory.map((packet) => packet.type);
    expect(types).toContain('EVENT_DAMAGE_APPLIED');
    expect(types).toContain('EVENT_DOMAIN_ACTIVATED');
    expect(types).toContain('EVENT_MATCH_RESULT');

    // The guest rebuilds the engine events the host's UI would have handled locally.
    const kinds = match.guestHooks.events.map((event) => event.type);
    expect(kinds).toContain('DAMAGE_DEALT');
    expect(kinds).toContain('ULTIMATE_ACTIVATED');
    expect(kinds).toContain('MATCH_ENDED');
    expect(match.guestHooks.events.find((event) => event.type === 'DAMAGE_DEALT')).toEqual(damage);
    expect(match.guestHooks.events.find((event) => event.type === 'MATCH_ENDED')).toEqual(ending);
  });

  it('answers pings so the guest can measure latency', () => {
    const match = createMatch();
    match.connect();

    match.guest.ping();
    match.wire.flushHost(match.host);
    match.wire.flushGuest(match.guest);

    expect(match.guest.latencyMs).toBeGreaterThanOrEqual(0);
    expect(match.wire.guestHistory.some((packet) => packet.type === 'PING_PONG')).toBe(true);
    expect(match.wire.hostHistory.some((packet) => packet.type === 'PING_PONG')).toBe(true);
  });

  it('refuses a guest who prosecutes or picks during the Higuruma charge', () => {
    const match = createMatch({
      config: matchConfig({
        boardMode: BOARD_MODE.SHARED,
        sandbox: true,
        players: [
          { id: P1, characterId: 'higuruma' },
          { id: P2, characterId: 'satoru_gojo' },
        ],
        trapCount: 0,
        synergyPairCount: 0,
      }),
    });
    match.connect();

    const publish = (result: EngineResult): void => {
      if (!result.ok) throw new Error(`Engine rejected command with ${result.code}`);
      match.host.publish(result.events);
    };
    publish(match.engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    publish(match.engine.activateUltimate(P1, 1));
    let now = 1;
    for (let guard = 0; guard < 4000 && match.engine.getPublicView().sentencing?.phase !== COURTROOM_PHASE.PROSECUTE; guard++) {
      now += 100;
      publish(match.engine.tick(now));
    }
    const trial = match.engine.getPublicView().sentencing;
    expect(trial?.phase).toBe(COURTROOM_PHASE.PROSECUTE);
    const subject = trial?.candidates?.[0] as CardSubjectId;

    const lastCode = (): string | null => {
      const last = match.engineResults.at(-1);
      return last && !last.ok ? last.code : null;
    };

    // The host clock is the engine clock: keep it in step with the trial before the guest acts.
    match.clock.value = now;
    // The guest is the victim (P2). Its charge click reaches the host as P2 and is refused.
    match.guest.prosecuteCourtroom(subject);
    match.wire.flushHost(match.host);
    expect(lastCode()).toBe('NOT_YOUR_TURN');

    // During the charge the victim's pick is refused too, so the courtroom does not move on.
    match.guest.pickCourtroomSlot(0);
    match.wire.flushHost(match.host);
    expect(lastCode()).not.toBeNull();
    const after = match.engine.getPublicView().sentencing;
    expect(after?.phase).toBe(COURTROOM_PHASE.PROSECUTE);
    expect(after?.pickedSlot).toBeNull();
    expect(after?.candidates).toEqual(trial?.candidates);

    // The caster's own seat (the host) can still name the charge.
    expect(match.engine.chooseProsecution(P1, subject, now).ok).toBe(true);
  });

  it('aligns the guest clock with the host clock', () => {
    const match = createMatch();
    match.connect();

    match.clock.value = 5000;
    match.host.publish([]);
    match.clock.value = 8000;
    match.wire.flushGuest(match.guest);

    // The guest arrived 3s later locally but must read the host's 5s engine clock.
    expect(match.guest.clock()).toBe(5000);
  });
});
