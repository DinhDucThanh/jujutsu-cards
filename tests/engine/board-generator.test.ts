import { describe, expect, it } from 'vitest';
import {
  BLESSING,
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  SHARED_BOARD_ID,
  TurnEngine,
  boardOfPlayer,
  createCryptoRandom,
  createSeededRandom,
  generateBoardAvoiding,
  generateIndependentBoard,
  generateIndependentBoards,
  layoutSignature,
  mixSignature,
  type Card,
  type CardSpec,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type RandomSource,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';

function config(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    matchId: 'dual-deal-test',
    boardMode: BOARD_MODE.DUAL,
    players: [
      { id: P1, characterId: 'satoru_gojo' },
      { id: P2, characterId: 'sukuna' },
    ],
    boardSize: 16,
    trapCount: 2,
    synergyPairCount: 1,
    ...overrides,
  };
}

/** Sixteen standard cards in eight pairs: positions (0,1), (2,3), ... match. */
function fixtureLayout(): CardSpec[] {
  return Array.from({ length: 16 }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: CHARACTER_IDS[Math.floor(i / 2) % CHARACTER_IDS.length]!,
    trapId: null,
  }));
}

/** The pairs a deal carries, counted across its cards. */
function pairCounts(cards: readonly { pairId: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.pairId, (counts.get(card.pairId) ?? 0) + 1);
  return counts;
}

function expectOk(result: EngineResult): readonly GameEvent[] {
  if (!result.ok) throw new Error(`engine rejected with ${result.code}`);
  return result.events;
}

/** A started match, since commands are refused before `start` (NOT_STARTED). */
function makeEngine(
  overrides: Partial<MatchConfig> = {},
  rng: RandomSource = createSeededRandom(1),
  layout?: readonly CardSpec[],
): TurnEngine {
  const engine = new TurnEngine(config(overrides), rng, layout);
  expectOk(engine.start(0));
  return engine;
}

/** What a player can see of their own grid while the cards are face down. */
function publicBoard(engine: TurnEngine, playerId: string): readonly { pairId: string | null; state: string }[] {
  return boardOfPlayer(engine.getPublicView(), playerId);
}

/**
 * Reveals one grid pair by pair and returns the pair sitting at every position, in order.
 *
 * Identity is only observable once a card is face up — a hidden card reports a null pair to
 * clients, by design — so the only way to compare two deals from outside the engine is to
 * play them. A pair that is not actually a pair reports nulls, which is exactly what makes
 * this a valid "these two grids are not the same deal" check.
 */
function revealWholeBoard(engine: TurnEngine, playerId: string, now: number): { pairs: (string | null)[]; advanced: number } {
  const pairs: (string | null)[] = [];
  let clock = now;
  for (let position = 0; position < 16; position += 2) {
    const view = engine.getPublicView();
    const ids = boardOfPlayer(view, playerId)
      .filter((card) => card.position === position || card.position === position + 1)
      .map((card) => card.id);
    for (const id of ids) {
      clock += 1;
      engine.flipCard(playerId, id, clock);
    }
    // Past the evaluation window, so the next attempt is accepted.
    clock += 4_000;
    engine.tick(clock);
    // A cleared grid is only re-dealt once its clearer picks a blessing.
    if (engine.getPublicView().awakening !== null) {
      expectOk(engine.chooseBlessing(playerId, BLESSING.LATENT_BLACK_FLASH, clock));
    }
    const revealed = engine.getPublicView();
    const board = boardOfPlayer(revealed, playerId);
    pairs.push(board[position]?.pairId ?? null);
  }
  return { pairs, advanced: clock };
}

describe('generateIndependentBoard', () => {
  it('deals a full board of hidden cards with unique ids carrying the owner prefix', () => {
    const cards = generateIndependentBoard(16, 2, P1, { synergyPairCount: 1, rng: createSeededRandom(1) });

    expect(cards).toHaveLength(16);
    expect(new Set(cards.map((card) => card.id)).size).toBe(16);
    expect(cards.every((card) => card.id.startsWith(`${P1}:`))).toBe(true);
    expect(cards.every((card) => card.state === CARD_STATE.HIDDEN)).toBe(true);
    expect(cards.every((card) => card.revealedBy === null && card.effectModifiers.length === 0)).toBe(true);

    expect(cards.filter((card) => card.type === CARD_TYPE.TRAP)).toHaveLength(2);
    for (const [pairId, count] of pairCounts(cards)) {
      expect(count).toBe(pairId.startsWith('trap:') ? 1 : 2);
    }
  });

  it('deals a different arrangement on every call, with a different mix when the pool allows it', () => {
    // One source, advanced across calls: exactly how the two grids of a match are dealt.
    const rng = createSeededRandom(99);
    const first = generateIndependentBoard(16, 0, P1, { rng });
    const second = generateIndependentBoard(16, 0, P2, { rng });

    expect(layoutSignature(first)).not.toBe(layoutSignature(second));
    expect(mixSignature(first)).not.toBe(mixSignature(second));
    // No card object is shared either: two grids are separate state, not two views of one.
    expect(first.some((card) => second.includes(card))).toBe(false);
    expect(new Set([...first, ...second].map((card) => card.id)).size).toBe(32);
  });

  it('is reproducible from a seed, so replays and seeded tests stay deterministic', () => {
    const deal = (): Card[] => generateIndependentBoard(16, 2, P2, { rng: createSeededRandom(7) });
    expect(layoutSignature(deal())).toBe(layoutSignature(deal()));
  });

  it('accepts the platform CSPRNG without ever repeating a deal', () => {
    const rng: RandomSource = createCryptoRandom();
    const signatures = new Set<string>();
    for (let i = 0; i < 12; i += 1) signatures.add(layoutSignature(generateIndependentBoard(16, 0, P1, { rng })));
    expect(signatures.size).toBe(12);
  });

  it('refuses a trap count that cannot leave whole pairs, and an unsupported size', () => {
    expect(() => generateIndependentBoard(16, 1, P1)).toThrow(RangeError);
    expect(() => generateIndependentBoard(16, -1, P1)).toThrow(RangeError);
    expect(() => generateIndependentBoard(10 as 16, 0, P1)).toThrow(RangeError);
  });
});

describe('generateIndependentBoards', () => {
  it('deals both grids with distinct arrangements and distinct mixes', () => {
    // 4x4 draws eight of eleven fighters, so a repeated mix is the collision that matters.
    for (let seed = 1; seed <= 60; seed += 1) {
      const boards = generateIndependentBoards([P1, P2], {
        size: 16,
        trapCount: 0,
        synergyPairCount: 0,
        rng: createSeededRandom(seed),
      });
      const first = boards.get(P1)!;
      const second = boards.get(P2)!;

      expect(layoutSignature(first), `seed ${seed} arrangement`).not.toBe(layoutSignature(second));
      expect(mixSignature(first), `seed ${seed} mix`).not.toBe(mixSignature(second));
      expect(first.some((card) => second.includes(card)), `seed ${seed} shared cards`).toBe(false);
      expect(new Set([...first, ...second].map((card) => card.id)).size).toBe(32);
    }
  });

  it('still gives each grid its own arrangement when every fighter has to be reused', () => {
    // A 6x6 grid needs 18 pairs from 10 fighters, so the mix repeats by force; the deals
    // must still be independent, which is what stops one grid being a read of the other.
    for (let seed = 1; seed <= 20; seed += 1) {
      const boards = generateIndependentBoards([P1, P2], {
        size: 36,
        trapCount: 4,
        synergyPairCount: 0,
        rng: createSeededRandom(seed),
      });
      const first = boards.get(P1)!;
      const second = boards.get(P2)!;

      expect(first).toHaveLength(36);
      expect(layoutSignature(first), `seed ${seed}`).not.toBe(layoutSignature(second));
      expect(first.some((card) => second.includes(card))).toBe(false);
    }
  });

  it('carries the match synergy setting into both deals', () => {
    const boards = generateIndependentBoards([P1, P2], {
      size: 16,
      trapCount: 0,
      synergyPairCount: 2,
      rng: createSeededRandom(5),
    });
    for (const cards of boards.values()) {
      expect(cards.filter((card) => card.type === CARD_TYPE.SYNERGY)).toHaveLength(4);
    }
  });
});

describe('generateBoardAvoiding', () => {
  it('never repeats an arrangement or a mix of the board it is steered away from', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rng = createSeededRandom(seed);
      const other = generateIndependentBoard(16, 0, P1, { rng });
      const fresh = generateBoardAvoiding(P2, {
        size: 16,
        trapCount: 0,
        synergyPairCount: 0,
        rng,
        avoid: [other],
      });

      expect(layoutSignature(fresh), `seed ${seed} arrangement`).not.toBe(layoutSignature(other));
      expect(mixSignature(fresh), `seed ${seed} mix`).not.toBe(mixSignature(other));
    }
  });

  it('keeps dealing when the grid it avoids used every fighter', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rng = createSeededRandom(seed);
      const other = generateIndependentBoard(36, 0, P1, { rng });
      const fresh = generateBoardAvoiding(P2, { size: 36, trapCount: 0, rng, avoid: [other] });

      expect(fresh).toHaveLength(36);
      expect(layoutSignature(fresh), `seed ${seed}`).not.toBe(layoutSignature(other));
      expect(fresh.some((card) => other.includes(card))).toBe(false);
    }
  });

  it('deals exactly like the plain generator when there is nothing to avoid', () => {
    const cards = generateBoardAvoiding(P1, { size: 16, trapCount: 2, rng: createSeededRandom(4) });
    expect(cards).toHaveLength(16);
    expect(cards.filter((card) => card.type === CARD_TYPE.TRAP)).toHaveLength(2);
  });
});

describe('GameEngine dual boards', () => {
  it('keeps identity out of the public view while the grids are face down', () => {
    // This is why the deal comparison below has to be played out rather than read.
    const engine = makeEngine();
    expect(publicBoard(engine, P1).every((card) => card.pairId === null)).toBe(true);
    expect(publicBoard(engine, P2).every((card) => card.pairId === null)).toBe(true);
  });

  it('deals each grid independently on a random deal', () => {
    let identical = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const engine = makeEngine({ trapCount: 0, synergyPairCount: 0 }, createSeededRandom(seed));
      const first = boardOfPlayer(engine.getPublicView(), P1)[0]!.id;
      const second = boardOfPlayer(engine.getPublicView(), P2)[0]!.id;

      expectOk(engine.flipCard(P1, first, 100));
      expectOk(engine.flipCard(P2, second, 110));

      const pairAt = (playerId: string, position: number): string | null =>
        boardOfPlayer(engine.getPublicView(), playerId)[position]?.pairId ?? null;
      // Two independent deals can still put the same pair in the same slot by chance —
      // roughly one seed in eight here. A mirrored deal would match on every single seed.
      if (pairAt(P1, 0) === pairAt(P2, 0)) identical += 1;
    }
    expect(identical).toBeLessThanOrEqual(3);
  });

  it('stays mirrored for an explicit layout, which is a fixture and not a random deal', () => {
    const engine = makeEngine({ trapCount: 0, synergyPairCount: 0 }, createSeededRandom(3), fixtureLayout());
    const first = boardOfPlayer(engine.getPublicView(), P1)[0]!.id;
    const second = boardOfPlayer(engine.getPublicView(), P2)[0]!.id;

    expectOk(engine.flipCard(P1, first, 100));
    expectOk(engine.flipCard(P2, second, 110));

    const pairAt = (playerId: string, position: number): string | null =>
      boardOfPlayer(engine.getPublicView(), playerId)[position]?.pairId ?? null;
    expect(pairAt(P1, 0)).not.toBeNull();
    expect(pairAt(P2, 0)).toBe(pairAt(P1, 0));
  });

  it('keeps a shared-board match on one grid', () => {
    const engine = makeEngine({ boardMode: BOARD_MODE.SHARED }, createSeededRandom(3));
    expect(engine.getPublicView().boards.map((board) => board.boardId)).toEqual([SHARED_BOARD_ID]);
  });

  it('draws a different roster sample per grid', () => {
    const boards = generateIndependentBoards([P1, P2], {
      size: 16,
      trapCount: 0,
      synergyPairCount: 0,
      rng: createSeededRandom(11),
    });
    const fighters = (cards: readonly Card[]): string[] =>
      [...new Set(cards.map((card) => card.characterId))].sort();
    const first = fighters(boards.get(P1)!);
    const second = fighters(boards.get(P2)!);

    expect(first).toHaveLength(8);
    expect(second).toHaveLength(8);
    expect(first.join(',')).not.toBe(second.join(','));
  });
});

describe('respawned grids', () => {
  it('re-deals a cleared grid as a fresh, non-mirrored deal', () => {
    // A fixture keeps the board clearable position by position, so the test can play the
    // grid out and then check that what comes back is a new deal rather than the old one.
    const engine = makeEngine(
      { trapCount: 0, synergyPairCount: 0, startingHp: 400 },
      createSeededRandom(21),
      fixtureLayout(),
    );
    // The fixture is known, so playing it out must reproduce it pair for pair — except
    // the last slot, which by then already belongs to the freshly dealt grid.
    const fixturePairs = Array.from({ length: 8 }, (_, pair) => `pair-${pair}`);
    const { pairs } = revealWholeBoard(engine, P1, 0);

    expect(pairs.slice(0, 7)).toEqual(fixturePairs.slice(0, 7));
    expect(pairs[7]).toBeNull();
    expect(publicBoard(engine, P1).every((card) => card.state === CARD_STATE.HIDDEN)).toBe(true);

    // The fresh deal is dealt from new entropy, so it cannot reproduce the fixture grid.
    const fresh = revealWholeBoard(engine, P1, 100_000).pairs;
    expect(fresh.join('|')).not.toBe(fixturePairs.join('|'));
  });

  it('announces the clear and the re-deal', () => {
    const engine = makeEngine(
      { trapCount: 0, synergyPairCount: 0, startingHp: 400 },
      createSeededRandom(21),
      fixtureLayout(),
    );
    const seen: string[] = [];
    const collect = (result: EngineResult): void => {
      for (const event of result.events) if (event.type.startsWith('BOARD_')) seen.push(event.type);
    };
    let clock = 0;
    for (let position = 0; position < 16; position += 2) {
      const ids = boardOfPlayer(engine.getPublicView(), P1)
        .filter((card) => card.position === position || card.position === position + 1)
        .map((card) => card.id);
      for (const id of ids) {
        clock += 1;
        collect(engine.flipCard(P1, id, clock));
      }
      clock += 4_000;
      collect(engine.tick(clock));
    }
    collect(engine.chooseBlessing(P1, BLESSING.LATENT_BLACK_FLASH, clock));

    expect(seen).toContain('BOARD_CLEARED');
    expect(seen).toContain('BOARD_RESPAWNED');
  });
});
