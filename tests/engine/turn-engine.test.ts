import { describe, expect, it } from 'vitest';
import {
  BLESSING,
  BOARD_MODE,
  calculateTurnDuration,
  CARD_TYPE,
  CHARACTER_IDS,
  CHARACTERS,
  GAME_CONSTANTS,
  SHARED_BOARD_ID,
  SKILLS,
  STATUS_KIND,
  TurnEngine,
  ULTIMATES,
  boardOfPlayer,
  createSeededRandom,
  type BoardMode,
  type CardSpec,
  type CharacterId,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type PublicMatchView,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';
const cardId = (index: number): string => `${SHARED_BOARD_ID}:${index}`;

/**
 * The fighter shown by pair `pair`. A real deal gives every pair a distinct character
 * while the roster lasts, and matching is by fighter: a board of ten identical cards
 * would make every flip a match, so the fixtures follow the generator.
 */
function pairCharacter(pair: number): CharacterId {
  return CHARACTER_IDS[pair % CHARACTER_IDS.length] as CharacterId;
}

/** Sixteen standard cards: positions (0,1), (2,3), ... share a pairId. */
function standardLayout(): CardSpec[] {
  return Array.from({ length: 16 }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: pairCharacter(Math.floor(i / 2)),
    trapId: null,
  }));
}

/** `count` unique traps first, then standard pairs filling the rest of the board. */
function trapHeavyLayout(count: number): CardSpec[] {
  const traps: CardSpec[] = Array.from({ length: count }, (_, i) => ({
    pairId: `trap:sukuna_finger:${i}`,
    type: CARD_TYPE.TRAP,
    characterId: 'sukuna',
    trapId: 'sukuna_finger',
  }));
  const playable = 16 - count;
  const pairs: CardSpec[] = Array.from({ length: playable }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: pairCharacter(Math.floor(i / 2)),
    trapId: null,
  }));
  return [...traps, ...pairs];
}

/** Two unique traps at positions 0 and 1, then seven standard pairs. */
function trapLayout(): CardSpec[] {
  const traps: CardSpec[] = [
    { pairId: 'trap:sukuna_finger:0', type: CARD_TYPE.TRAP, characterId: 'sukuna', trapId: 'sukuna_finger' },
    { pairId: 'trap:sukuna_finger:1', type: CARD_TYPE.TRAP, characterId: 'sukuna', trapId: 'sukuna_finger' },
  ];
  const pairs: CardSpec[] = Array.from({ length: 14 }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: pairCharacter(Math.floor(i / 2)),
    trapId: null,
  }));
  return [...traps, ...pairs];
}

interface EngineOptions {
  readonly layout?: CardSpec[];
  readonly trapCount?: number;
  readonly start?: boolean;
  readonly p1?: CharacterId;
  readonly mode?: BoardMode;
  readonly startingHp?: number;
}

function makeEngine(options: EngineOptions = {}): TurnEngine {
  const config: MatchConfig = {
    matchId: 'test-match',
    boardMode: options.mode ?? BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: options.p1 ?? 'satoru_gojo' },
      { id: P2, characterId: 'sukuna' },
    ],
    boardSize: 16,
    trapCount: options.trapCount ?? 0,
    synergyPairCount: 0,
    ...(options.startingHp === undefined ? {} : { startingHp: options.startingHp }),
  };
  const engine = new TurnEngine(config, createSeededRandom(1), options.layout ?? standardLayout());
  if (options.start !== false) expectOk(engine.start(0));
  return engine;
}

function expectOk(result: EngineResult): readonly GameEvent[] {
  if (!result.ok) throw new Error(`Engine rejected command with ${result.code}`);
  return result.events;
}

function expectReject(result: EngineResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

function playerView(view: PublicMatchView, id: string) {
  const player = view.players.find((p) => p.id === id);
  if (!player) throw new Error(`missing player ${id}`);
  return player;
}

/** Player flips two known-mismatching cards (pairs 4 and 5), then waits out the reveal. */
function mismatchTurn(engine: TurnEngine, player: string, now: number): number {
  expectOk(engine.flipCard(player, cardId(8), now));
  expectOk(engine.flipCard(player, cardId(10), now + 1));
  const resolved = now + 1 + GAME_CONSTANTS.MISMATCH_REVEAL_MS;
  expectOk(engine.tick(resolved));
  return resolved;
}

describe('turn flow', () => {
  it('starts with player 1 on turn and a hidden shared board', () => {
    const view = makeEngine().getPublicView();
    expect(view.phase).toBe('WAITING_FOR_P1');
    expect(view.turnOwner).toBe(P1);
    expect(view.turnNumber).toBe(1);
    expect(view.board).toHaveLength(16);
    expect(view.board.every((c) => c.state === 'HIDDEN')).toBe(true);
  });

  it('hides identity of face-down cards and exposes it while face-up', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 0));
    const view = engine.getPublicView();
    expect(view.board[0]?.pairId).toBe('pair-0');
    expect(view.board[0]?.characterId).toBe(pairCharacter(0));
    expect(view.board[5]?.pairId).toBeNull();
    expect(view.board[5]?.characterId).toBeNull();
  });

  it('a match deals damage, grants CE, and keeps the turn after the evaluation window', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 100));
    const events = expectOk(engine.flipCard(P1, cardId(1), 200));

    expect(events.some((e) => e.type === 'PAIR_MATCHED')).toBe(true);
    expect(events.find((e) => e.type === 'DAMAGE_DEALT')).toMatchObject({ dealt: 10, targetId: P2 });

    let view = engine.getPublicView();
    expect(view.phase).toBe('EVALUATING');
    expect(playerView(view, P2).hp).toBe(90);
    expect(playerView(view, P1).cursedEnergy).toBe(GAME_CONSTANTS.MATCH_CE_GAIN);
    expectReject(engine.flipCard(P1, cardId(2), 300), 'EVALUATING');

    expectOk(engine.tick(1000)); // resolves at 200 + MATCH_RESOLVE_MS
    view = engine.getPublicView();
    expect(view.phase).toBe('WAITING_FOR_P1');
    expect(view.turnOwner).toBe(P1);
  });

  it('a mismatch shows both cards during the reveal window, then hides them and passes the turn', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 0));
    const events = expectOk(engine.flipCard(P1, cardId(2), 100));
    expect(events.some((e) => e.type === 'PAIR_MISMATCHED')).toBe(true);
    expect(engine.getPublicView().board[0]?.characterId).toBe(pairCharacter(0));

    const revealUntil = 100 + GAME_CONSTANTS.MISMATCH_REVEAL_MS;
    expectOk(engine.tick(revealUntil - 1));
    expect(engine.getPublicView().phase).toBe('EVALUATING');

    const resolved = expectOk(engine.tick(revealUntil));
    expect(resolved.find((e) => e.type === 'TURN_ENDED')).toMatchObject({ playerId: P1, reason: 'MISMATCH' });

    const view = engine.getPublicView();
    expect(view.phase).toBe('WAITING_FOR_P2');
    expect(view.turnOwner).toBe(P2);
    expect(view.turnNumber).toBe(2);
    expect(view.board[0]?.state).toBe('HIDDEN');
    expect(view.board[2]?.state).toBe('HIDDEN');
  });

  it('the second consecutive match in one turn is a Black Flash with 2.5x damage and bonus CE', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 0));
    expectOk(engine.flipCard(P1, cardId(1), 10));
    expectOk(engine.tick(810));

    expectOk(engine.flipCard(P1, cardId(2), 820));
    const events = expectOk(engine.flipCard(P1, cardId(3), 830));

    expect(events.some((e) => e.type === 'BLACK_FLASH')).toBe(true);
    expect(events.find((e) => e.type === 'DAMAGE_DEALT')).toMatchObject({ dealt: 25, critical: true });
    const view = engine.getPublicView();
    expect(playerView(view, P2).hp).toBe(65);
    expect(playerView(view, P1).cursedEnergy).toBe(GAME_CONSTANTS.MATCH_CE_GAIN * 2 + GAME_CONSTANTS.BLACK_FLASH_CE_GAIN);
    expect(playerView(view, P1).comboStreak).toBe(2);
    // A streak of two *is* a Kokusen, so it also raises the barrier pool.
    expect(playerView(view, P1).shield).toBe(GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN);
  });

  it('a retained turn gets a fresh time budget after the match resolves', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 0));
    expectOk(engine.flipCard(P1, cardId(1), 10));
    expectOk(engine.tick(810));
    expectOk(engine.tick(calculateTurnDuration(engine.getPublicView().turnNumber)));
    expect(engine.getPublicView().turnOwner).toBe(P1);
  });

  it('a turn times out after its budget, hides an open first flip, and passes the turn', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 1000));
    const events = expectOk(engine.tick(calculateTurnDuration(1)));

    expect(events.some((e) => e.type === 'TURN_TIMED_OUT')).toBe(true);
    expect(events.find((e) => e.type === 'TURN_ENDED')).toMatchObject({ playerId: P1, reason: 'TIMEOUT' });
    const view = engine.getPublicView();
    expect(view.turnOwner).toBe(P2);
    expect(view.board[0]?.state).toBe('HIDDEN');
  });

  it('escalates the turn budget as the match goes on: 25s, 20s, then 15s', () => {
    expect(calculateTurnDuration(1)).toBe(25_000);
    expect(calculateTurnDuration(10)).toBe(25_000);
    expect(calculateTurnDuration(11)).toBe(20_000);
    expect(calculateTurnDuration(20)).toBe(20_000);
    expect(calculateTurnDuration(21)).toBe(15_000);

    const engine = makeEngine();
    // The published budget is the one the current turn actually has, so the UI bar scales.
    const first = engine.getPublicView();
    expect(first.turnTimeMs).toBe(GAME_CONSTANTS.TURN_TIME_EARLY_MS);
    expect((first.turnDeadline ?? 0) - 0).toBe(GAME_CONSTANTS.TURN_TIME_EARLY_MS);

    // A rushed-turn debuff can only shorten the scheduled budget, never extend it.
    expect(engine.getPublicView().turnTimeMs).toBeLessThanOrEqual(GAME_CONSTANTS.TURN_TIME_EARLY_MS);
  });
});

describe('command validation', () => {
  it('rejects commands before the match starts', () => {
    const engine = makeEngine({ start: false });
    expectReject(engine.flipCard(P1, cardId(0), 0), 'NOT_STARTED');
  });

  it('rejects flips from the player who is not on turn', () => {
    expectReject(makeEngine().flipCard(P2, cardId(0), 0), 'NOT_YOUR_TURN');
  });

  it('rejects unknown players', () => {
    expectReject(makeEngine().flipCard('nobody', cardId(0), 0), 'UNKNOWN_PLAYER');
  });

  it('rejects flipping a card that is already face-up', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 0));
    expectReject(engine.flipCard(P1, cardId(0), 10), 'CARD_UNAVAILABLE');
  });

  it('rejects time moving backwards', () => {
    const engine = makeEngine();
    expectOk(engine.tick(500));
    expectReject(engine.flipCard(P1, cardId(0), 100), 'TIME_REGRESSED');
  });

  it('rejects skills and domains without enough cursed energy', () => {
    const engine = makeEngine();
    expectReject(engine.activateSkill(P1, 0), 'INSUFFICIENT_CE');
    expectReject(engine.activateUltimate(P1, 0), 'INSUFFICIENT_CE');
  });
});

describe('traps', () => {
  it('flipping a trap grants CE and does not end the turn', () => {
    const engine = makeEngine({ layout: trapLayout(), trapCount: 2 });
    const events = expectOk(engine.flipCard(P1, cardId(0), 0));

    expect(events.find((e) => e.type === 'TRAP_TRIGGERED')).toMatchObject({
      playerId: P1,
      cursedEnergyGain: 30,
    });
    const view = engine.getPublicView();
    expect(playerView(view, P1).cursedEnergy).toBe(30);
    expect(view.board[0]?.state).toBe('MATCHED');
    expect(view.phase).toBe('WAITING_FOR_P1');
  });
});

describe('ultimates', () => {
  it('every character has a skill and a 100-CE ultimate (Hakari’s Gamble Turn costs 40 CE)', () => {
    expect(CHARACTER_IDS).toHaveLength(11);
    for (const id of CHARACTER_IDS) {
      const character = CHARACTERS[id];
      const skill = SKILLS[character.skillId];
      const ultimate = ULTIMATES[character.ultimateId];
      const expectedSkillCost =
        character.skillId === 'gamble_turn' ? GAME_CONSTANTS.GAMBLE_TURN_CE_COST : GAME_CONSTANTS.SKILL_CE_COST;
      expect(skill.cost).toBe(expectedSkillCost);
      expect(ultimate.cost).toBe(GAME_CONSTANTS.DOMAIN_CE_COST);
      expect(skill.effects.length).toBeGreaterThan(0);
      expect(ultimate.effects.length).toBeGreaterThan(0);
      if (ultimate.type === 'DOMAIN') expect(ultimate.domainId).not.toBeNull();
      else expect(ultimate.domainId).toBeNull();
    }
  });

  it('a domain costs all CE, lasts three of the caster turns, then expires', () => {
    const engine = makeEngine({ p1: 'satoru_gojo' });
    let now = 0;
    // Four consecutive matches within one turn: CE 15, 55, 95, then capped at 100.
    for (const [a, b] of [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ] as const) {
      expectOk(engine.flipCard(P1, cardId(a), now));
      expectOk(engine.flipCard(P1, cardId(b), now + 10));
      now += 10 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
      expectOk(engine.tick(now));
    }
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);

    const cast = expectOk(engine.activateUltimate(P1, now));
    expect(cast).toContainEqual(
      expect.objectContaining({ type: 'ULTIMATE_ACTIVATED', ultimateType: 'DOMAIN', domainId: 'unlimited_void' }),
    );
    let view = engine.getPublicView();
    expect(playerView(view, P1).cursedEnergy).toBe(0);
    expect(playerView(view, P1).activeDomain).toEqual({
      domainId: 'unlimited_void',
      turnsRemaining: GAME_CONSTANTS.DOMAIN_DURATION_TURNS,
    });

    // Unlimited Void strips P2's next turn, so the domain ticks down on P1's own turns.
    now = mismatchTurn(engine, P1, now);
    expect(playerView(engine.getPublicView(), P1).activeDomain?.turnsRemaining).toBe(2);
    now = mismatchTurn(engine, P1, now);
    expect(playerView(engine.getPublicView(), P1).activeDomain?.turnsRemaining).toBe(1);
    now = mismatchTurn(engine, P2, now);
    expect(playerView(engine.getPublicView(), P1).activeDomain?.turnsRemaining).toBe(1);
    now = mismatchTurn(engine, P1, now);
    view = engine.getPublicView();
    expect(playerView(view, P1).activeDomain).toBeNull();
  });

  it('rejects a second domain while one is already open', () => {
    // Eight traps bank 30 CE each without ending the turn or dealing damage.
    const engine = makeEngine({ layout: trapHeavyLayout(8), trapCount: 8, p1: 'sukuna' });
    for (let i = 0; i < 4; i++) expectOk(engine.flipCard(P1, cardId(i), i));
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    expectOk(engine.activateUltimate(P1, 10));

    for (let i = 4; i < 8; i++) expectOk(engine.flipCard(P1, cardId(i), 10 + i));
    expectReject(engine.activateUltimate(P1, 30), 'DOMAIN_ALREADY_ACTIVE');
  });
});

describe('match end', () => {
  it('knockout ends the match and rejects later commands', () => {
    const engine = makeEngine();
    let now = 0;
    let last: readonly GameEvent[] = [];
    for (const [a, b] of [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [8, 9],
    ] as const) {
      expectOk(engine.flipCard(P1, cardId(a), now));
      last = expectOk(engine.flipCard(P1, cardId(b), now + 10));
      now += 10 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
      engine.tick(now);
    }

    expect(last.some((e) => e.type === 'MATCH_ENDED')).toBe(true);
    expect(engine.getResult()).toMatchObject({ winnerId: P1, reason: 'KNOCKOUT' });
    expect(engine.getPublicView().phase).toBe('MATCH_OVER');
    expectReject(engine.flipCard(P1, cardId(10), now), 'GAME_OVER');
  });
});

describe('endless boards', () => {
  /** The eight pairs of the standard 16-card layout. */
  const PAIRS: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [8, 9],
    [10, 11],
    [12, 13],
    [14, 15],
  ];

  /** Plays one matching pair and waits out its evaluation window. */
  function playMatch(
    engine: TurnEngine,
    playerId: string,
    idOf: (position: number) => string,
    pair: readonly [number, number],
    now: number,
  ): { events: readonly GameEvent[]; now: number } {
    expectOk(engine.flipCard(playerId, idOf(pair[0]), now));
    const events = expectOk(engine.flipCard(playerId, idOf(pair[1]), now + 1));
    const resolved = now + 1 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
    expectOk(engine.tick(resolved));
    return { events, now: resolved };
  }

  it('re-deals a cleared grid while keeping HP, cursed energy, buffs and the combo', () => {
    const engine = makeEngine({ startingHp: 300 });
    const idOf = (position: number): string => cardId(position);
    let now = 0;

    // Two pairs bank 55 CE, enough for Infinity before the grid runs out.
    now = playMatch(engine, P1, idOf, PAIRS[0] as readonly [number, number], now).now;
    now = playMatch(engine, P1, idOf, PAIRS[1] as readonly [number, number], now + 1).now;
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(55);
    expectOk(engine.activateSkill(P1, now + 1));

    let last: readonly GameEvent[] = [];
    for (const pair of PAIRS.slice(2)) {
      const outcome = playMatch(engine, P1, idOf, pair, now + 1);
      last = outcome.events;
      now = outcome.now;
    }

    expect(last.some((event) => event.type === 'BOARD_CLEARED')).toBe(true);
    // The grid is re-dealt only once the clearer picks a blessing.
    const respawned = expectOk(engine.chooseBlessing(P1, BLESSING.LATENT_BLACK_FLASH, now + 1));
    expect(respawned.find((event) => event.type === 'BOARD_RESPAWNED')).toMatchObject({
      boardId: SHARED_BOARD_ID,
      ownerId: null,
      cardCount: 16,
    });

    const view = engine.getPublicView();
    expect(engine.getResult()).toBeNull();
    expect(view.phase).toBe('WAITING_FOR_P1');
    expect(view.turnOwner).toBe(P1);
    expect(view.board).toHaveLength(16);
    expect(view.board.every((card) => card.state === 'HIDDEN')).toBe(true);

    const p1 = playerView(view, P1);
    expect(p1.hp).toBe(300);
    expect(p1.cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    expect(p1.comboStreak).toBe(8);
    expect(p1.pairsMatched).toBe(8);
    expect(p1.activeEffects.map((effect) => effect.kind)).toContain(STATUS_KIND.ABSOLUTE_SHIELD);
    // 10 damage, then seven Black Flashes of 25.
    expect(playerView(view, P2).hp).toBe(300 - 185);
  });

  it('is playable again straight away, with the combo still live', () => {
    const engine = makeEngine({ startingHp: 300, p1: 'kento_nanami' });
    let now = 0;
    for (const pair of PAIRS) now = playMatch(engine, P1, cardId, pair, now + 1).now;
    expectOk(engine.chooseBlessing(P1, BLESSING.LATENT_BLACK_FLASH, now + 1));
    expect(engine.getPublicView().board.every((card) => card.state === 'HIDDEN')).toBe(true);

    // Overtime Collapse resolves a pair on the fresh grid, so the new deal really holds pairs.
    const events = expectOk(engine.activateUltimate(P1, now + 1));
    const autoMatched = events.filter((event) => event.type === 'CARDS_AUTO_MATCHED');
    expect(autoMatched).toHaveLength(1);
    expect(autoMatched[0]).toMatchObject({ boardId: SHARED_BOARD_ID, playerId: P1 });
    const matched = events.find((event) => event.type === 'PAIR_MATCHED');
    expect(matched !== undefined && 'pairId' in matched ? matched.pairId : null).not.toBeNull();
    expect(playerView(engine.getPublicView(), P1).pairsMatched).toBe(9);
  });

  it('re-deals only the cleared grid when both fighters own one', () => {
    const engine = makeEngine({ startingHp: 300, mode: BOARD_MODE.DUAL_TURN_BASED });
    const idOf = (position: number): string => `${P1}:${position}`;
    let now = 0;
    let last: readonly GameEvent[] = [];
    for (const pair of PAIRS) {
      const outcome = playMatch(engine, P1, idOf, pair, now + 1);
      last = outcome.events;
      now = outcome.now;
    }

    const respawned = expectOk(engine.chooseBlessing(P1, BLESSING.LATENT_BLACK_FLASH, now + 1));
    expect(respawned.find((event) => event.type === 'BOARD_RESPAWNED')).toMatchObject({
      boardId: P1,
      ownerId: P1,
      cardCount: 16,
    });

    const view = engine.getPublicView();
    expect(engine.getResult()).toBeNull();
    expect(view.turnOwner).toBe(P1);
    expect(boardOfPlayer(view, P1).every((card) => card.state === 'HIDDEN')).toBe(true);
    // The other fighter's grid was never touched.
    expect(boardOfPlayer(view, P2).map((card) => card.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `${P2}:${index}`),
    );
    expect(boardOfPlayer(view, P2).every((card) => card.state === 'HIDDEN' && card.revealedBy === null)).toBe(true);
    expect(playerView(view, P2).hp).toBe(300 - 185);
  });
});
