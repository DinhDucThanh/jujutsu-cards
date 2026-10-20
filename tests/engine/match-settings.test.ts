import { describe, expect, it } from 'vitest';
import {
  BLESSING,
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  GAME_CONSTANTS,
  HP_LIMITS,
  SHARED_BOARD_ID,
  STATUS_KIND,
  GameEngine,
  createSeededRandom,
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

/** Eight standard pairs, on (0,1), (2,3), ..., preceded by `trapCount` unique traps. */
function layout(trapCount = 0): CardSpec[] {
  const traps: CardSpec[] = Array.from({ length: trapCount }, (_, i) => ({
    pairId: `trap:sukuna_finger:${i}`,
    type: CARD_TYPE.TRAP,
    characterId: 'sukuna' as const,
    trapId: 'sukuna_finger' as const,
  }));
  // A distinct fighter per pair, as a real deal gives: matching is by fighter, so
  // identical neighbours would match on every flip.
  const pairs: CardSpec[] = Array.from({ length: 16 - trapCount }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: CHARACTER_IDS[Math.floor(i / 2) % CHARACTER_IDS.length] as CardSpec['characterId'],
    trapId: null,
  }));
  return [...traps, ...pairs];
}

function config(startingHp: number | undefined, p1: CharacterId = 'satoru_gojo', trapCount = 0): MatchConfig {
  return {
    matchId: 'settings-test',
    boardMode: BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: p1 },
      { id: P2, characterId: 'sukuna' },
    ],
    boardSize: 16,
    trapCount,
    synergyPairCount: 0,
    ...(startingHp === undefined ? {} : { startingHp }),
  };
}

function makeEngine(startingHp: number | undefined, p1: CharacterId = 'satoru_gojo', trapCount = 0): GameEngine {
  const engine = new GameEngine(config(startingHp, p1, trapCount), createSeededRandom(1), layout(trapCount));
  const started = engine.start(0);
  if (!started.ok) throw new Error(`start rejected with ${started.code}`);
  return engine;
}

function expectOk(result: EngineResult): readonly GameEvent[] {
  if (!result.ok) throw new Error(`Engine rejected command with ${result.code}`);
  return result.events;
}

function playerView(view: PublicMatchView, id: string) {
  const player = view.players.find((candidate) => candidate.id === id);
  if (!player) throw new Error(`missing player ${id}`);
  return player;
}

/** Flips a matching pair for `playerId` and waits out the evaluation window. */
function playMatch(engine: GameEngine, playerId: string, a: number, b: number, now: number): number {
  expectOk(engine.flipCard(playerId, cardId(a), now));
  expectOk(engine.flipCard(playerId, cardId(b), now + 1));
  const resolved = now + 1 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
  expectOk(engine.tick(resolved));
  return resolved;
}

describe('configurable starting HP', () => {
  it('starts both fighters at the configured pool', () => {
    const engine = makeEngine(300);
    const view = engine.getPublicView();
    expect(playerView(view, P1).maxHp).toBe(300);
    expect(playerView(view, P1).hp).toBe(300);
    expect(playerView(view, P2).hp).toBe(300);
    expect(playerView(view, P2).maxHp).toBe(300);

    const now = playMatch(engine, P1, 0, 1, 0);
    const after = engine.getPublicView();
    expect(playerView(after, P2).hp).toBe(290);
    expect(playerView(after, P2).maxHp).toBe(300);
    expect(now).toBeGreaterThan(0);
  });

  it('defaults to the standard pool when the match does not set one', () => {
    const view = makeEngine(undefined).getPublicView();
    expect(playerView(view, P1).maxHp).toBe(GAME_CONSTANTS.MAX_HP);
    expect(playerView(view, P1).maxHp).toBe(HP_LIMITS.DEFAULT);
  });

  it('accepts the bounds of the allowed range', () => {
    expect(playerView(makeEngine(HP_LIMITS.MIN).getPublicView(), P1).hp).toBe(HP_LIMITS.MIN);
    expect(playerView(makeEngine(HP_LIMITS.MAX).getPublicView(), P1).hp).toBe(HP_LIMITS.MAX);
  });

  it('rejects a pool below the minimum, above the maximum, or fractional', () => {
    expect(() => makeEngine(HP_LIMITS.MIN - 1)).toThrow(/startingHp/);
    expect(() => makeEngine(HP_LIMITS.MAX + 1)).toThrow(/startingHp/);
    expect(() => makeEngine(250.5)).toThrow(/startingHp/);
  });

  it('knocks a fighter out at the configured pool rather than the default', () => {
    // 50 HP: 10 + 25 + 25 damage ends the match on the third pair.
    const engine = makeEngine(HP_LIMITS.MIN);
    let now = playMatch(engine, P1, 0, 1, 0);
    now = playMatch(engine, P1, 2, 3, now + 1);
    now = playMatch(engine, P1, 4, 5, now + 1);

    expect(engine.getResult()).toMatchObject({ winnerId: P1, reason: 'KNOCKOUT' });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(0);
  });

  it('applies a permanent max-HP reduction to the configured pool', () => {
    const engine = makeEngine(400, 'mahito', 8);
    // Four traps bank 30 CE each, capped at 100.
    for (let i = 0; i < 4; i++) expectOk(engine.flipCard(P1, cardId(i), i));
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
    expectOk(engine.activateUltimate(P1, 5));

    const p2 = playerView(engine.getPublicView(), P2);
    expect(p2.maxHp).toBe(300);
    expect(p2.hp).toBe(300);
    expect(p2.activeEffects.map((effect) => effect.kind)).toContain(STATUS_KIND.MAX_HP_REDUCTION);
  });

  it('never heals above the configured pool', () => {
    // Nanami's ultimate heals 15; a fighter already at 400 must stay at 400 (a
    // hard-coded 100 cap would drag them down to 100 instead).
    const engine = makeEngine(400, 'kento_nanami', 8);
    for (let i = 0; i < 4; i++) expectOk(engine.flipCard(P1, cardId(i), i));
    const events = expectOk(engine.activateUltimate(P1, 5));

    expect(events.filter((event) => event.type === 'HEALED')).toHaveLength(0);
    expect(playerView(engine.getPublicView(), P1).hp).toBe(400);
    expect(playerView(engine.getPublicView(), P1).maxHp).toBe(400);
    // The resolved pair and the flat 20 still land on the opponent.
    expect(playerView(engine.getPublicView(), P2).hp).toBeLessThan(400);
  });

  it('keeps the cleared-grid reshuffle working on a large pool', () => {
    const engine = makeEngine(1000);
    let now = 0;
    for (const [a, b] of [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [8, 9],
      [10, 11],
      [12, 13],
      [14, 15],
    ] as const) {
      now = playMatch(engine, P1, a, b, now + 1);
    }

    // The cleared grid is re-dealt once the clearer picks a blessing.
    expect(engine.chooseBlessing(P1, BLESSING.LATENT_BLACK_FLASH, now + 1).ok).toBe(true);
    expect(engine.getResult()).toBeNull();
    // 10 + seven Black Flashes of 25 on a 1000 pool: nowhere near a knockout.
    expect(playerView(engine.getPublicView(), P2).hp).toBe(1000 - 185);
    expect(engine.getPublicView().board.every((card) => card.state === CARD_STATE.HIDDEN)).toBe(true);
  });
});
