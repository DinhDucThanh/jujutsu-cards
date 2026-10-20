import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  GAME_CONSTANTS,
  MATCH_END_REASON,
  SHARED_BOARD_ID,
  TurnEngine,
  boardOfPlayer,
  createBoardTemplate,
  createSeededRandom,
  matchKeyOf,
  type CardSpec,
  type CharacterId,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type PublicCardView,
  type PublicMatchView,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';
const cardId = (index: number): string => `${SHARED_BOARD_ID}:${index}`;

/**
 * A real 6x6 deal: 36 cards, traps and a lore pair, built by the same generator the game
 * uses. Eighteen pairs out of a ten fighter roster means the deal *must* repeat characters.
 */
function deal36(seed = 11): CardSpec[] {
  return createBoardTemplate({ size: 36, trapCount: 4, synergyPairCount: 1 }, createSeededRandom(seed));
}

interface EngineOptions {
  readonly layout?: CardSpec[];
  readonly trapCount?: number;
  readonly sandbox?: boolean;
  readonly p1?: CharacterId;
}

function makeEngine(options: EngineOptions = {}): TurnEngine {
  const layout = options.layout ?? deal36();
  const config: MatchConfig = {
    matchId: 'large-board-test',
    boardMode: BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: options.p1 ?? 'satoru_gojo' },
      { id: P2, characterId: 'yuji_itadori' },
    ],
    boardSize: 36,
    trapCount: options.trapCount ?? 4,
    synergyPairCount: 1,
    ...(options.sandbox === true ? { sandbox: true } : {}),
  };
  const engine = new TurnEngine(config, createSeededRandom(3), layout);
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

/** Positions of two STANDARD cards that show the same fighter but come from different pairs. */
function duplicatePositions(layout: readonly CardSpec[]): [number, number] {
  const byCharacter = new Map<CharacterId, Array<{ position: number; pairId: string }>>();
  layout.forEach((spec, position) => {
    if (spec.type !== CARD_TYPE.STANDARD) return;
    const list = byCharacter.get(spec.characterId as CharacterId) ?? [];
    list.push({ position, pairId: spec.pairId });
    byCharacter.set(spec.characterId as CharacterId, list);
  });
  for (const list of byCharacter.values()) {
    const first = list[0];
    const other = list.find((entry) => entry.pairId !== first?.pairId);
    if (first && other) return [first.position, other.position];
  }
  throw new Error('this deal does not repeat a fighter, so it cannot test the duplicate case');
}

/** Positions of two STANDARD cards that show *different* fighters. */
function distinctPairPositions(layout: readonly CardSpec[]): [number, number] {
  const standard = layout
    .map((spec, position) => ({ spec, position }))
    .filter((entry) => entry.spec.type === CARD_TYPE.STANDARD);
  const first = standard[0];
  if (!first) throw new Error('no standard card in the layout');
  const other = standard.find((entry) => entry.spec.characterId !== first.spec.characterId);
  if (!other) throw new Error('every standard card shows the same fighter');
  return [first.position, other.position];
}

describe('6x6 board matching', () => {
  it('deals a repeated roster, which is what broke the old pair-id rule', () => {
    const layout = deal36();
    expect(layout).toHaveLength(36);
    const standard = layout.filter((spec) => spec.type === CARD_TYPE.STANDARD);
    const fighters = new Set(standard.map((spec) => spec.characterId));
    expect(standard).toHaveLength(30);
    // More pairs than fighters: duplicates are unavoidable, not an accident of one seed.
    expect(standard.length / 2).toBeGreaterThan(CHARACTER_IDS.length);
    expect(fighters.size).toBe(CHARACTER_IDS.length);
  });

  it('matches two identical fighters dealt from different pairs', () => {
    const layout = deal36();
    const [first, second] = duplicatePositions(layout);
    expect(layout[first]?.pairId).not.toBe(layout[second]?.pairId);
    expect(layout[first]?.characterId).toBe(layout[second]?.characterId);

    const engine = makeEngine({ layout });
    expectOk(engine.flipCard(P1, cardId(first), 100));
    const events = expectOk(engine.flipCard(P1, cardId(second), 200));

    expect(events.some((event) => event.type === 'PAIR_MATCHED')).toBe(true);
    expect(events.some((event) => event.type === 'PAIR_MISMATCHED')).toBe(false);
    expect(events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({ dealt: 10, targetId: P2 });

    const view = engine.getPublicView();
    expect(view.board[first]?.state).toBe(CARD_STATE.MATCHED);
    expect(view.board[second]?.state).toBe(CARD_STATE.MATCHED);
    expect(playerView(view, P1).pairsMatched).toBe(1);
    // A match keeps the turn; it never passes on a hit.
    expect(view.turnOwner).toBe(P1);
  });

  it('still rejects two different fighters, and a synergy twin of the same fighter', () => {
    const layout = deal36();
    const [first, second] = distinctPairPositions(layout);
    const engine = makeEngine({ layout });

    expectOk(engine.flipCard(P1, cardId(first), 0));
    const mismatch = expectOk(engine.flipCard(P1, cardId(second), 10));
    expect(mismatch.some((event) => event.type === 'PAIR_MISMATCHED')).toBe(true);

    // The deal's lore pair includes a fighter who also has a plain pair on the board
    // (Six Eyes deals a synergy Satoru Gojo beside the standard one): the two look alike
    // and must never complete each other.
    const synergy = layout.find(
      (spec) => spec.type === CARD_TYPE.SYNERGY && (CHARACTER_IDS as readonly string[]).includes(spec.characterId),
    );
    expect(synergy).toBeDefined();
    const synergyIndex = layout.indexOf(synergy as CardSpec);
    const standardTwin = layout.findIndex(
      (spec) => spec.type === CARD_TYPE.STANDARD && spec.characterId === synergy?.characterId,
    );
    expect(standardTwin).toBeGreaterThanOrEqual(0);
    expect(cardId(synergyIndex)).not.toBe(cardId(standardTwin));

    const cross = makeEngine({ layout });
    expectOk(cross.flipCard(P1, cardId(synergyIndex), 0));
    const crossed = expectOk(cross.flipCard(P1, cardId(standardTwin), 10));
    expect(crossed.some((event) => event.type === 'PAIR_MISMATCHED')).toBe(true);
  });

  it('deals a partner for every standard card, so no card is ever stranded', () => {
    const layout = deal36();
    const byKey = new Map<string, number>();
    const byPair = new Map<string, number>();
    for (const spec of layout) {
      if (spec.type !== CARD_TYPE.STANDARD) continue;
      const key = matchKeyOf({ type: spec.type, pairId: spec.pairId, characterId: spec.characterId });
      expect(key).not.toBeNull();
      byKey.set(key as string, (byKey.get(key as string) ?? 0) + 1);
      byPair.set(spec.pairId, (byPair.get(spec.pairId) ?? 0) + 1);
    }
    // Same fighters always come in an even count, so every one of them has a partner.
    for (const [key, count] of byKey) expect([key, count % 2]).toEqual([key, 0]);
    // And a repeated fighter reaches the board as two complete pairs, not an odd spare.
    for (const [, count] of byPair) expect(count).toBe(2);
    expect(byKey.size).toBe(CHARACTER_IDS.length);
  });

  it('plays a repeated board to a knockout without a single false mismatch', () => {
    const layout = deal36();
    const engine = makeEngine({ layout });
    const groups = new Map<string, number[]>();
    layout.forEach((spec, position) => {
      if (spec.type !== CARD_TYPE.STANDARD) return;
      const key = matchKeyOf({ type: spec.type, pairId: spec.pairId, characterId: spec.characterId });
      if (key === null) return;
      groups.set(key, [...(groups.get(key) ?? []), position]);
    });

    let now = 0;
    let matches = 0;
    let blackFlashes = 0;
    for (const positions of groups.values()) {
      for (let i = 0; i + 1 < positions.length && engine.getResult() === null; i += 2) {
        const first = positions[i];
        const second = positions[i + 1];
        if (first === undefined || second === undefined) continue;
        expectOk(engine.flipCard(P1, cardId(first), now));
        // Flips by fighter, never by dealt pair: this is the exact play that used to fail.
        const events = expectOk(engine.flipCard(P1, cardId(second), now + 1));
        expect(events.some((event) => event.type === 'PAIR_MISMATCHED')).toBe(false);
        expect(events.some((event) => event.type === 'PAIR_MATCHED')).toBe(true);
        if (events.some((event) => event.type === 'BLACK_FLASH')) blackFlashes += 1;
        matches += 1;
        now += 1 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
        expectOk(engine.tick(now));
      }
    }

    // A match keeps the turn, so the streak escalates into Kokusen and the escalating
    // damage ends the match well before the grid is exhausted.
    expect(matches).toBeGreaterThanOrEqual(5);
    expect(blackFlashes).toBeGreaterThanOrEqual(1);
    expect(engine.getResult()).toMatchObject({ reason: MATCH_END_REASON.KNOCKOUT, winnerId: P1 });
  });
});

describe('scouting and auto-matching on a repeated roster', () => {
  it('auto-matches pairs that are genuine matches, duplicates included', () => {
    const layout = deal36();
    const engine = makeEngine({ layout, sandbox: true, p1: 'sukuna' });
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 1));
    // Malevolent Shrine resolves two pairs off the caster's own grid.
    const events = expectOk(engine.activateUltimate(P1, 2));

    const matched = events.filter((event) => event.type === 'CARDS_AUTO_MATCHED');
    expect(matched).toHaveLength(2);
    const resolved = boardOfPlayer(engine.getPublicView(), P1).filter((card) => card.state === CARD_STATE.MATCHED);
    expect(resolved.length).toBe(4);
    for (const card of resolved) expect(card.pairId).not.toBeNull();

    // Each auto-matched pair shares a match key: the engine never clears two lookalike
    // cards that a player could not have matched by hand.
    const keys = resolved.map((card) => matchKeyOf(card as unknown as PublicCardView));
    const counts = new Map<string | null, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const [key, count] of counts) expect(key === null ? 0 : count % 2).toBe(0);
    expect(playerView(engine.getPublicView(), P1).activeDomain).toMatchObject({ domainId: 'malevolent_shrine' });
  });

  it('scouts a genuine pair on a repeated roster, not two lookalikes from different pairs', () => {
    const layout = deal36();
    const engine = makeEngine({ layout, sandbox: true, p1: 'aoi_todo' });
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 1));
    // Todo's 120% Potential scouting effect reveals a matching pair, by fighter.
    const events = expectOk(engine.activateUltimate(P1, 2));
    const reveal = events.find((event) => event.type === 'CARDS_REVEALED');
    const revealed = reveal && 'cardIds' in reveal ? [...reveal.cardIds] : [];
    expect(revealed).toHaveLength(2);

    const keys = revealed.map((id) => {
      const card = engine.getPublicView().board.find((candidate) => candidate.id === id);
      expect(card).toBeDefined();
      return card ? matchKeyOf(card) : null;
    });
    expect(keys[0]).not.toBeNull();
    expect(keys[0]).toBe(keys[1]);
  });
});
