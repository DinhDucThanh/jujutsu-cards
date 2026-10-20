import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_ESCAPE_CHANCE,
  AI_ESCAPE_DELAY_MS,
  AI_PICK_DELAY_MS,
  AiController,
  engineHost,
  startAiDriver,
} from '../../src/ai/ai-controller.js';
import { AI_GRADE_PROFILES, type AiGradeProfile } from '../../src/ai/difficulty.js';
import { CardMemory, MEMORY_DECAY_PER_TURN } from '../../src/ai/card-memory.js';
import {
  BOARD_MODE,
  CARD_TYPE,
  CHARACTER_IDS,
  COURTROOM_PHASE,
  GAME_CONSTANTS,
  GameEngine,
  HP_LIMITS,
  SHARED_BOARD_ID,
  TurnEngine,
  boardOfPlayer,
  calculateTurnDuration,
  createSeededRandom,
  randomInt,
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

/** The fighter shown by fixture pair `pair`: distinct per pair while the roster lasts. */
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

function makeEngine(layout: CardSpec[], trapCount = 0, boardMode: BoardMode = BOARD_MODE.SHARED): TurnEngine {
  const config: MatchConfig = {
    matchId: 'ai-test',
    boardMode,
    players: [
      { id: P1, characterId: 'kento_nanami' },
      { id: P2, characterId: 'sukuna' },
    ],
    boardSize: 16,
    trapCount,
    synergyPairCount: 0,
  };
  const engine = new TurnEngine(config, createSeededRandom(1), layout);
  const started = engine.start(0);
  if (!started.ok) throw new Error(`start failed: ${started.code}`);
  return engine;
}

/** Runs an engine command and feeds the AI memory with the resulting public view. */
function step(engine: TurnEngine, controller: AiController, command: () => EngineResult): void {
  const result = command();
  if (!result.ok) throw new Error(`engine rejected command with ${result.code}`);
  controller.observe(engine.getPublicView());
}

/** A profile with perfect memory and no blind guesses, for deterministic memory tests. */
function perfect(overrides: Partial<AiGradeProfile> = {}): AiGradeProfile {
  return { ...AI_GRADE_PROFILES.SPECIAL, memoryRetention: 1, blindGuessRate: 0, ...overrides };
}

function indexOf(id: string): number {
  return Number(id.split(':')[1]);
}

describe('card memory', () => {
  it('never remembers when retention is zero', () => {
    const engine = makeEngine(standardLayout());
    const memory = new CardMemory(0, createSeededRandom(1));
    engine.flipCard(P1, cardId(0), 0);
    engine.flipCard(P1, cardId(2), 10);
    memory.observe(engine.getPublicView());
    expect(memory.size()).toBe(0);
  });

  it('remembers face-up cards with full retention and forgets them after enough turns', () => {
    const engine = makeEngine(standardLayout());
    const memory = new CardMemory(1, createSeededRandom(1));
    engine.flipCard(P1, cardId(0), 0);
    engine.flipCard(P1, cardId(2), 10);
    memory.observe(engine.getPublicView());
    expect(memory.isKnown(cardId(0))).toBe(true);
    // Memory keys a standard card by the fighter it shows, not by its dealt pair: on a
    // repeated roster those are different, and only the fighter decides a match.
    expect(memory.get(cardId(2))?.matchKey).toBe(`std:${pairCharacter(1)}`);

    // Each turn change decays confidence; below MEMORY_FORGET_BELOW the entries are dropped.
    let now = 0;
    for (let turn = 0; turn < 12; turn++) {
      // One turn change per iteration: advance past whatever budget that turn has.
      now += calculateTurnDuration(engine.getPublicView().turnNumber) + 1;
      engine.tick(now);
      memory.observe(engine.getPublicView());
    }
    expect(memory.size()).toBe(0);
    expect(MEMORY_DECAY_PER_TURN).toBeLessThan(1);
  });

  it('never remembers a pair that was matched, since matched cards are not face-down', () => {
    const engine = makeEngine(standardLayout());
    const memory = new CardMemory(1, createSeededRandom(1));
    engine.flipCard(P1, cardId(0), 0);
    engine.flipCard(P1, cardId(1), 10);
    memory.observe(engine.getPublicView());
    expect(memory.size()).toBe(0);
  });
});

describe('AI decisions', () => {
  /** Clock helper: advances past the current reveal window so the next attempt is legal. */
  function clock() {
    let now = 0;
    return {
      flip(engine: TurnEngine, controller: AiController, playerId: string, id: string): void {
        now += 1;
        step(engine, controller, () => engine.flipCard(playerId, id, now));
      },
      waitOut(engine: TurnEngine, controller: AiController, window = GAME_CONSTANTS.MISMATCH_REVEAL_MS): void {
        now += window;
        step(engine, controller, () => engine.tick(now));
      },
      get time(): number {
        return now;
      },
    };
  }

  it('flips a remembered pair first and then its partner', () => {
    // P1 mismatches 0/2, P2 mismatches 1/3, P1 mismatches 5/7 → bot (P2) on turn 4 knows pairs 0-1 and 2-3.
    const engine = makeEngine(standardLayout());
    const controller = new AiController(P2, perfect(), createSeededRandom(9));
    const time = clock();

    time.flip(engine, controller, P1, cardId(0));
    time.flip(engine, controller, P1, cardId(2));
    time.waitOut(engine, controller);
    time.flip(engine, controller, P2, cardId(1));
    time.flip(engine, controller, P2, cardId(3));
    time.waitOut(engine, controller);
    time.flip(engine, controller, P1, cardId(5));
    time.flip(engine, controller, P1, cardId(7));
    time.waitOut(engine, controller);

    const view = engine.getPublicView();
    expect(view.turnOwner).toBe(P2);
    const first = controller.chooseFlip(view);
    expect(first).not.toBeNull();
    expect([cardId(0), cardId(1), cardId(2), cardId(3)]).toContain(first);

    time.flip(engine, controller, P2, first as string);
    const second = controller.chooseFlip(engine.getPublicView());
    expect(second).not.toBeNull();
    expect(Math.floor(indexOf(second as string) / 2)).toBe(Math.floor(indexOf(first as string) / 2));
    expect(second).not.toBe(first);
  });

  it('chooses an unknown card when nothing is remembered', () => {
    const engine = makeEngine(standardLayout());
    const controller = new AiController(P2, perfect({ memoryRetention: 0 }), createSeededRandom(4));
    const time = clock();
    time.flip(engine, controller, P1, cardId(0));
    time.flip(engine, controller, P1, cardId(2));
    time.waitOut(engine, controller);
    const choice = controller.chooseFlip(engine.getPublicView());
    expect(choice).not.toBeNull();
    expect(engine.getPublicView().board[indexOf(choice as string)]?.state).toBe('HIDDEN');
  });

  it('only acts on its own turn', () => {
    const engine = makeEngine(standardLayout());
    const controller = new AiController(P2, perfect(), createSeededRandom(2));
    expect(controller.isMyTurn(engine.getPublicView())).toBe(false);
    expect(controller.chooseFlip(engine.getPublicView())).toBeNull();
  });

  it('waits its turn and plays only its own grid in the turn-based dual format', () => {
    const engine = makeEngine(standardLayout(), 0, BOARD_MODE.DUAL_TURN_BASED);
    const controller = new AiController(P2, perfect(), createSeededRandom(4));

    controller.observe(engine.getPublicView());
    expect(controller.isMyTurn(engine.getPublicView())).toBe(false);
    expect(controller.chooseFlip(engine.getPublicView())).toBeNull();

    // P1 mismatches on its own grid, which hands the turn to the bot.
    step(engine, controller, () => engine.flipCard(P1, `${P1}:0`, 0));
    step(engine, controller, () => engine.flipCard(P1, `${P1}:2`, 1));
    step(engine, controller, () => engine.tick(1 + GAME_CONSTANTS.MISMATCH_REVEAL_MS));

    const view = engine.getPublicView();
    expect(view.turnOwner).toBe(P2);
    expect(controller.isMyTurn(view)).toBe(true);
    const choice = controller.chooseFlip(view);
    expect(choice?.startsWith(`${P2}:`)).toBe(true);

    // Its own flips are still learned normally.
    step(engine, controller, () => engine.flipCard(P2, choice as string, GAME_CONSTANTS.MISMATCH_REVEAL_MS + 2));
    expect(controller.memory.size()).toBeGreaterThan(0);
  });

  it('learns nothing from the opponent grid in the dual formats', () => {
    const engine = makeEngine(standardLayout(), 0, BOARD_MODE.DUAL_TURN_BASED);
    const controller = new AiController(P2, perfect(), createSeededRandom(4));

    step(engine, controller, () => engine.flipCard(P1, `${P1}:0`, 0));
    step(engine, controller, () => engine.flipCard(P1, `${P1}:2`, 1));
    expect(controller.memory.size()).toBe(0);
  });

  it('uses its skill once CE reaches the grade threshold', () => {
    const engine = makeEngine(trapLayout(), 2);
    // Bot is P1 (Kento Nanami, skill at 50 CE). Two traps give 60 CE.
    const controller = new AiController(P1, AI_GRADE_PROFILES.ELITE, createSeededRandom(6));
    expect(controller.chooseAbility(engine.getPublicView())).toBeNull();

    expect(engine.flipCard(P1, cardId(0), 0).ok).toBe(true);
    expect(engine.flipCard(P1, cardId(1), 1).ok).toBe(true);
    expect(controller.chooseAbility(engine.getPublicView())).toEqual({ type: 'SKILL' });
  });
});

/**
 * Higuruma (P1) against `victim` (P2) on a sixteen-card shared grid. A sandbox seats an
 * auto-picking training dummy at P2, so a bot victim needs `sandbox` set to false.
 */
function makeTrialMatch(victim: CharacterId, sandbox = true): GameEngine {
  const config: MatchConfig = {
    matchId: 'bot-sentencing-test',
    boardMode: BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: 'higuruma' },
      { id: P2, characterId: victim },
    ],
    boardSize: 16,
    trapCount: 0,
    synergyPairCount: 0,
    sandbox,
    // Matched pairs chip the victim's HP, so the match needs the full pool to outlast the trial.
    startingHp: HP_LIMITS.MAX,
  };
  const layout = Array.from({ length: 16 }, (_, i): CardSpec => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: pairCharacter(Math.floor(i / 2)),
    trapId: null,
  }));
  const engine = new GameEngine(config, createSeededRandom(5), layout);
  requireOk(engine.start(0));
  return engine;
}

function requireOk(result: EngineResult): void {
  if (!result.ok) throw new Error(`engine rejected command with ${result.code}`);
}

/** Gives Higuruma (P1) the CE for his domain and casts it at `now`. */
function castDomain(engine: GameEngine, now: number): void {
  requireOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
  requireOk(engine.activateUltimate(P1, now));
}

/**
 * Gives Higuruma (P1) the CE for his domain without a sandbox: each matched pair gives 15 CE and
 * keeps the turn, so seven pairs reach the 100 CE cost. Casts it and returns the cast time.
 */
function matchPairsThenCast(engine: GameEngine): number {
  let now = 0;
  for (let pair = 0; pair < 7; pair += 1) {
    requireOk(engine.flipCard(P1, cardId(2 * pair), now));
    requireOk(engine.flipCard(P1, cardId(2 * pair + 1), now + 1));
    now += 1000;
    engine.tick(now);
  }
  requireOk(engine.activateUltimate(P1, now));
  return now;
}

/** Advances fake timers and the engine clock together in 10ms steps. */
function advanceBy(engine: GameEngine, clock: { now: number }, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    clock.now += 10;
    vi.advanceTimersByTime(10);
    engine.tick(clock.now);
  }
}

/** Runs one full trial against a bot of the given accuracy and returns the verdicts it earned. */
function botVerdicts(accuracy: number, seed: number): Array<'NOT_GUILTY' | 'GUILTY'> {
  const engine = makeTrialMatch('satoru_gojo', false);
  const profile: AiGradeProfile = { ...AI_GRADE_PROFILES.SPECIAL, courtroomAccuracy: accuracy };
  const controller = new AiController(P2, profile, createSeededRandom(seed));
  const clock = { now: matchPairsThenCast(engine) };
  const verdicts: Array<'NOT_GUILTY' | 'GUILTY'> = [];
  const stop = startAiDriver(controller, engineHost(engine, P2, () => clock.now), {
    pollMs: 10,
    onResult: (result) => {
      if (!result.ok) return;
      for (const event of result.events) {
        if (event.type === 'COURTROOM_VERDICT') verdicts.push(event.verdict);
      }
    },
  });
  // Four rounds of preview, shuffle, prosecution and plea take well over a minute of engine time.
  for (let elapsed = 0; elapsed < 120_000 && verdicts.length < GAME_CONSTANTS.COURTROOM_SLOTS; elapsed += 10) {
    advanceBy(engine, clock, 10);
  }
  stop();
  return verdicts;
}

describe('Deadly Sentencing bot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers a Simple Domain prompt after a 1s think, escaping about 80% of the time', () => {
    const engine = makeTrialMatch('yuji_itadori');
    requireOk(engine.sandboxFillEnergy(P2, GAME_CONSTANTS.COURTROOM_ESCAPE_COST, 0));
    castDomain(engine, 0);
    expect(engine.getPublicView().sentencing?.stage).toBe('ESCAPE');

    // The odds: the bot's own roll on this prompt, drawn many times with a fixed seed.
    const odds = AiController.forGrade(P2, 'SPECIAL', createSeededRandom(11));
    const view = engine.getPublicView();
    const trials = 2000;
    const escapes = Array.from({ length: trials }, () => odds.chooseEscape(view)).filter(Boolean).length;
    expect(escapes / trials).toBeGreaterThan(AI_ESCAPE_CHANCE - 0.05);
    expect(escapes / trials).toBeLessThan(AI_ESCAPE_CHANCE + 0.05);

    // The bot waits the full think time before it answers.
    const clock = { now: 0 };
    const controller = AiController.forGrade(P2, 'SPECIAL', createSeededRandom(11));
    const stop = startAiDriver(controller, engineHost(engine, P2, () => clock.now), { pollMs: 10 });
    advanceBy(engine, clock, AI_ESCAPE_DELAY_MS - 10);
    expect(engine.getPublicView().sentencing?.stage).toBe('ESCAPE');
    advanceBy(engine, clock, 10);
    stop();
    expect(engine.getPublicView().sentencing?.stage).not.toBe('ESCAPE');
  });

  it('never spends CE on an escape without a Simple Domain ultimate', () => {
    const engine = makeTrialMatch('satoru_gojo');
    requireOk(engine.sandboxFillEnergy(P2, GAME_CONSTANTS.COURTROOM_ESCAPE_COST, 0));
    castDomain(engine, 0);
    const controller = AiController.forGrade(P2, 'SPECIAL', createSeededRandom(11));
    const view = engine.getPublicView();
    for (let i = 0; i < 200; i++) expect(controller.chooseEscape(view)).toBe(false);
  });

  it('names a slot 1.2s to 1.8s after the courtroom opens its pick', () => {
    const engine = makeTrialMatch('satoru_gojo', false);
    const clock = { now: matchPairsThenCast(engine) };
    const controller = AiController.forGrade(P2, 'SPECIAL', createSeededRandom(21));
    const stop = startAiDriver(controller, engineHost(engine, P2, () => clock.now), { pollMs: 10 });
    let pickOpened: number | null = null;
    let pickNamed: number | null = null;
    for (let elapsed = 0; elapsed < 60_000 && pickNamed === null; elapsed += 10) {
      advanceBy(engine, clock, 10);
      const phase = engine.getPublicView().sentencing?.phase;
      if (pickOpened === null && phase === COURTROOM_PHASE.PICK) pickOpened = clock.now;
      else if (pickOpened !== null && phase !== COURTROOM_PHASE.PICK) pickNamed = clock.now;
    }
    stop();
    if (pickOpened === null || pickNamed === null) throw new Error('the bot never named a slot');
    // The poll sees the open pick within one poll step, and the bot's think time follows.
    const think = pickNamed - pickOpened;
    expect(think).toBeGreaterThanOrEqual(AI_PICK_DELAY_MS.min);
    expect(think).toBeLessThanOrEqual(AI_PICK_DELAY_MS.max + 30);
  });

  it('a bot that tracks the target through the shuffle clears every round', () => {
    expect(botVerdicts(1, 9)).toEqual(['NOT_GUILTY', 'NOT_GUILTY', 'NOT_GUILTY', 'NOT_GUILTY']);
  });

  it('a bot that never names the target earns a guilty verdict every round', () => {
    expect(botVerdicts(0, 9)).toEqual(['GUILTY', 'GUILTY', 'GUILTY', 'GUILTY']);
  });

  it('grades courtroom accuracy from 25% (novice) up to 85% (special grade)', () => {
    expect(AI_GRADE_PROFILES.NOVICE.courtroomAccuracy).toBe(0.25);
    expect(AI_GRADE_PROFILES.SORCERER.courtroomAccuracy).toBe(0.5);
    expect(AI_GRADE_PROFILES.ELITE.courtroomAccuracy).toBe(0.75);
    expect(AI_GRADE_PROFILES.SPECIAL.courtroomAccuracy).toBe(0.85);
  });
});

describe('timed driver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays a full PvE match against a scripted human until the match ends', () => {
    const engine = makeEngine(standardLayout());
    let now = 0;
    const controller = AiController.forGrade(P1, 'SPECIAL', createSeededRandom(3));
    const botEvents: GameEvent[] = [];
    const stop = startAiDriver(controller, engineHost(engine, P1, () => now), {
      onResult: (result) => botEvents.push(...result.events),
    });

    // Scripted human: flips a seeded random face-down card on its turn (a fair, unscripted opponent).
    const humanRng = createSeededRandom(77);
    const humanTurn = (): void => {
      const view = engine.getPublicView();
      if (view.turnOwner !== P2 || (view.phase !== 'WAITING_FOR_P2' && view.phase !== 'P2_FLIPPED_FIRST')) return;
      const hidden = view.board.filter((card) => card.state === 'HIDDEN');
      const target = hidden[randomInt(humanRng, hidden.length)];
      if (target) engine.flipCard(P2, target.id, now);
    };

    for (let i = 0; i < 4000 && engine.getResult() === null; i++) {
      now += 100;
      vi.advanceTimersByTime(100);
      engine.tick(now);
      humanTurn();
    }
    stop();

    const result = engine.getResult();
    expect(result).not.toBeNull();
    expect(result?.winnerId).toBe(P1);
    expect(engine.getPublicView().players.find((p) => p.id === P1)?.pairsMatched).toBeGreaterThan(0);
    // Every bot command result is reported, so the UI sees the bot's matches.
    expect(botEvents.some((e) => e.type === 'PAIR_MATCHED' && e.playerId === P1)).toBe(true);
  });

  it('plays a turn-based dual match, where each side only ever touches its own grid', () => {
    const engine = makeEngine(standardLayout(), 0, BOARD_MODE.DUAL_TURN_BASED);
    let now = 0;
    const controller = AiController.forGrade(P1, 'ELITE', createSeededRandom(5));
    const stop = startAiDriver(controller, engineHost(engine, P1, () => now), {});

    const humanRng = createSeededRandom(31);
    const humanTurn = (): void => {
      const view = engine.getPublicView();
      if (view.turnOwner !== P2) return;
      const attempt = view.attempts.find((candidate) => candidate.playerId === P2);
      if (!attempt || attempt.phase === 'EVALUATING' || attempt.stunnedUntil > now) return;
      const hidden = boardOfPlayer(view, P2).filter((card) => card.state === 'HIDDEN');
      if (hidden.length === 0) return;
      const target = hidden[randomInt(humanRng, hidden.length)];
      if (target) engine.flipCard(P2, target.id, now);
    };

    for (let i = 0; i < 4000 && engine.getResult() === null; i++) {
      now += 100;
      vi.advanceTimersByTime(100);
      engine.tick(now);
      humanTurn();
    }
    stop();

    // Neither side can stall on the bench: the match reaches a knockout.
    expect(engine.getResult()).toMatchObject({ winnerId: P1, reason: 'KNOCKOUT' });
    const view = engine.getPublicView();
    expect(view.players.find((player) => player.id === P1)?.pairsMatched).toBeGreaterThan(0);
    expect(boardOfPlayer(view, P1).every((card) => card.revealedBy === null || card.revealedBy === P1)).toBe(true);
    expect(boardOfPlayer(view, P2).every((card) => card.revealedBy === null || card.revealedBy === P2)).toBe(true);
  });

  it('plays a dual-board match, where each side owns its own grid', () => {
    const engine = makeEngine(standardLayout(), 0, BOARD_MODE.DUAL);
    let now = 0;
    const controller = AiController.forGrade(P1, 'ELITE', createSeededRandom(5));
    const stop = startAiDriver(controller, engineHost(engine, P1, () => now), {});

    const humanRng = createSeededRandom(31);
    const humanTurn = (): void => {
      const view = engine.getPublicView();
      const attempt = view.attempts.find((candidate) => candidate.playerId === P2);
      if (!attempt || attempt.phase === 'EVALUATING' || attempt.stunnedUntil > now) return;
      const hidden = boardOfPlayer(view, P2).filter((card) => card.state === 'HIDDEN');
      if (hidden.length === 0) return;
      const target = hidden[randomInt(humanRng, hidden.length)];
      if (target) engine.flipCard(P2, target.id, now);
    };

    for (let i = 0; i < 4000 && engine.getResult() === null; i++) {
      now += 100;
      vi.advanceTimersByTime(100);
      engine.tick(now);
      humanTurn();
    }
    stop();

    expect(engine.getResult()).not.toBeNull();
    expect(engine.getPublicView().players.find((p) => p.id === P1)?.pairsMatched).toBeGreaterThan(0);
    // Neither side ever touched the other's grid.
    const view = engine.getPublicView();
    const p1Grid = boardOfPlayer(view, P1);
    expect(p1Grid.every((card) => card.revealedBy === null || card.revealedBy === P1)).toBe(true);
  });
});
