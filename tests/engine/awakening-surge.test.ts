import { describe, expect, it } from 'vitest';
import {
  BLESSING,
  BOARD_CLEAR_REWARD,
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  GAME_CONSTANTS,
  GameEngine,
  HP_LIMITS,
  boardClearRewardOf,
  boardOfPlayer,
  createSeededRandom,
  type BoardClearRewardMode,
  type CardSpec,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type PublicMatchView,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';

/** Sixteen standard cards: eight pairs, (2k, 2k+1) sharing one pair id. */
function smallLayout(): CardSpec[] {
  return Array.from({ length: 16 }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: CHARACTER_IDS[Math.floor(i / 2) % CHARACTER_IDS.length] as CardSpec['characterId'],
    trapId: null,
  }));
}

function makeMatch(): GameEngine {
  const config: MatchConfig = {
    matchId: 'awakening-surge-test',
    boardMode: BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: 'yuji_itadori' },
      { id: P2, characterId: 'megumi_fushiguro' },
    ],
    boardSize: 16,
    trapCount: 0,
    synergyPairCount: 0,
    sandbox: true,
    startingHp: HP_LIMITS.MAX,
  };
  const engine = new GameEngine(config, createSeededRandom(11), smallLayout());
  expectOk(engine.start(0));
  return engine;
}

function expectOk(result: EngineResult): readonly GameEvent[] {
  if (!result.ok) throw new Error(`Engine rejected command with ${result.code}`);
  return result.events;
}

function rejectionCode(result: EngineResult): string {
  if (result.ok) throw new Error('expected a rejection');
  return result.code;
}

/** Pair `k` sits at board positions 2k and 2k+1 (hidden cards carry no pair id in the public view). */
function cardIdsOfPair(engine: GameEngine, pair: number): string[] {
  const board = boardOfPlayer(engine.getPublicView(), P1);
  return [board[2 * pair], board[2 * pair + 1]].map((card) => {
    if (!card) throw new Error(`no card for pair ${pair}`);
    return card.id;
  });
}

/** Matches one pair as P1 and resolves it. Returns the engine time once the match settles. */
function matchPair(engine: GameEngine, pair: number, now: number): { now: number; events: GameEvent[] } {
  const [first, second] = cardIdsOfPair(engine, pair);
  if (!first || !second) throw new Error(`no pair ${pair}`);
  const events = [...expectOk(engine.flipCard(P1, first, now))];
  events.push(...expectOk(engine.flipCard(P1, second, now + 1)));
  const settled = now + 1 + GAME_CONSTANTS.MATCH_RESOLVE_MS;
  events.push(...expectOk(engine.tick(settled)));
  return { now: settled, events };
}

/** Matches all eight pairs; the last match clears the board and opens the Awakening Surge. */
function clearBoard(engine: GameEngine): { now: number; events: GameEvent[] } {
  let now = 1000;
  const events: GameEvent[] = [];
  for (let pair = 0; pair < 8; pair++) {
    const step = matchPair(engine, pair, now);
    now = step.now;
    events.push(...step.events);
  }
  return { now, events };
}

describe('Awakening Surge', () => {
  it('opens for the player who cleared the board, and blocks further play', () => {
    const engine = makeMatch();
    const { now, events } = clearBoard(engine);

    const opened = events.find((event) => event.type === 'AWAKENING_OPENED');
    expect(opened).toMatchObject({ type: 'AWAKENING_OPENED', playerId: P1 });

    const view: PublicMatchView = engine.getPublicView();
    expect(view.awakening?.playerId).toBe(P1);

    const blocked = engine.flipCard(P1, cardIdsOfPair(engine, 0)[0] ?? '', now + 10);
    expect(rejectionCode(blocked)).toBe('AWAKENING_IN_PROGRESS');
  });

  it('rejects a blessing from the wrong player', () => {
    const engine = makeMatch();
    const { now } = clearBoard(engine);
    const result = engine.chooseBlessing(P2, BLESSING.SORCERY_RESTORATION, now + 10);
    expect(rejectionCode(result)).toBe('NOT_YOUR_AWAKENING');
  });

  it('Sorcery Restoration grants Barrier and CE, then deals a fresh board', () => {
    const engine = makeMatch();
    const { now } = clearBoard(engine);
    const before = engine.getPublicView().players.find((p) => p.id === P1);
    const beforeCe = before?.cursedEnergy ?? 0;

    const events = expectOk(engine.chooseBlessing(P1, BLESSING.SORCERY_RESTORATION, now + 10));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'AWAKENING_CHOSEN', playerId: P1, blessing: BLESSING.SORCERY_RESTORATION, automatic: false }),
    );

    const view = engine.getPublicView();
    expect(view.awakening).toBeNull();
    // The sandbox clearer starts at the CE cap, so the gain is clamped: CE must hold, not drop.
    const after = view.players.find((p) => p.id === P1);
    expect(after?.cursedEnergy).toBeGreaterThanOrEqual(beforeCe);
    expect(after?.shield).toBeGreaterThan(0);

    const board = boardOfPlayer(view, P1);
    expect(board).toHaveLength(16);
    expect(board.every((card) => card.state === CARD_STATE.HIDDEN)).toBe(true);
  });

  it('Six Eyes Insight reveals two pairs of the new board for the preview window', () => {
    const engine = makeMatch();
    const { now } = clearBoard(engine);

    const events = expectOk(engine.chooseBlessing(P1, BLESSING.SIX_EYES_INSIGHT, now + 10));
    const reveal = events.find((event) => event.type === 'CARDS_REVEALED');
    expect(reveal).toMatchObject({ type: 'CARDS_REVEALED', sourceId: P1, revealMs: GAME_CONSTANTS.SIX_EYES_REVEAL_MS });
    if (!reveal || reveal.type !== 'CARDS_REVEALED') throw new Error('no reveal event');
    expect(reveal.cardIds).toHaveLength(4);

    const board = boardOfPlayer(engine.getPublicView(), P1);
    const revealed = board.filter((card) => card.state === CARD_STATE.REVEALED);
    expect(revealed.map((card) => card.id).sort()).toEqual([...reveal.cardIds].sort());
  });

  it('Latent Black Flash opens the next board without a reveal or a grant event', () => {
    const engine = makeMatch();
    const { now } = clearBoard(engine);

    const events = expectOk(engine.chooseBlessing(P1, BLESSING.LATENT_BLACK_FLASH, now + 10));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'AWAKENING_CHOSEN', blessing: BLESSING.LATENT_BLACK_FLASH }),
    );
    expect(events.some((event) => event.type === 'CARDS_REVEALED')).toBe(false);
    expect(engine.getPublicView().awakening).toBeNull();
  });

  it('forces Sorcery Restoration once the decision window passes', () => {
    const engine = makeMatch();
    const { now, events: clearEvents } = clearBoard(engine);
    const opened = clearEvents.find((event) => event.type === 'AWAKENING_OPENED');
    if (!opened || opened.type !== 'AWAKENING_OPENED') throw new Error('no awakening opened');

    const late = expectOk(engine.tick(opened.decideBy + 1));
    expect(late).toContainEqual(
      expect.objectContaining({
        type: 'AWAKENING_CHOSEN',
        playerId: P1,
        blessing: BLESSING.SORCERY_RESTORATION,
        automatic: true,
      }),
    );
    expect(engine.getPublicView().awakening).toBeNull();
    expect(now).toBeLessThan(opened.decideBy);
  });
});

describe('Board clear reward modes', () => {
  function dualMatch(reward?: BoardClearRewardMode): GameEngine {
    const config: MatchConfig = {
      matchId: 'board-clear-reward-test',
      boardMode: BOARD_MODE.DUAL,
      players: [
        { id: P1, characterId: 'yuji_itadori' },
        { id: P2, characterId: 'megumi_fushiguro' },
      ],
      boardSize: 16,
      trapCount: 0,
      synergyPairCount: 0,
      startingHp: HP_LIMITS.MAX,
      ...(reward ? { boardClearReward: reward } : {}),
    };
    const engine = new GameEngine(config, createSeededRandom(11), smallLayout());
    expectOk(engine.start(0));
    return engine;
  }

  it('defaults simultaneous boards to the instant roll and turn-based boards to the picker', () => {
    expect(boardClearRewardOf({ boardMode: BOARD_MODE.DUAL })).toBe(BOARD_CLEAR_REWARD.RANDOM_AUTO);
    expect(boardClearRewardOf({ boardMode: BOARD_MODE.DUAL_TURN_BASED })).toBe(BOARD_CLEAR_REWARD.MANUAL_CHOICE);
    expect(boardClearRewardOf({ boardMode: BOARD_MODE.SHARED })).toBe(BOARD_CLEAR_REWARD.MANUAL_CHOICE);
  });

  it('instant roll resolves the blessing at once, never opens the picker or pauses', () => {
    const engine = dualMatch(BOARD_CLEAR_REWARD.RANDOM_AUTO);
    const { now, events } = clearBoard(engine);

    expect(events.some((event) => event.type === 'AWAKENING_OPENED')).toBe(false);
    expect(engine.getPublicView().awakening).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'AWAKENING_CHOSEN', playerId: P1, rolled: true, automatic: false }),
    );
    const rolled = events.find((event) => event.type === 'AWAKENING_CHOSEN');
    if (!rolled || rolled.type !== 'AWAKENING_CHOSEN') throw new Error('no blessing rolled');
    expect(Object.values(BLESSING)).toContain(rolled.blessing);

    // The fresh grid is playable straight away: no pending choice blocks the clearer.
    const next = engine.flipCard(P1, cardIdsOfPair(engine, 0)[0] ?? '', now + 10);
    expect(next.ok).toBe(true);
  });

  it('manual choice keeps the pause and the pick on simultaneous boards', () => {
    const engine = dualMatch(BOARD_CLEAR_REWARD.MANUAL_CHOICE);
    const { now, events } = clearBoard(engine);

    expect(events.some((event) => event.type === 'AWAKENING_OPENED')).toBe(true);
    expect(engine.getPublicView().awakening?.playerId).toBe(P1);

    const picked = expectOk(engine.chooseBlessing(P1, BLESSING.SIX_EYES_INSIGHT, now + 10));
    expect(picked).toContainEqual(
      expect.objectContaining({ type: 'AWAKENING_CHOSEN', blessing: BLESSING.SIX_EYES_INSIGHT, rolled: false }),
    );
  });
});
