import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_EFFECT_KIND,
  CARD_EFFECT_RULES,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  DAMAGE_CAUSE,
  GAME_CONSTANTS,
  SHARED_BOARD_ID,
  STATUS_KIND,
  GameEngine,
  applyDamage,
  createSeededRandom,
  projectTurnQueue,
  type CardSpec,
  type CharacterId,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type PlayerState,
  type PublicMatchView,
  type StatusEffect,
} from '../../src/engine/index.js';
import { domainStatusOf } from '../../src/web/domain-status.js';

const P1 = 'p1';
const P2 = 'p2';
const cardId = (index: number): string => `${SHARED_BOARD_ID}:${index}`;

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: P1,
    characterId: 'satoru_gojo',
    maxHp: 100,
    hp: 100,
    shield: 0,
    cursedEnergy: 0,
    activeEffects: [],
    comboStreak: 0,
    pairsMatched: 0,
    activeDomain: null,
    activeSimpleDomain: null,
    stunUntil: 0,
    executioner: null,
    pachinko: { spinsLeft: 0, pity: 0, resetOnExpiry: false },
    guaranteedBlackFlash: false,
    ...overrides,
  };
}

function effect(kind: StatusEffect['kind'], value: number, turnsRemaining: number | null = null): StatusEffect {
  return { kind, sourceId: 'test', turnsRemaining, value };
}

/**
 * Traps first (each its own pair), then standard pairs on (8,9), (10,11), (12,13), (14,15).
 * Each standard pair shows a distinct fighter, as a real deal does, since matching is by
 * fighter and identical neighbours would match on any flip.
 */
function trapLayout(trapCount: number): CardSpec[] {
  const traps: CardSpec[] = Array.from({ length: trapCount }, (_, i) => ({
    pairId: `trap:sukuna_finger:${i}`,
    type: CARD_TYPE.TRAP,
    characterId: 'sukuna',
    trapId: 'sukuna_finger',
  }));
  const pairs: CardSpec[] = Array.from({ length: 16 - trapCount }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: CHARACTER_IDS[Math.floor(i / 2) % CHARACTER_IDS.length] as CardSpec['characterId'],
    trapId: null,
  }));
  return [...traps, ...pairs];
}

interface EngineOptions {
  readonly p1?: CharacterId;
  readonly p2?: CharacterId;
  readonly trapCount?: number;
  readonly boardMode?: MatchConfig['boardMode'];
}

function makeEngine(options: EngineOptions = {}): GameEngine {
  const config: MatchConfig = {
    matchId: 'queue-test',
    boardMode: options.boardMode ?? BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: options.p1 ?? 'satoru_gojo' },
      { id: P2, characterId: options.p2 ?? 'yuji_itadori' },
    ],
    boardSize: 16,
    trapCount: options.trapCount ?? 0,
    synergyPairCount: 0,
  };
  const engine = new GameEngine(config, createSeededRandom(3), trapLayout(options.trapCount ?? 0));
  expectOk(engine.start(0));
  return engine;
}

function expectOk(result: EngineResult): readonly GameEvent[] {
  if (!result.ok) throw new Error(`Engine rejected command with ${result.code}`);
  return result.events;
}

function playerView(view: PublicMatchView, id: string) {
  const found = view.players.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing player ${id}`);
  return found;
}

function eventsOfType(events: readonly GameEvent[], type: GameEvent['type']): GameEvent[] {
  return events.filter((event) => event.type === type);
}

/** Banks `count` traps from `from`, returning the time of the last flip. */
function bankTraps(engine: GameEngine, playerId: string, from: number, count: number, now: number): number {
  let time = now;
  for (let i = from; i < from + count; i++) {
    expectOk(engine.flipCard(playerId, cardId(i), time));
    time += 1;
  }
  return time;
}

/**
 * Two hidden, unlocked cards from *different* pairs. A domain can seal cards, so the
 * positions are read from the live grid instead of assumed.
 */
function mismatchingPositions(view: PublicMatchView, from = 8): [number, number] {
  const hidden = view.board.filter(
    (card) => card.position >= from && card.state === CARD_STATE.HIDDEN && !card.locked,
  );
  const first = hidden[0];
  if (!first) throw new Error('need a hidden card');
  const second = hidden.find((card) => Math.floor(card.position / 2) !== Math.floor(first.position / 2));
  if (!second) throw new Error('need two hidden pairs');
  return [first.position, second.position];
}

interface PassOutcome {
  readonly now: number;
  /** Events the resolution tick produced: turn end, burns, status timers. */
  readonly events: readonly GameEvent[];
}

/** The next standard pair that can still be matched: both cards hidden and unsealed. */
function matchingPair(view: PublicMatchView, from = 8): [number, number] {
  const hidden = view.board.filter((card) => card.position >= from && card.state === CARD_STATE.HIDDEN);
  for (const card of hidden) {
    const partner = hidden.find(
      (candidate) =>
        candidate.position !== card.position &&
        Math.floor(candidate.position / 2) === Math.floor(card.position / 2) &&
        !candidate.locked &&
        !card.locked,
    );
    if (partner) return [card.position, partner.position];
  }
  throw new Error('no unsealed pair left on the grid');
}

/** Flips both cards of a pair as `playerId`, waiting out the match window. */
function playMatch(engine: GameEngine, playerId: string, pair: [number, number], now: number): number {
  expectOk(engine.flipCard(playerId, cardId(pair[0]), now));
  expectOk(engine.flipCard(playerId, cardId(pair[1]), now + 1));
  const resolved = now + 1 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
  expectOk(engine.tick(resolved));
  return resolved;
}

/** Passes the turn as `playerId` with a mismatch, waiting out the reveal window. */
function passTurn(engine: GameEngine, playerId: string, now: number): PassOutcome {
  const [a, b] = mismatchingPositions(engine.getPublicView());
  expectOk(engine.flipCard(playerId, cardId(a), now));
  expectOk(engine.flipCard(playerId, cardId(b), now + 1));
  const resolved = now + 1 + GAME_CONSTANTS.MISMATCH_REVEAL_MS;
  const events = expectOk(engine.tick(resolved));
  return { now: resolved, events };
}

describe('turn queue projection', () => {
  it('alternates seats and marks the seat on turn', () => {
    const queue = projectTurnQueue([player({ id: P1 }), player({ id: P2, characterId: 'sukuna' })], 0, 3);

    expect(queue.map((entry) => entry.playerId)).toEqual([P1, P2, P1]);
    expect(queue.map((entry) => entry.characterName)).toEqual(['Satoru Gojo', 'Ryomen Sukuna', 'Satoru Gojo']);
    expect(queue[0]?.isCurrent).toBe(true);
    expect(queue.slice(1).every((entry) => !entry.isCurrent)).toBe(true);
    expect(queue.every((entry) => !entry.isSkipped && !entry.isExtraTurn)).toBe(true);
  });

  it('consumes a turn-skip charge and hands the turn straight back', () => {
    const opponent = player({ id: P2, activeEffects: [effect(STATUS_KIND.SKIP_TURNS, 1)] });
    const queue = projectTurnQueue([player({ id: P1 }), opponent], 0, 3);

    expect(queue.map((entry) => entry.playerId)).toEqual([P1, P2, P1]);
    expect(queue[1]).toMatchObject({ isSkipped: true, skipsRemaining: 0 });
    // The skip does not advance the turn, so the caster plays twice in a row.
    expect(queue[2]).toMatchObject({ playerId: P1, isExtraTurn: true, isSkipped: false });
  });

  it('keeps alternating while each charge eats one of the opponent\'s turns', () => {
    const opponent = player({ id: P2, activeEffects: [effect(STATUS_KIND.SKIP_TURNS, 2)] });
    const queue = projectTurnQueue([player({ id: P1 }), opponent], 0, 4);

    // Two charges cost the opponent two turns: the caster simply plays twice in between.
    expect(queue.map((entry) => `${entry.playerId}:${entry.isSkipped ? 'skip' : 'play'}`)).toEqual([
      'p1:play',
      'p2:skip',
      'p1:play',
      'p2:skip',
    ]);
    expect(queue[2]?.isExtraTurn).toBe(true);
    expect(queue[3]?.skipsRemaining).toBe(0);
  });

  it('projects nothing for a mode with no turn order', () => {
    const engine = makeEngine({ boardMode: BOARD_MODE.DUAL });
    expect(engine.getUpcomingTurnQueue()).toEqual([]);
  });
});

describe('turn-skip FSM', () => {
  it('routes a skipped turn back to the caster, then alternates again', () => {
    const engine = makeEngine({ p1: 'satoru_gojo', p2: 'yuji_itadori', trapCount: 8 });
    const banked = bankTraps(engine, P1, 0, 4, 0);
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);

    expectOk(engine.activateUltimate(P1, banked));
    expect(playerView(engine.getPublicView(), P2).activeEffects.map((status) => status.kind)).toContain(
      STATUS_KIND.SKIP_TURNS,
    );
    // The projection knows before the pass happens whose turn is lost.
    expect(
      engine.getUpcomingTurnQueue(3).map((entry) => `${entry.playerId}:${entry.isSkipped ? 'skip' : 'play'}`),
    ).toEqual([`${P1}:play`, `${P2}:skip`, `${P1}:play`]);

    const passed = passTurn(engine, P1, banked + 1);

    const view = engine.getPublicView();
    expect(view.turnOwner).toBe(P1);
    expect(playerView(view, P2).activeEffects.some((status) => status.kind === STATUS_KIND.SKIP_TURNS)).toBe(false);
    // The skipped turn is announced, and the queue is a plain alternation afterwards.
    expect(eventsOfType(passed.events, 'TURN_SKIPPED')[0]).toMatchObject({ playerId: P2, reason: 'DOMAIN' });
    expect(engine.getUpcomingTurnQueue(2).map((entry) => entry.playerId)).toEqual([P1, P2]);
  });
});

describe('simple domain window', () => {
  it('opens, ages with its owner\'s turns, and closes', () => {
    const engine = makeEngine({ p1: 'yuji_itadori', p2: 'sukuna', trapCount: 8 });
    const banked = bankTraps(engine, P1, 0, 4, 0);
    const opened = expectOk(engine.activateUltimate(P1, banked));

    expect(eventsOfType(opened, 'SIMPLE_DOMAIN_OPENED')[0]).toMatchObject({
      playerId: P1,
      ultimateId: 'soul_strike',
      turnsRemaining: GAME_CONSTANTS.DOMAIN_COUNTER_TURNS,
    });

    let view = engine.getPublicView();
    expect(domainStatusOf(playerView(view, P1))).toMatchObject({
      isActive: true,
      type: 'SIMPLE_DOMAIN',
      name: 'Simple Domain & Soul Strike',
      turnsRemaining: GAME_CONSTANTS.DOMAIN_COUNTER_TURNS,
    });
    // The barrier the same ultimate raised is real state, not a lasting status effect.
    expect(playerView(view, P1).shield).toBe(GAME_CONSTANTS.SHIELD_GRANT);

    const first = passTurn(engine, P1, banked + 1);
    expect(playerView(engine.getPublicView(), P1).activeSimpleDomain?.turnsRemaining).toBe(1);

    // The opponent's turn does not age P1's window: it belongs to P1's own turns.
    const second = passTurn(engine, P2, first.now + 1);
    expect(playerView(engine.getPublicView(), P1).activeSimpleDomain?.turnsRemaining).toBe(1);
    expect(eventsOfType(second.events, 'SIMPLE_DOMAIN_CLOSED')).toEqual([]);

    const third = passTurn(engine, P1, second.now + 1);
    expect(playerView(engine.getPublicView(), P1).activeSimpleDomain).toBeNull();
    expect(eventsOfType(third.events, 'SIMPLE_DOMAIN_CLOSED')[0]).toMatchObject({
      playerId: P1,
      ultimateId: 'soul_strike',
    });
  });

  it('flags a standing domain as neutralized for the widget', () => {
    const engine = makeEngine({ p1: 'satoru_gojo', p2: 'yuji_itadori', trapCount: 8 });
    let now = bankTraps(engine, P1, 0, 4, 0);
    expectOk(engine.activateUltimate(P1, now));
    expect(domainStatusOf(playerView(engine.getPublicView(), P1))).toMatchObject({
      isActive: true,
      type: 'DOMAIN',
      name: 'Unlimited Void',
      isNeutralized: false,
      sureHitDescription: 'Locks the enemy out for a turn, then rushes their next turn.',
    });

    // Unlimited Void burns P2's next turn, so one pass hands the turn straight back.
    now = passTurn(engine, P1, now + 1).now;
    expect(engine.getPublicView().turnOwner).toBe(P1);
    now = passTurn(engine, P1, now + 1).now;
    expect(engine.getPublicView().turnOwner).toBe(P2);

    now = bankTraps(engine, P2, 4, 4, now + 1);
    expectOk(engine.activateUltimate(P2, now));

    const view = engine.getPublicView();
    const owner = playerView(view, P1);
    expect(owner.activeEffects.some((status) => status.kind === STATUS_KIND.DOMAIN_NULLIFIED)).toBe(true);
    expect(domainStatusOf(owner)).toMatchObject({
      type: 'DOMAIN',
      isNeutralized: true,
      neutralizedTurnsRemaining: GAME_CONSTANTS.DOMAIN_COUNTER_TURNS,
    });
    expect(domainStatusOf(playerView(view, P2))).toMatchObject({ type: 'SIMPLE_DOMAIN', isNeutralized: false });
  });
});

describe('barrier soak', () => {
  it('soaks before HP and names both halves of the split', () => {
    const target = player({ shield: 30 });
    const result = applyDamage(target, 12);

    expect(result).toMatchObject({ dealt: 0, absorbed: 12, damageToHp: 0, damageToShield: 12 });
    expect(target).toMatchObject({ hp: 100, shield: 18 });
  });

  it('spills only the overflow into HP', () => {
    const target = player({ shield: 8 });
    expect(applyDamage(target, 20)).toMatchObject({ dealt: 12, absorbed: 8, damageToHp: 12, damageToShield: 8 });
    expect(target).toMatchObject({ hp: 88, shield: 0 });
  });

  it('is bypassed by true damage, spelled either way', () => {
    const piercing = player({ shield: 40 });
    expect(applyDamage(piercing, 15, { isPiercing: true })).toMatchObject({ damageToHp: 15, damageToShield: 0 });
    expect(piercing).toMatchObject({ hp: 85, shield: 40 });

    const classic = player({ shield: 40 });
    expect(applyDamage(classic, 15, { piercing: true }).damageToHp).toBe(15);
    expect(classic.shield).toBe(40);
  });

  it('negates everything behind an absolute shield', () => {
    const guarded = player({ shield: 10, activeEffects: [effect(STATUS_KIND.ABSOLUTE_SHIELD, 1, 2)] });
    expect(applyDamage(guarded, 50)).toMatchObject({ damageToHp: 0, damageToShield: 50 });
    expect(guarded).toMatchObject({ hp: 100, shield: 10 });
  });

  it('drains the barrier for ability damage instead of HP', () => {
    const engine = makeEngine({ p1: 'sukuna', p2: 'kento_nanami', trapCount: 8 });
    let now = bankTraps(engine, P1, 0, 1, 0);
    now = passTurn(engine, P1, now + 1).now;

    now = bankTraps(engine, P2, 1, 4, now + 1);
    expect(playerView(engine.getPublicView(), P2).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    // Nanami's Overtime Collapse raises a 25 point barrier as part of its cast.
    expectOk(engine.activateUltimate(P2, now));
    expect(playerView(engine.getPublicView(), P2).shield).toBe(GAME_CONSTANTS.SHIELD_GRANT);

    now = passTurn(engine, P2, now + 1).now;
    now = bankTraps(engine, P1, 5, 2, now + 1);
    const cleave = expectOk(engine.activateSkill(P1, now));

    expect(eventsOfType(cleave, 'DAMAGE_DEALT')[0]).toMatchObject({
      targetId: P2,
      dealt: 0,
      absorbed: 25,
      cause: DAMAGE_CAUSE.SKILL,
    });
    const soaked = playerView(engine.getPublicView(), P2);
    expect(soaked.shield).toBe(GAME_CONSTANTS.SHIELD_GRANT - 25);
    expect(soaked.hp).toBe(100);
  });

  it('drains the barrier for a planted card effect', () => {
    const engine = makeEngine({ p1: 'yuji_itadori', p2: 'jogo', trapCount: 8 });
    let now = bankTraps(engine, P1, 0, 4, 0);
    expectOk(engine.activateUltimate(P1, now));
    expect(playerView(engine.getPublicView(), P1).shield).toBe(GAME_CONSTANTS.SHIELD_GRANT);

    now = passTurn(engine, P1, now + 1).now;
    now = bankTraps(engine, P2, 4, 2, now + 1);
    const planted = expectOk(engine.activateSkill(P2, now));
    const modified = eventsOfType(planted, 'CARD_MODIFIED')[0];
    const laced = modified && 'cardIds' in modified ? [...modified.cardIds] : [];
    expect(laced).toHaveLength(2);

    now = passTurn(engine, P2, now + 1).now;
    const bomb = expectOk(engine.flipCard(P1, laced[0] as string, now + 1));

    expect(eventsOfType(bomb, 'DAMAGE_DEALT')[0]).toMatchObject({
      targetId: P1,
      dealt: 0,
      absorbed: CARD_EFFECT_RULES[CARD_EFFECT_KIND.LAVA].damage,
      cause: DAMAGE_CAUSE.CARD_EFFECT,
    });
    const flipper = playerView(engine.getPublicView(), P1);
    expect(flipper.shield).toBe(GAME_CONSTANTS.SHIELD_GRANT - 15);
    expect(flipper.hp).toBe(100);
  });

  it('drains the barrier for end-of-turn burn damage', () => {
    const engine = makeEngine({ p1: 'jogo', p2: 'yuji_itadori', trapCount: 8 });
    let now = bankTraps(engine, P1, 0, 4, 0);
    // Coffin of the Iron Mountain burns P2 for 3 turns and seals two of their cards.
    expectOk(engine.activateUltimate(P1, now));
    expect(
      playerView(engine.getPublicView(), P2).activeEffects.some(
        (status) => status.kind === STATUS_KIND.DAMAGE_OVER_TIME,
      ),
    ).toBe(true);

    now = passTurn(engine, P1, now + 1).now;
    expect(engine.getPublicView().turnOwner).toBe(P2);

    // P2 raises a barrier the honest way: two consecutive matches are a Kokusen, which
    // pays the 20 point pool this test then watches a burn chew through.
    const first = matchingPair(engine.getPublicView());
    now = playMatch(engine, P2, first, now + 1);
    const second = matchingPair(engine.getPublicView());
    now = playMatch(engine, P2, second, now + 1);
    expect(playerView(engine.getPublicView(), P2).shield).toBe(GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN);

    // The burn fires when its owner's turn closes, which is P2 playing out this turn.
    const burned = passTurn(engine, P2, now + 1);
    const burn = eventsOfType(burned.events, 'DAMAGE_DEALT').find(
      (event) => 'cause' in event && event.cause === DAMAGE_CAUSE.OVER_TIME,
    );
    expect(burn).toMatchObject({ targetId: P2, dealt: 0, absorbed: 8 });

    const target = playerView(engine.getPublicView(), P2);
    expect(target.shield).toBe(GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN - 8);
    expect(target.hp).toBe(100);
  });
});
