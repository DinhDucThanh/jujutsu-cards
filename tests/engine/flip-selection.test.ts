import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  GAME_CONSTANTS,
  SHARED_BOARD_ID,
  GameEngine,
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

/** Two unique traps at positions 0 and 1, then standard pairs on (2,3), (4,5), ... */
function trapLayout(trapCount = 2): CardSpec[] {
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

interface Options {
  readonly layout?: CardSpec[];
  readonly trapCount?: number;
  readonly mode?: BoardMode;
  readonly p1?: CharacterId;
}

function makeEngine(options: Options = {}): GameEngine {
  const trapCount = options.trapCount ?? 2;
  const config: MatchConfig = {
    matchId: 'flip-selection-test',
    boardMode: options.mode ?? BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: options.p1 ?? 'satoru_gojo' },
      { id: P2, characterId: 'sukuna' },
    ],
    boardSize: 16,
    trapCount,
    synergyPairCount: 0,
  };
  const engine = new GameEngine(config, createSeededRandom(7), options.layout ?? trapLayout(trapCount));
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

function attemptOf(view: PublicMatchView, id: string) {
  const attempt = view.attempts.find((candidate) => candidate.playerId === id);
  if (!attempt) throw new Error(`missing attempt for ${id}`);
  return attempt;
}

function cardIdsOf(events: readonly GameEvent[]): string[] {
  const event = events.find((candidate) => candidate.type === 'CARDS_REVEALED');
  return event && 'cardIds' in event ? [...event.cardIds] : [];
}

describe('flip selection', () => {
  it('registers a match when a face-down trap was flipped first, in the same turn', () => {
    const engine = makeEngine();
    // Bank the trap, then play the pair behind it without ending the turn.
    expectOk(engine.flipCard(P1, cardId(0), 0));
    expectOk(engine.flipCard(P1, cardId(2), 1));
    const events = expectOk(engine.flipCard(P1, cardId(3), 2));

    expect(events.find((event) => event.type === 'PAIR_MATCHED')).toMatchObject({ playerId: P1, pairId: 'pair-0' });
    expect(events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({ dealt: 10, targetId: P2 });
    expect(playerView(engine.getPublicView(), P2).hp).toBe(90);
  });

  it('registers a match when a trap sits between the two flipped cards', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(2), 0));
    // The trap is a detour: it banks CE, resolves instantly and must not join the selection.
    const trapEvents = expectOk(engine.flipCard(P1, cardId(1), 1));
    expect(trapEvents.find((event) => event.type === 'TRAP_TRIGGERED')).toMatchObject({ playerId: P1 });
    expect(attemptOf(engine.getPublicView(), P1).currentSelection).toEqual([cardId(2)]);

    const events = expectOk(engine.flipCard(P1, cardId(3), 2));
    expect(events.some((event) => event.type === 'PAIR_MATCHED')).toBe(true);
  });

  it('never lets an exhausted, face-up trap pollute a later attempt', () => {
    const engine = makeEngine();
    // Two traps used up and left face-up on the grid, then a real pair.
    expectOk(engine.flipCard(P1, cardId(0), 0));
    expectOk(engine.flipCard(P1, cardId(1), 1));
    expectOk(engine.flipCard(P1, cardId(4), 2));
    const events = expectOk(engine.flipCard(P1, cardId(5), 3));

    expect(events.some((event) => event.type === 'PAIR_MATCHED')).toBe(true);
    const view = engine.getPublicView();
    // The two used traps really are still face up on the board, and never in the selection.
    expect(view.board[0]?.state).toBe(CARD_STATE.MATCHED);
    expect(view.board[1]?.state).toBe(CARD_STATE.MATCHED);
    const attempt = attemptOf(view, P1);
    expect(attempt.phase).toBe('EVALUATING');
    expect(attempt.currentSelection).toEqual([cardId(4), cardId(5)]);
    expect(attempt.currentSelection).not.toContain(cardId(0));

    // Once the match window closes the selection is empty again.
    expectOk(engine.tick(3 + GAME_CONSTANTS.MATCH_RESOLVE_MS));
    expect(attemptOf(engine.getPublicView(), P1).currentSelection).toEqual([]);
  });

  it('keeps the selection explicit, capped by the flip limit, and empty once resolved', () => {
    const engine = makeEngine();
    expect(attemptOf(engine.getPublicView(), P1).currentSelection).toEqual([]);
    expect(attemptOf(engine.getPublicView(), P1).phase).toBe('IDLE');

    expectOk(engine.flipCard(P1, cardId(2), 0));
    let attempt = attemptOf(engine.getPublicView(), P1);
    expect(attempt.currentSelection).toEqual([cardId(2)]);
    expect(attempt.phase).toBe('FLIPPED_FIRST');
    expect(attempt.isEvaluating).toBe(false);

    expectOk(engine.flipCard(P1, cardId(4), 1));
    attempt = attemptOf(engine.getPublicView(), P1);
    expect(attempt.currentSelection).toHaveLength(2);
    expect(attempt.currentSelection.length).toBeLessThanOrEqual(attempt.flipLimit);
    expect(attempt.phase).toBe('EVALUATING');
    expect(attempt.isEvaluating).toBe(true);

    // The window closes on the clock and the selection is released.
    expectOk(engine.tick(1 + GAME_CONSTANTS.MISMATCH_REVEAL_MS));
    expect(attemptOf(engine.getPublicView(), P1).currentSelection).toEqual([]);
    expect(attemptOf(engine.getPublicView(), P1).isEvaluating).toBe(false);
  });

  it('always leaves the evaluating phase once the window closes, on both outcomes', () => {
    const matchEngine = makeEngine();
    expectOk(matchEngine.flipCard(P1, cardId(2), 0));
    expectOk(matchEngine.flipCard(P1, cardId(3), 1));
    expect(matchEngine.getPublicView().phase).toBe('EVALUATING');
    expectOk(matchEngine.tick(1 + GAME_CONSTANTS.MATCH_RESOLVE_MS));
    expect(matchEngine.getPublicView().phase).toBe('WAITING_FOR_P1');
    expectOk(matchEngine.flipCard(P1, cardId(4), 2 + GAME_CONSTANTS.MATCH_RESOLVE_MS));

    const mismatchEngine = makeEngine();
    expectOk(mismatchEngine.flipCard(P1, cardId(2), 0));
    expectOk(mismatchEngine.flipCard(P1, cardId(4), 1));
    expect(mismatchEngine.getPublicView().phase).toBe('EVALUATING');
    expectOk(mismatchEngine.tick(1 + GAME_CONSTANTS.MISMATCH_REVEAL_MS));
    expect(mismatchEngine.getPublicView().phase).toBe('WAITING_FOR_P2');
    expectOk(mismatchEngine.flipCard(P2, cardId(6), 2 + GAME_CONSTANTS.MISMATCH_REVEAL_MS));
  });

  it('never lets a scouting reveal join the selection, and never hides an open flip early', () => {
    const engine = makeEngine({ p1: 'megumi_fushiguro' });
    // Two traps bank 60 CE, which is what Nue costs.
    expectOk(engine.flipCard(P1, cardId(0), 0));
    expectOk(engine.flipCard(P1, cardId(1), 1));
    const revealed = cardIdsOf(expectOk(engine.activateSkill(P1, 2)));
    expect(revealed).toHaveLength(2);

    // A scouted card cannot be flipped, so it can never enter the selection.
    const blocked = engine.flipCard(P1, revealed[0] as string, 3);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('CARD_UNAVAILABLE');
    expect(attemptOf(engine.getPublicView(), P1).currentSelection).toEqual([]);

    // Open a card of our own, then let the scouting window close.
    const openPosition = [2, 4, 6].find((position) => !revealed.includes(cardId(position)));
    if (openPosition === undefined) throw new Error('no free card to open');
    expectOk(engine.flipCard(P1, cardId(openPosition), 4));
    expectOk(engine.tick(5 + GAME_CONSTANTS.MISMATCH_REVEAL_MS * 4));

    const view = engine.getPublicView();
    expect(view.board.filter((card) => revealed.includes(card.id)).every((card) => card.state === CARD_STATE.HIDDEN)).toBe(
      true,
    );
    // The clock does not release the player's own open flip: only a resolution or a timeout does.
    expect(view.board[openPosition]?.state).toBe(CARD_STATE.REVEALED);
    expect(attemptOf(view, P1).currentSelection).toEqual([cardId(openPosition)]);
    expect(attemptOf(view, P1).phase).toBe('FLIPPED_FIRST');
  });
});
