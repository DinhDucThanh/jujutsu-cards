import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_EFFECT_KIND,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  CHARACTERS,
  GAME_CONSTANTS,
  GAME_PACING,
  SHARED_BOARD_ID,
  SKILLS,
  STATUS_KIND,
  ULTIMATES,
  GameEngine,
  adaptStatusForMode,
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

const Engine = GameEngine;

const P1 = 'p1';
const P2 = 'p2';

/**
 * Two unique traps, then standard pairs on (2,3), (4,5), ... Every pair shows a distinct
 * fighter while the roster lasts, as a real deal does, because matching is by fighter:
 * a board of identical characters would make every flip a match.
 */
function trapLayout(trapCount: number, size = 16): CardSpec[] {
  const traps: CardSpec[] = Array.from({ length: trapCount }, (_, i) => ({
    pairId: `trap:sukuna_finger:${i}`,
    type: CARD_TYPE.TRAP,
    characterId: 'sukuna',
    trapId: 'sukuna_finger',
  }));
  const playable = size - trapCount;
  const pairs: CardSpec[] = Array.from({ length: playable }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: pairCharacter(Math.floor(i / 2)),
    trapId: null,
  }));
  return [...traps, ...pairs];
}

/** The fighter a fixture pair shows. Distinct per pair while the roster lasts. */
function pairCharacter(pair: number): CharacterId {
  return CHARACTER_IDS[pair % CHARACTER_IDS.length] as CharacterId;
}

/** The four lore synergy pairs on (0,1), (2,3), (4,5), (6,7), then four standard pairs. */
function synergyLayout(): CardSpec[] {
  const synergy: Array<[string, string, string]> = [
    ['divine_dog_pact', 'megumi_fushiguro', 'divine_dog'],
    ['seven_three_blade', 'kento_nanami', 'ratio_blade'],
    ['six_eyes_vision', 'satoru_gojo', 'six_eyes'],
    ['brotherhood_barrage', 'yuji_itadori', 'aoi_todo'],
  ];
  const specs: CardSpec[] = [];
  for (const [id, first, second] of synergy) {
    for (const subject of [first, second]) {
      specs.push({
        pairId: `syn:${id}`,
        type: CARD_TYPE.SYNERGY,
        characterId: subject as CardSpec['characterId'],
        trapId: null,
      });
    }
  }
  specs.push(
    ...Array.from({ length: 8 }, (_, i) => ({
      pairId: `pair-${Math.floor(i / 2)}`,
      type: CARD_TYPE.STANDARD,
      characterId: pairCharacter(Math.floor(i / 2)),
      trapId: null,
    })),
  );
  return specs;
}

interface EngineOptions {
  readonly layout?: CardSpec[];
  readonly trapCount?: number;
  readonly p1?: CharacterId;
  readonly p2?: CharacterId;
  readonly mode?: BoardMode;
}

function makeEngine(options: EngineOptions = {}): GameEngine {
  const config: MatchConfig = {
    matchId: 'abilities-test',
    boardMode: options.mode ?? BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: options.p1 ?? 'nobara_kugisaki' },
      { id: P2, characterId: options.p2 ?? 'sukuna' },
    ],
    boardSize: 16,
    trapCount: options.trapCount ?? 0,
    synergyPairCount: 0,
  };
  const engine = new Engine(
    config,
    createSeededRandom(11),
    options.layout ?? trapLayout(options.trapCount ?? 0),
  );
  expectOk(engine.start(0));
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
  const player = view.players.find((candidate) => candidate.id === id);
  if (!player) throw new Error(`missing player ${id}`);
  return player;
}

function cardId(engine: GameEngine, playerId: string, position: number): string {
  const board = boardOfPlayer(engine.getPublicView(), playerId);
  const card = board[position];
  if (!card) throw new Error(`no card at position ${position}`);
  return card.id;
}

/** Flips `count` traps starting at `from`, banking CE without ending the turn. */
function bankTraps(engine: GameEngine, playerId: string, from: number, count: number, now: number): number {
  let time = now;
  for (let i = from; i < from + count; i++) {
    expectOk(engine.flipCard(playerId, cardId(engine, playerId, i), time));
    time += 1;
  }
  return time;
}

interface PairOutcome {
  readonly events: readonly GameEvent[];
  readonly now: number;
}

/**
 * Flips two mismatching cards as one attempt and waits out the 1s reveal window.
 * The returned events include the ones the resolution tick produced (turn end,
 * recoil, burns), since those fire when the evaluation window closes.
 */
function playMismatch(engine: GameEngine, playerId: string, a: number, b: number, now: number): PairOutcome {
  expectOk(engine.flipCard(playerId, cardId(engine, playerId, a), now));
  const events = [...expectOk(engine.flipCard(playerId, cardId(engine, playerId, b), now + 1))];
  const resolved = now + 1 + GAME_CONSTANTS.MISMATCH_REVEAL_MS;
  events.push(...expectOk(engine.tick(resolved)));
  return { events, now: resolved };
}

/** Flips two matching cards and waits out the match window. */
function playMatch(engine: GameEngine, playerId: string, a: number, b: number, now: number): PairOutcome {
  expectOk(engine.flipCard(playerId, cardId(engine, playerId, a), now));
  const events = [...expectOk(engine.flipCard(playerId, cardId(engine, playerId, b), now + 1))];
  const resolved = now + 1 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
  events.push(...expectOk(engine.tick(resolved)));
  return { events, now: resolved };
}

/**
 * Two face-down cards from different pairs, using the layout's (2k, 2k+1) pairing.
 * Needed once a domain has cleared pairs whose positions are no longer predictable.
 */
function mismatchingPositions(view: PublicMatchView, from = 8): [number, number] {
  const hidden = view.board
    .filter((card) => card.position >= from && card.state === CARD_STATE.HIDDEN)
    .map((card) => card.position);
  const groups = new Map<number, number[]>();
  for (const position of hidden) {
    const key = Math.floor(position / 2);
    groups.set(key, [...(groups.get(key) ?? []), position]);
  }
  const [first, second] = [...groups.values()];
  if (first?.[0] === undefined || second?.[0] === undefined) throw new Error('need two hidden pairs');
  return [first[0], second[0]];
}

function lastEvent(events: readonly GameEvent[], type: GameEvent['type']): GameEvent | undefined {
  return [...events].reverse().find((event) => event.type === type);
}

function eventsOfType(events: readonly GameEvent[], type: GameEvent['type']): GameEvent[] {
  return events.filter((event) => event.type === type);
}

/** Card ids carried by the first event of a given type, for the card-targeting effects. */
function cardIdsOf(events: readonly GameEvent[], type: GameEvent['type']): string[] {
  const event = events.find((candidate) => candidate.type === type);
  return event && 'cardIds' in event ? [...event.cardIds] : [];
}

// ---------------------------------------------------------------------------

describe('active skills', () => {
  it('Boogie Woogie swaps two face-down cards on the enemy grid', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'aoi_todo' });
    const before = boardOfPlayer(engine.getPublicView(), P1).map((card) => card.id);
    const now = bankTraps(engine, P1, 0, 2, 0);

    const events = expectOk(engine.activateSkill(P1, now));
    const swapped = eventsOfType(events, 'CARDS_SWAPPED')[0];
    expect(swapped).toBeDefined();

    const after = boardOfPlayer(engine.getPublicView(), P1).map((card) => card.id);
    expect(after).toHaveLength(before.length);
    const changed = after.filter((id, index) => id !== before[index]);
    expect(changed).toHaveLength(2);
    // Only face-down cards were touched.
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(10);
  });

  it('Hairpin detonates a card and leaves a cursed nail that stuns the opponent', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'nobara_kugisaki' });
    let now = bankTraps(engine, P1, 0, 2, 0);

    const events = expectOk(engine.activateSkill(P1, now));
    expect(eventsOfType(events, 'CARDS_REVEALED')).toHaveLength(1);
    expect(eventsOfType(events, 'CARD_MODIFIED')).toHaveLength(1);
    expect(playerView(engine.getPublicView(), P2).hp).toBe(90);

    const nailed = cardIdsOf(events, 'CARD_MODIFIED')[0];
    expect(nailed).toBeDefined();

    // Hand the turn over, then let the opponent flip the nailed card.
    now = playMismatch(engine, P1, 8, 10, now + 1).now;
    const trigger = expectOk(engine.flipCard(P2, nailed as string, now + 10));
    expect(eventsOfType(trigger, 'CARD_EFFECT_TRIGGERED')[0]).toMatchObject({ modifier: CARD_EFFECT_KIND.NAILED });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(75);
    expect(playerView(engine.getPublicView(), P2).stunnedUntil).toBeGreaterThan(now + 10);

    // The 2s stun locks the second flip out.
    const blocked = engine.flipCard(P2, cardId(engine, P2, 9), now + 11);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('STUNNED');
    expectOk(engine.flipCard(P2, cardId(engine, P2, 9), now + 3000));
  });

  it('Infinity negates all incoming damage for one turn', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'satoru_gojo' });
    let now = bankTraps(engine, P1, 0, 2, 0);
    expectOk(engine.activateSkill(P1, now));
    expect(playerView(engine.getPublicView(), P1).activeEffects.map((e) => e.kind)).toContain(
      STATUS_KIND.ABSOLUTE_SHIELD,
    );

    now = playMismatch(engine, P1, 8, 10, now + 1).now;
    expectOk(engine.flipCard(P2, cardId(engine, P2, 8), now + 10));
    const events = expectOk(engine.flipCard(P2, cardId(engine, P2, 9), now + 11));
    expect(eventsOfType(events, 'DAMAGE_DEALT')[0]).toMatchObject({ dealt: 0, absorbed: 10 });
    expect(playerView(engine.getPublicView(), P1).hp).toBe(100);
  });

  it('7:3 Ratio makes the next match a 2.5x critical', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'kento_nanami' });
    let now = bankTraps(engine, P1, 0, 2, 0);
    expectOk(engine.activateSkill(P1, now));

    now += 1;
    expectOk(engine.flipCard(P1, cardId(engine, P1, 8), now));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 9), now + 1));
    expect(eventsOfType(events, 'DAMAGE_DEALT')[0]).toMatchObject({ dealt: 25, critical: true });
    // The guaranteed critical is consumed by the match; the armor-piercing edge lasts the turn.
    expect(playerView(engine.getPublicView(), P1).activeEffects.map((effect) => effect.kind)).toEqual([
      STATUS_KIND.PIERCING_ATTACKS,
    ]);
  });

  it('Cleave deals 25% of the target current HP without touching the grid', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'sukuna' });
    const now = bankTraps(engine, P1, 0, 2, 0);
    const events = expectOk(engine.activateSkill(P1, now));
    expect(lastEvent(events, 'DAMAGE_DEALT')).toMatchObject({ dealt: 25, cause: 'SKILL' });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(75);
    expect(boardOfPlayer(engine.getPublicView(), P1).every((card) => card.state !== CARD_STATE.REVEALED)).toBe(true);
  });

  it('Ten Shadows: Nue reveals cards, which hide again when the window closes', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'megumi_fushiguro' });
    let now = bankTraps(engine, P1, 0, 2, 0);
    const events = expectOk(engine.activateSkill(P1, now));
    const ids = cardIdsOf(events, 'CARDS_REVEALED');
    expect(ids).toHaveLength(2);
    const before = engine.getPublicView();
    const shown = before.board.filter((card) => ids.includes(card.id));
    expect(shown.every((card) => card.state === CARD_STATE.REVEALED && card.pairId !== null)).toBe(true);

    // The peek is 2.0s: still face-up one millisecond before it ends, hidden at the mark.
    now += GAME_PACING.CARD_PEEK_REVEAL_DURATION_MS - 1;
    expectOk(engine.tick(now));
    const held = engine.getPublicView();
    expect(held.board.filter((card) => ids.includes(card.id)).every((card) => card.state === CARD_STATE.REVEALED)).toBe(
      true,
    );

    expectOk(engine.tick(now + 1));
    const after = engine.getPublicView();
    expect(after.board.filter((card) => ids.includes(card.id)).every((card) => card.state === CARD_STATE.HIDDEN)).toBe(
      true,
    );
  });

  it('Idle Transfiguration hides the real face of corrupted cards for a turn', () => {
    // No traps: CE is banked with matches so the corrupted cards are all real pairs.
    const engine = makeEngine({ layout: trapLayout(0), p1: 'mahito' });
    let now = 0;
    for (const [a, b] of [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ] as const) {
      now = playMatch(engine, P1, a, b, now + 1).now;
    }
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    const events = expectOk(engine.activateSkill(P1, now));
    const modified = eventsOfType(events, 'CARD_MODIFIED')[0];
    const ids = cardIdsOf(events, 'CARD_MODIFIED');
    expect(ids).toHaveLength(3);

    const corrupted = engine.getPublicView().board.filter((card) => ids.includes(card.id));
    expect(corrupted).toHaveLength(3);
    expect(corrupted.every((card) => card.corrupted && card.pairId === null)).toBe(true);

    // Flipping one still hides its identity from the public view.
    expectOk(engine.flipCard(P1, ids[0] as string, now + 1));
    const flipped = engine.getPublicView().board.find((card) => card.id === ids[0]);
    expect(flipped?.state).toBe(CARD_STATE.REVEALED);
    expect(flipped?.pairId).toBeNull();

    // The corruption survives Mahito's own turn end, so it still hides cards on the enemy turn.
    now += 1 + GAME_CONSTANTS.TURN_TIME_EARLY_MS;
    expectOk(engine.tick(now));
    expect(engine.getPublicView().turnOwner).toBe(P2);
    expect(engine.getPublicView().board.filter((card) => ids.includes(card.id)).every((card) => card.corrupted)).toBe(
      true,
    );

    // After a full round the modifier is gone and the real faces are readable again.
    now = playMismatch(engine, P2, 12, 14, now + 1).now;
    now = playMismatch(engine, P1, 11, 13, now + 1).now;
    expect(engine.getPublicView().board.filter((card) => ids.includes(card.id)).every((card) => !card.corrupted)).toBe(
      true,
    );
  });

  it('Ember Insects explodes and drains CE when the opponent flips a trapped card', () => {
    const engine = makeEngine({ layout: trapLayout(0), p1: 'jogo' });
    let now = playMatch(engine, P1, 0, 1, 0).now;
    now = playMatch(engine, P1, 2, 3, now + 1).now;
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBeGreaterThanOrEqual(50);
    const events = expectOk(engine.activateSkill(P1, now));
    const ids = cardIdsOf(events, 'CARD_MODIFIED');
    expect(ids).toHaveLength(2);

    // Hand the turn over, then let the opponent bank CE and spring the trap.
    now = playMismatch(engine, P1, 4, 6, now + 1).now;
    now = playMatch(engine, P2, 8, 9, now + 1).now;
    const ceBefore = playerView(engine.getPublicView(), P2).cursedEnergy;
    expect(ceBefore).toBe(GAME_CONSTANTS.MATCH_CE_GAIN);

    const trigger = expectOk(engine.flipCard(P2, ids[0] as string, now + 1));
    expect(lastEvent(trigger, 'CARD_EFFECT_TRIGGERED')).toMatchObject({ modifier: CARD_EFFECT_KIND.LAVA });
    // The explosion hurts and drains the player who flipped the trapped card.
    expect(playerView(engine.getPublicView(), P2).hp).toBe(50);
    expect(playerView(engine.getPublicView(), P2).cursedEnergy).toBe(ceBefore - 10);
    expect(eventsOfType(trigger, 'CE_CHANGED')[0]).toMatchObject({ delta: -10, cause: 'CARD_EFFECT' });
  });

  it('Gamble Turn doubles a won match, refunds 40 CE, and keeps the turn', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'kinji_hakari' });
    const now = bankTraps(engine, P1, 0, 2, 0);
    const ceBefore = playerView(engine.getPublicView(), P1).cursedEnergy;
    const p2Before = playerView(engine.getPublicView(), P2).hp;
    expectOk(engine.activateSkill(P1, now));
    const ceCast = playerView(engine.getPublicView(), P1).cursedEnergy;
    expect(ceCast).toBe(ceBefore - GAME_CONSTANTS.GAMBLE_TURN_CE_COST);

    const won = playMatch(engine, P1, 8, 9, now + 1);
    expect(lastEvent(won.events, 'GAMBLE_RESOLVED')).toMatchObject({ playerId: P1, won: true });
    const strike = 2 * GAME_CONSTANTS.BASE_MATCH_DAMAGE;
    expect(playerView(engine.getPublicView(), P2).hp).toBe(p2Before - strike);
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(
      ceCast + GAME_CONSTANTS.GAMBLE_REFUND_CE + GAME_CONSTANTS.MATCH_CE_GAIN,
    );
    expect(engine.getPublicView().turnOwner).toBe(P1);
  });

  it('a lost Gamble Turn costs 15% of max HP and passes the turn', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'kinji_hakari' });
    const now = bankTraps(engine, P1, 0, 2, 0);
    const before = playerView(engine.getPublicView(), P1);
    expectOk(engine.activateSkill(P1, now));

    const lost = playMismatch(engine, P1, 8, 10, now + 1);
    const backlash = Math.round(before.maxHp * GAME_CONSTANTS.GAMBLE_BACKLASH_MAX_HP_FRACTION);
    expect(lastEvent(lost.events, 'GAMBLE_RESOLVED')).toMatchObject({ playerId: P1, won: false, amount: backlash });
    expect(playerView(engine.getPublicView(), P1).hp).toBe(before.hp - backlash);
    expect(engine.getPublicView().turnOwner).toBe(P2);
  });

  it('Divergent Fist deals 25 true damage and no shockwave follows', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'yuji_itadori' });
    const now = bankTraps(engine, P1, 0, 2, 0);
    const cast = expectOk(engine.activateSkill(P1, now));
    expect(lastEvent(cast, 'DAMAGE_DEALT')).toMatchObject({ dealt: 25, cause: 'SKILL' });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(75);

    // The next match only adds its normal strike; nothing lingers past the turn.
    const match = playMatch(engine, P1, 8, 9, now + 1);
    expect(playerView(engine.getPublicView(), P2).hp).toBe(75 - GAME_CONSTANTS.BASE_MATCH_DAMAGE);
    expect(match.events.some((event) => 'cause' in event && event.cause === 'SHOCKWAVE')).toBe(false);
  });

  it('Soul Divergent Strike hits for 15% of current HP and heals Yuji 15 while Soul Strike is active', () => {
    // The 8 shared traps are split across turns: P1 banks 0-3 (100 CE), P2 banks 4-5 (50 CE
    // for Cleave), and P1 banks 6-7 after its ultimate (50 CE for Soul Strike).
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'yuji_itadori', p2: 'sukuna' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    // Let P1's turn run out on the clock, which hands the turn over without a CE penalty.
    expectOk(engine.tick(now + GAME_CONSTANTS.TURN_TIME_EARLY_MS));
    expect(engine.getPublicView().turnOwner).toBe(P2);

    // Sukuna's Cleave takes 25% of Yuji's max HP (100), leaving him at 75 before the heal.
    now = bankTraps(engine, P2, 4, 2, now + GAME_CONSTANTS.TURN_TIME_EARLY_MS + 1);
    expectOk(engine.activateSkill(P2, now + 1));
    expect(playerView(engine.getPublicView(), P1).hp).toBe(75);
    now = playMismatch(engine, P2, 12, 14, now + 2).now;
    expect(engine.getPublicView().turnOwner).toBe(P1);

    expectOk(engine.activateUltimate(P1, now + 1));
    now = bankTraps(engine, P1, 6, 2, now + 2);
    const cast = expectOk(engine.activateSkill(P1, now));
    expect(lastEvent(cast, 'DAMAGE_DEALT')).toMatchObject({ dealt: 15, cause: 'SKILL' });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(85);
    expect(playerView(engine.getPublicView(), P1).hp).toBe(90);
  });

  it('rejects a skill without enough CE, or with a flip already open', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'sukuna' });
    const poor = engine.activateSkill(P1, 0);
    expect(poor.ok).toBe(false);
    if (!poor.ok) expect(poor.code).toBe('INSUFFICIENT_CE');

    const now = bankTraps(engine, P1, 0, 2, 1);
    expectOk(engine.flipCard(P1, cardId(engine, P1, 8), now + 1));
    const flipInProgress = engine.activateSkill(P1, now + 2);
    expect(flipInProgress.ok).toBe(false);
    if (!flipInProgress.ok) expect(flipInProgress.code).toBe('FLIP_IN_PROGRESS');
  });
});

describe('ultimates', () => {
  it('a Simple Domain neutralizes an active enemy domain for 2 turns', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'yuji_itadori', p2: 'sukuna' });
    const banked = bankTraps(engine, P1, 0, 4, 0);
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    // Let the turn pass on the clock, so banking CE never costs the mismatch penalty.
    expectOk(engine.tick(banked + GAME_CONSTANTS.TURN_TIME_EARLY_MS));
    expect(engine.getPublicView().turnOwner).toBe(P2);

    let now = bankTraps(engine, P2, 4, 4, banked + GAME_CONSTANTS.TURN_TIME_EARLY_MS + 1);
    expect(playerView(engine.getPublicView(), P2).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    const shrine = expectOk(engine.activateUltimate(P2, now + 1));
    expect(shrine).toContainEqual(
      expect.objectContaining({ type: 'ULTIMATE_ACTIVATED', ultimateType: 'DOMAIN', domainId: 'malevolent_shrine' }),
    );
    // Malevolent Shrine cleaves two pairs off the shared grid immediately.
    expect(eventsOfType(shrine, 'CARDS_AUTO_MATCHED')).toHaveLength(2);

    // P2's turn runs out on the clock, which hands the turn back without a CE penalty.
    expectOk(engine.tick(now + GAME_CONSTANTS.TURN_TIME_EARLY_MS + 10));
    expect(engine.getPublicView().turnOwner).toBe(P1);
    const soulStrike = expectOk(engine.activateUltimate(P1, now + GAME_CONSTANTS.TURN_TIME_EARLY_MS + 11));
    expect(lastEvent(soulStrike, 'DOMAIN_NULLIFIED')).toMatchObject({ playerId: P2, turnsRemaining: 2 });

    const p1Effects = playerView(engine.getPublicView(), P1).activeEffects.map((effect) => effect.kind);
    expect(p1Effects).toContain(STATUS_KIND.PIERCING_ATTACKS);
    expect(p1Effects).toContain(STATUS_KIND.FLASH_WINDOW);
  });

  it('Soul Strike makes the very next match a Black Flash that pierces shields', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'yuji_itadori' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    expectOk(engine.activateUltimate(P1, now));

    now += 1;
    expectOk(engine.flipCard(P1, cardId(engine, P1, 8), now));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 9), now + 1));
    expect(lastEvent(events, 'BLACK_FLASH')).toBeDefined();
    expect(eventsOfType(events, 'DAMAGE_DEALT')[0]).toMatchObject({ dealt: 25, critical: true });
  });

  it('120% Potential reveals one random matching pair for 2 seconds', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'aoi_todo' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    const events = expectOk(engine.activateUltimate(P1, now));
    const revealed = cardIdsOf(events, 'CARDS_REVEALED');
    expect(revealed).toHaveLength(2);

    const shown = engine.getPublicView().board.filter((card) => revealed.includes(card.id));
    expect(shown).toHaveLength(2);
    expect(shown[0]?.pairId).not.toBeNull();
    expect(shown[0]?.pairId).toBe(shown[1]?.pairId);

    now += GAME_PACING.CARD_PEEK_REVEAL_DURATION_MS;
    expectOk(engine.tick(now));
    expect(
      engine.getPublicView().board.filter((card) => revealed.includes(card.id)).every((c) => c.state === 'HIDDEN'),
    ).toBe(true);
  });

  it('Resonance Burst hits for 20 and punishes the next mismatch with 10 recoil', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'nobara_kugisaki' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    expectOk(engine.activateUltimate(P1, now));
    expect(playerView(engine.getPublicView(), P2).hp).toBe(80);

    now = playMismatch(engine, P1, 8, 10, now + 1).now;
    const { events } = playMismatch(engine, P2, 12, 14, now + 1);
    const recoil = eventsOfType(events, 'DAMAGE_DEALT').find((e) => 'cause' in e && e.cause === 'RECOIL');
    expect(recoil).toMatchObject({ dealt: 10, targetId: P2 });
  });

  it('Overtime Collapse resolves a pair for the caster, heals 15, and hits for 20', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'kento_nanami' });
    const banked = bankTraps(engine, P1, 0, 4, 0);
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    // Hand the turn over on the clock, then let the opponent land two matches on Nanami.
    expectOk(engine.tick(banked + GAME_CONSTANTS.TURN_TIME_EARLY_MS));
    expect(engine.getPublicView().turnOwner).toBe(P2);
    let now = playMatch(engine, P2, 8, 9, banked + GAME_CONSTANTS.TURN_TIME_EARLY_MS + 1).now;
    now = playMatch(engine, P2, 10, 11, now + 1).now;
    expect(playerView(engine.getPublicView(), P1).hp).toBe(65);
    now = playMismatch(engine, P2, 12, 14, now + 1).now;
    expect(engine.getPublicView().turnOwner).toBe(P1);

    const before = playerView(engine.getPublicView(), P1).pairsMatched;
    const events = expectOk(engine.activateUltimate(P1, now + 1));
    expect(eventsOfType(events, 'CARDS_AUTO_MATCHED')).toHaveLength(1);
    expect(playerView(engine.getPublicView(), P1).pairsMatched).toBe(before + 1);
    // Heals 15 (65 -> 80) and still hits for the flat 20 plus the resolved pair.
    expect(playerView(engine.getPublicView(), P1).hp).toBe(80);
    expect(playerView(engine.getPublicView(), P2).hp).toBeLessThan(100);
  });

  it('a Kokusen restores 10 HP and raises 20 barrier for a damaged attacker', () => {
    // Both seats are Sukuna so either one can land a clean 18 point cleave first:
    // the Kokusen heal has to reach a fighter who is actually below maximum HP.
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'sukuna', p2: 'sukuna' });
    let now = bankTraps(engine, P1, 0, 2, 0);
    expectOk(engine.activateSkill(P1, now));
    expect(playerView(engine.getPublicView(), P2).hp).toBe(75);

    now = playMismatch(engine, P1, 8, 10, now + 1).now;
    expect(engine.getPublicView().turnOwner).toBe(P2);

    now = bankTraps(engine, P2, 2, 2, now + 1);
    expect(playerView(engine.getPublicView(), P2).cursedEnergy).toBe(60);
    expectOk(engine.activateSkill(P2, now));

    now = playMatch(engine, P2, 8, 9, now + 1).now;
    const { events } = playMatch(engine, P2, 10, 11, now + 1);

    expect(eventsOfType(events, 'BLACK_FLASH')).toHaveLength(1);
    expect(eventsOfType(events, 'HEALED')).toMatchObject([{ playerId: P2, amount: GAME_CONSTANTS.BLACK_FLASH_HEAL }]);
    const barrier = events.find(
      (event) => event.type === 'STATUS_APPLIED' && event.status === STATUS_KIND.SHIELD,
    );
    expect(barrier).toMatchObject({ value: GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN });

    const attacker = playerView(engine.getPublicView(), P2);
    expect(attacker.hp).toBe(75 + GAME_CONSTANTS.BLACK_FLASH_HEAL);
    expect(attacker.shield).toBe(GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN);
  });

  it('Malevolent Shrine cleaves two pairs and bleeds the opponent for 2 turns', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'sukuna' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    const events = expectOk(engine.activateUltimate(P1, now));
    expect(eventsOfType(events, 'CARDS_AUTO_MATCHED')).toHaveLength(2);
    expect(playerView(engine.getPublicView(), P2).activeEffects.map((e) => e.kind)).toContain(
      STATUS_KIND.DAMAGE_OVER_TIME,
    );

    // The bleed lands at the end of the opponent's turn.
    now = playMismatch(engine, P1, ...mismatchingPositions(engine.getPublicView()), now + 1).now;
    const { events: p2Events } = playMismatch(engine, P2, ...mismatchingPositions(engine.getPublicView()), now + 1);
    const burn = eventsOfType(p2Events, 'DAMAGE_DEALT').find((e) => 'cause' in e && e.cause === 'OVER_TIME');
    expect(burn).toMatchObject({ dealt: 10, targetId: P2 });
  });

  it('Chimera Shadow Garden raises the flip limit to three cards per attempt', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'megumi_fushiguro' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    expectOk(engine.activateUltimate(P1, now));
    expect(playerView(engine.getPublicView(), P1).flipLimit).toBe(3);

    // Two mismatched cards plus the partner of the first: the attempt matches and drops the spare.
    now += 1;
    expectOk(engine.flipCard(P1, cardId(engine, P1, 8), now));
    expectOk(engine.flipCard(P1, cardId(engine, P1, 10), now + 1));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 9), now + 2));
    expect(lastEvent(events, 'PAIR_MATCHED')).toBeDefined();
    expect(eventsOfType(events, 'CARD_HIDDEN').length).toBeGreaterThan(0);
  });

  it('Self-Embodiment of Perfection permanently cuts 25% of the enemy maximum HP', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'mahito' });
    const now = bankTraps(engine, P1, 0, 4, 0);
    expectOk(engine.activateUltimate(P1, now));
    const p2 = playerView(engine.getPublicView(), P2);
    expect(p2.maxHp).toBe(75);
    expect(p2.hp).toBe(75);
  });

  it('Coffin of the Iron Mountain burns over three turns and seals two cards', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'jogo' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    const events = expectOk(engine.activateUltimate(P1, now));
    const sealed = cardIdsOf(events, 'CARD_MODIFIED');
    expect(sealed).toHaveLength(2);

    now = playMismatch(engine, P1, 8, 10, now + 1).now;
    const locked = engine.flipCard(P2, sealed[0] as string, now + 1);
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.code).toBe('CARD_LOCKED');
  });

  it('Unlimited Void skips the enemy turn and rushes the one after it', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'satoru_gojo' });
    let now = bankTraps(engine, P1, 0, 4, 0);
    expectOk(engine.activateUltimate(P1, now));

    const first = playMismatch(engine, P1, 8, 10, now + 1);
    expect(lastEvent(first.events, 'TURN_SKIPPED')).toMatchObject({ playerId: P2 });
    expect(engine.getPublicView().turnOwner).toBe(P1);

    // P2 eventually gets a turn, but on a 5s clock.
    now = playMismatch(engine, P1, 12, 14, first.now + 1).now;
    const view = engine.getPublicView();
    expect(view.turnOwner).toBe(P2);
    expect((view.turnDeadline ?? 0) - now).toBe(GAME_CONSTANTS.SHORT_TURN_TIME_MS);
  });

  it('Idle Death Gamble opens with free re-spins and resolves each spin', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'kinji_hakari' });
    const now = bankTraps(engine, P1, 0, 4, 0);
    const opened = expectOk(engine.activateUltimate(P1, now));
    expect(lastEvent(opened, 'PACHINKO_OPENED')).toMatchObject({ playerId: P1, spins: GAME_CONSTANTS.PACHINKO_SPINS });

    const spun = expectOk(engine.spinPachinko(P1, now + 1));
    const event = spun.find((e) => e.type === 'PACHINKO_SPUN');
    expect(event).toBeDefined();
    if (event?.type !== 'PACHINKO_SPUN') throw new Error('expected a PACHINKO_SPUN event');
    expect(event.reels).toHaveLength(3);
    // A hit ends the Domain's spins; a miss leaves the remaining re-spins for the next pull.
    expect(event.spinsLeft).toBe(event.tier === 'MISS' ? GAME_CONSTANTS.PACHINKO_SPINS - 1 : 0);
    const kinds = playerView(engine.getPublicView(), P1).activeEffects.map((e) => e.kind);
    if (event.tier === 'MISS') expect(kinds).not.toContain(STATUS_KIND.IMMORTAL);
    else expect(kinds).toContain(STATUS_KIND.IMMORTAL);
  });

  describe('Idle Death Gamble payouts', () => {
    /**
     * Replaces the engine's RNG with scripted draws. Each spin consumes a pity roll (0, which
     * never forces a triple at 0 pity) and then one draw per reel, so `symbols` picks each reel.
     */
    function scriptSpins(engine: GameEngine, spins: readonly (readonly number[])[]): void {
      const drawFor = (symbol: number): number =>
        Math.floor(((symbol - 1 + 0.5) / GAME_CONSTANTS.PACHINKO_REELS) * 1_000_000);
      const queue = spins.flatMap((reels) => [0, ...reels.map(drawFor)]);
      (engine as unknown as { rng: { nextUint32(): number } }).rng = { nextUint32: () => queue.shift() ?? 0 };
    }

    function startDomain(): { engine: GameEngine; now: number } {
      const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, p1: 'kinji_hakari' });
      const now = bankTraps(engine, P1, 0, 4, 0);
      expectOk(engine.activateUltimate(P1, now));
      return { engine, now };
    }

    it('three odd digits win a regular jackpot: immortality and CE locked at max', () => {
      const { engine, now } = startDomain();
      scriptSpins(engine, [[3, 3, 3]]);
      const events = expectOk(engine.spinPachinko(P1, now + 1));
      expect(lastEvent(events, 'PACHINKO_SPUN')).toMatchObject({ tier: 'REGULAR', spinsLeft: 0 });
      const view = playerView(engine.getPublicView(), P1);
      const kinds = view.activeEffects.map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining([STATUS_KIND.IMMORTAL, STATUS_KIND.CE_LOCKED]));
      expect(kinds).not.toContain(STATUS_KIND.DAMAGE_BOOST);
      expect(view.pachinko.resetOnExpiry).toBe(false);
    });

    it('7-7-7 is a supreme jackpot: immortality, +50% damage, and a Domain reset on expiry', () => {
      const { engine, now } = startDomain();
      scriptSpins(engine, [[7, 7, 7]]);
      const events = expectOk(engine.spinPachinko(P1, now + 1));
      expect(lastEvent(events, 'PACHINKO_SPUN')).toMatchObject({ tier: 'SUPREME' });
      const view = playerView(engine.getPublicView(), P1);
      const kinds = view.activeEffects.map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining([STATUS_KIND.IMMORTAL, STATUS_KIND.DAMAGE_BOOST]));
      expect(view.pachinko.resetOnExpiry).toBe(true);
    });

    it('three whiffs shatter the Domain, cost 30% max HP, and bank 20% pity', () => {
      const { engine, now } = startDomain();
      const before = playerView(engine.getPublicView(), P1);
      scriptSpins(engine, [
        [1, 2, 3],
        [2, 4, 6],
        [1, 3, 5],
      ]);
      let events: readonly GameEvent[] = [];
      for (let spin = 0; spin < GAME_CONSTANTS.PACHINKO_SPINS; spin++) {
        events = expectOk(engine.spinPachinko(P1, now + 1 + spin));
      }
      expect(lastEvent(events, 'PACHINKO_SPUN')).toMatchObject({
        tier: 'BANKRUPT',
        spinsLeft: 0,
        pity: GAME_CONSTANTS.PACHINKO_PITY_STEP,
      });
      const after = playerView(engine.getPublicView(), P1);
      const backlash = Math.round(before.maxHp * GAME_CONSTANTS.PACHINKO_BANKRUPT_MAX_HP_FRACTION);
      expect(after.hp).toBe(Math.max(1, before.hp - backlash));
      expect(after.activeEffects.map((e) => e.kind)).not.toContain(STATUS_KIND.IMMORTAL);
    });
  });
});

describe('lore synergy pairs', () => {
  const cases: Array<{ pair: [number, number]; id: string; cue: string; caster: CharacterId }> = [
    { pair: [0, 1], id: 'divine_dog_pact', cue: 'CLAW', caster: 'megumi_fushiguro' },
    { pair: [2, 3], id: 'seven_three_blade', cue: 'RATIO', caster: 'kento_nanami' },
    { pair: [4, 5], id: 'six_eyes_vision', cue: 'SIX_EYES', caster: 'satoru_gojo' },
    { pair: [6, 7], id: 'brotherhood_barrage', cue: 'CLASH', caster: 'yuji_itadori' },
  ];

  for (const { pair, id, cue, caster } of cases) {
    it(`fires ${id} with its ${cue} cue`, () => {
      const engine = makeEngine({ layout: synergyLayout(), p1: caster });
      expectOk(engine.flipCard(P1, cardId(engine, P1, pair[0]), 0));
      const events = expectOk(engine.flipCard(P1, cardId(engine, P1, pair[1]), 1));
      expect(lastEvent(events, 'SYNERGY_TRIGGERED')).toMatchObject({ synergyId: id, cue, playerId: P1 });
    });
  }

  it('Divine Dog deals 10 bonus damage and reveals a matching pair', () => {
    const engine = makeEngine({ layout: synergyLayout(), p1: 'megumi_fushiguro' });
    expectOk(engine.flipCard(P1, cardId(engine, P1, 0), 0));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 1), 1));
    // 15 synergy damage plus 10 from the pact.
    expect(eventsOfType(events, 'DAMAGE_DEALT')[0]).toMatchObject({ dealt: 15 });
    expect(eventsOfType(events, 'DAMAGE_DEALT')[1]).toMatchObject({ dealt: 10, cause: 'SYNERGY' });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(75);
    // The pact peeks for 2.0s; only Six Eyes gets the full-field 3.0s window.
    expect(eventsOfType(events, 'CARDS_REVEALED')[0]).toMatchObject({
      revealMs: GAME_PACING.CARD_PEEK_REVEAL_DURATION_MS,
    });
  });

  it('the 7:3 Ratio Blade deals armor-piercing damage', () => {
    const engine = makeEngine({ layout: synergyLayout(), p1: 'kento_nanami' });
    expectOk(engine.flipCard(P1, cardId(engine, P1, 2), 0));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 3), 1));
    const bonus = eventsOfType(events, 'DAMAGE_DEALT')[1];
    expect(bonus).toMatchObject({ dealt: 30, cause: 'SYNERGY' });
  });

  it('Six Eyes reveals the whole grid and hides it again', () => {
    const engine = makeEngine({ layout: synergyLayout(), p1: 'satoru_gojo' });
    expectOk(engine.flipCard(P1, cardId(engine, P1, 4), 0));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 5), 1));
    const revealed = cardIdsOf(events, 'CARDS_REVEALED');
    expect(revealed).toHaveLength(14);
    expect(eventsOfType(events, 'CARDS_REVEALED')[0]).toMatchObject({
      revealMs: GAME_PACING.SKILL_CARD_REVEAL_DURATION_MS,
    });

    expectOk(engine.tick(1 + GAME_PACING.SKILL_CARD_REVEAL_DURATION_MS));
    expect(engine.getPublicView().board.filter((card) => card.state === CARD_STATE.REVEALED)).toHaveLength(0);
  });

  it('Brotherhood Sync refunds 25 CE and widens the Black Flash window', () => {
    const engine = makeEngine({ layout: synergyLayout(), p1: 'yuji_itadori' });
    expectOk(engine.flipCard(P1, cardId(engine, P1, 6), 0));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 7), 1));
    expect(eventsOfType(events, 'CE_CHANGED').some((event) => 'delta' in event && event.delta === 25)).toBe(true);
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(40);

    // The very next match is the first match of the turn, and it already flashes.
    expectOk(engine.tick(1 + GAME_CONSTANTS.MATCH_RESOLVE_MS));
    expectOk(engine.flipCard(P1, cardId(engine, P1, 8), 1000));
    const second = expectOk(engine.flipCard(P1, cardId(engine, P1, 9), 1001));
    expect(lastEvent(second, 'BLACK_FLASH')).toBeDefined();
  });
});

describe('dual board mode', () => {
  it('gives each player an independent grid and lets both act at once', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, mode: BOARD_MODE.DUAL });
    const view = engine.getPublicView();
    expect(view.boardMode).toBe('DUAL');
    expect(view.turnOwner).toBeNull();
    expect(view.turnDeadline).toBeNull();
    expect(view.boards.map((board) => board.boardId)).toEqual([P1, P2]);
    expect(view.boards.every((board) => board.cards.length === 16)).toBe(true);

    // No turn order: both seats open a card on their own grid in the same window.
    expectOk(engine.flipCard(P1, `${P1}:8`, 0));
    expectOk(engine.flipCard(P2, `${P2}:8`, 0));
    const attempts = engine.getPublicView().attempts;
    expect(attempts.find((a) => a.playerId === P1)?.currentSelection).toHaveLength(1);
    expect(attempts.find((a) => a.playerId === P2)?.currentSelection).toHaveLength(1);
  });

  it('sends damage to the opponent HP while each grid resolves its own pairs', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, mode: BOARD_MODE.DUAL, p1: 'sukuna' });
    const now = bankTraps(engine, P1, 0, 2, 0);
    expectOk(engine.flipCard(P1, `${P1}:8`, now + 1));
    expectOk(engine.flipCard(P1, `${P1}:9`, now + 2));

    const view = engine.getPublicView();
    expect(playerView(view, P2).hp).toBe(90);
    const p2Board = boardOfPlayer(view, P2);
    expect(p2Board.every((card) => card.state === CARD_STATE.HIDDEN)).toBe(true);
  });

  it('aims enemy-grid skills at the grid the opponent actually plays on', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, mode: BOARD_MODE.DUAL, p1: 'aoi_todo' });
    const now = bankTraps(engine, P1, 0, 2, 0);
    const before = boardOfPlayer(engine.getPublicView(), P1).map((card) => card.id);
    const events = expectOk(engine.activateSkill(P1, now));

    const swapped = events.find((event) => event.type === 'CARDS_SWAPPED');
    expect(swapped !== undefined && 'boardId' in swapped ? swapped.boardId : null).toBe(P2);
    expect(boardOfPlayer(engine.getPublicView(), P1).map((card) => card.id)).toEqual(before);
  });

  it('rejects a flip from the wrong grid', () => {
    const engine = makeEngine({ layout: trapLayout(8), trapCount: 8, mode: BOARD_MODE.DUAL });
    const wrong = engine.flipCard(P1, `${P2}:8`, 0);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('WRONG_BOARD');
  });
});

describe('turn-based dual boards', () => {
  function expectReject(result: EngineResult, code: string): void {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  }

  const turnBasedDual = { mode: BOARD_MODE.DUAL_TURN_BASED, layout: trapLayout(8), trapCount: 8 } as const;

  it('gives each fighter their own grid and alternates the turn', () => {
    const engine = makeEngine(turnBasedDual);
    const view = engine.getPublicView();
    expect(view.boardMode).toBe('DUAL_TURN_BASED');
    expect(view.boards.map((board) => board.boardId)).toEqual([P1, P2]);
    expect(view.turnOwner).toBe(P1);
    expect(view.turnDeadline).not.toBeNull();

    // Only the fighter on turn may flip, and only on their own grid.
    expectReject(engine.flipCard(P2, `${P2}:8`, 0), 'NOT_YOUR_TURN');
    expectReject(engine.flipCard(P2, `${P1}:8`, 0), 'NOT_YOUR_TURN');
    expectReject(engine.flipCard(P1, `${P2}:8`, 0), 'WRONG_BOARD');
  });

  it('keeps the turn on a match on your own grid and damages the opponent', () => {
    const engine = makeEngine(turnBasedDual);
    expectOk(engine.flipCard(P1, `${P1}:8`, 0));
    const events = expectOk(engine.flipCard(P1, `${P1}:9`, 1));
    expect(lastEvent(events, 'PAIR_MATCHED')).toMatchObject({ playerId: P1 });
    expect(eventsOfType(events, 'DAMAGE_DEALT')[0]).toMatchObject({ dealt: 10, targetId: P2 });

    expectOk(engine.tick(1 + GAME_CONSTANTS.MATCH_RESOLVE_MS));
    const view = engine.getPublicView();
    expect(view.turnOwner).toBe(P1);
    expect(playerView(view, P2).hp).toBe(90);
    // The opponent's grid was never touched.
    expect(boardOfPlayer(view, P2).every((card) => card.state === CARD_STATE.HIDDEN)).toBe(true);
  });

  it('hands the turn over on a mismatch', () => {
    const engine = makeEngine(turnBasedDual);
    const outcome = playMismatch(engine, P1, 8, 10, 0);
    expect(lastEvent(outcome.events, 'TURN_ENDED')).toMatchObject({ playerId: P1, reason: 'MISMATCH' });

    const view = engine.getPublicView();
    expect(view.turnOwner).toBe(P2);
    expect(view.turnNumber).toBe(2);
    expectOk(engine.flipCard(P2, `${P2}:8`, outcome.now + 1));
    expectReject(engine.flipCard(P1, `${P1}:10`, outcome.now + 2), 'NOT_YOUR_TURN');
  });

  it('aims enemy-grid techniques at the grid the opponent will play on', () => {
    const engine = makeEngine({ ...turnBasedDual, p1: 'nobara_kugisaki' });
    let now = bankTraps(engine, P1, 0, 2, 0);

    const events = expectOk(engine.activateSkill(P1, now));
    const modified = cardIdsOf(events, 'CARD_MODIFIED');
    expect(modified).toHaveLength(1);
    expect(modified[0]?.startsWith(`${P2}:`)).toBe(true);
    expect(cardIdsOf(events, 'CARDS_REVEALED')[0]?.startsWith(`${P2}:`)).toBe(true);
    expect(playerView(engine.getPublicView(), P2).hp).toBe(90);

    // Hand the turn over; the nail springs on the opponent during their own turn.
    now = playMismatch(engine, P1, 8, 10, now + 1).now;
    expect(engine.getPublicView().turnOwner).toBe(P2);
    const trigger = expectOk(engine.flipCard(P2, modified[0] as string, now + 1));
    expect(lastEvent(trigger, 'CARD_EFFECT_TRIGGERED')).toMatchObject({ modifier: CARD_EFFECT_KIND.NAILED });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(75);

    const blocked = engine.flipCard(P2, `${P2}:10`, now + 2);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('STUNNED');
  });
});

describe('barriers', () => {
  const dual = { mode: BOARD_MODE.DUAL, layout: trapLayout(8), trapCount: 8 } as const;

  it('a Simple Domain raises a barrier that soaks the next match before HP', () => {
    const engine = makeEngine({ ...dual, p2: 'yuji_itadori' });
    const cast = bankTraps(engine, P2, 0, 4, 0);
    expectOk(engine.activateUltimate(P2, cast));
    const raised = playerView(engine.getPublicView(), P2).shield;
    expect(raised).toBe(GAME_CONSTANTS.SHIELD_GRANT);

    // P1 matches a pair on their own grid: the barrier eats the damage, HP does not move.
    const now = cast + 1;
    expectOk(engine.flipCard(P1, cardId(engine, P1, 8), now));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 9), now + 1));
    expect(eventsOfType(events, 'DAMAGE_DEALT')[0]).toMatchObject({ dealt: 0, absorbed: 10 });

    const view = engine.getPublicView();
    expect(playerView(view, P2).hp).toBe(100);
    expect(playerView(view, P2).shield).toBe(raised - 10);
  });

  it("Kento Nanami's 7:3 Ratio cuts straight through a barrier", () => {
    const engine = makeEngine({ ...dual, p1: 'kento_nanami', p2: 'yuji_itadori' });
    const cast = bankTraps(engine, P2, 0, 4, 0);
    expectOk(engine.activateUltimate(P2, cast));

    const skill = bankTraps(engine, P1, 0, 2, cast + 1);
    expectOk(engine.activateSkill(P1, skill));
    const now = skill + 1;
    expectOk(engine.flipCard(P1, cardId(engine, P1, 8), now));
    const events = expectOk(engine.flipCard(P1, cardId(engine, P1, 9), now + 1));

    // Armor pierce: 25 critical damage lands in full and the barrier is untouched.
    expect(eventsOfType(events, 'DAMAGE_DEALT')[0]).toMatchObject({ dealt: 25, absorbed: 0, critical: true });
    const view = engine.getPublicView();
    expect(playerView(view, P2).hp).toBe(75);
    expect(playerView(view, P2).shield).toBe(GAME_CONSTANTS.SHIELD_GRANT);
  });
});

describe('mode-adaptive statuses', () => {
  it('passes every status through unchanged in the turn-based modes', () => {
    const skip = { status: STATUS_KIND.SKIP_TURNS, value: 2, turns: null } as const;
    for (const mode of [BOARD_MODE.SHARED, BOARD_MODE.DUAL_TURN_BASED]) {
      expect(adaptStatusForMode(skip, mode)).toEqual({ spec: skip, stunMs: 0, note: null });
    }
  });

  it('turns a turn skip into the same amount of real-time lock-out, and drops a turn timer', () => {
    const adapted = adaptStatusForMode({ status: STATUS_KIND.SKIP_TURNS, value: 2, turns: null }, BOARD_MODE.DUAL);
    expect(adapted.spec).toBeNull();
    expect(adapted.stunMs).toBe(2 * GAME_CONSTANTS.SKIP_TURN_MS);
    expect(adapted.note).toContain('lock-out');

    // There is no turn budget to shorten without turn order.
    expect(adaptStatusForMode({ status: STATUS_KIND.SHORT_TIMER, value: 5000, turns: 1 }, BOARD_MODE.DUAL).spec).toBeNull();

    // Mode-agnostic statuses are the same everywhere.
    const crit = { status: STATUS_KIND.CRITICAL_STRIKE, value: GAME_CONSTANTS.CRITICAL_STRIKE_MULTIPLIER, turns: 1 };
    expect(adaptStatusForMode(crit, BOARD_MODE.DUAL)).toEqual({ spec: crit, stunMs: 0, note: null });
  });

  it("Gojo's Unlimited Void locks the enemy out in a real-time dual match", () => {
    const engine = makeEngine({ mode: BOARD_MODE.DUAL, layout: trapLayout(8), trapCount: 8, p1: 'satoru_gojo' });
    const now = bankTraps(engine, P1, 0, 4, 0);
    const events = expectOk(engine.activateUltimate(P1, now));

    expect(events.find((event) => event.type === 'STATUS_ADAPTED')).toMatchObject({ playerId: P2, mode: 'DUAL' });
    expect(events.find((event) => event.type === 'STUNNED')).toMatchObject({ playerId: P2 });

    const view = engine.getPublicView();
    // No turn-based leftover: the lock-out is real time only.
    expect(playerView(view, P2).activeEffects).toHaveLength(0);
    expect(playerView(view, P2).stunnedUntil).toBe(now + GAME_CONSTANTS.SKIP_TURN_MS);

    expectReject(engine.flipCard(P2, cardId(engine, P2, 8), now + 100), 'STUNNED');
    expectOk(engine.flipCard(P2, cardId(engine, P2, 8), now + GAME_CONSTANTS.SKIP_TURN_MS));
  });
});

describe('roster data', () => {
  it('names every skill and ultimate after its character', () => {
    for (const id of Object.keys(CHARACTERS) as CharacterId[]) {
      const character = CHARACTERS[id];
      expect(SKILLS[character.skillId].characterId).toBe(id);
      expect(ULTIMATES[character.ultimateId].characterId).toBe(id);
    }
  });
});
