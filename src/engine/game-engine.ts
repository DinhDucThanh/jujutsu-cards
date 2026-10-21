import {
  pickHiddenPositions,
  pickPairPositions,
  pickPairPositionsList,
  swapPositions,
} from './abilities.js';
import {
  assertBoardLayout,
  createBoardTemplate,
  instantiateBoard,
  isBoardCleared,
  type BoardSize,
  type BoardTemplateOptions,
  type CardSpec,
} from './board.js';
import { generateBoardAvoiding, generateIndependentBoards } from './board-generator.js';
import { CHARACTERS, SYNERGIES, SYNERGY_PAIR_PREFIX, TRAPS, synergyByPairId } from './catalog.js';
import {
  applyDamage,
  calculateMatchEffects,
  clampCursedEnergy,
  grantShield,
  heal,
  isBlackFlash,
  maxHpOf,
  shieldCapOf,
} from './combat.js';
import { CARD_EFFECT_RULES, GAME_CONSTANTS, GAME_PACING, HP_LIMITS, SHARED_BOARD_ID } from './constants.js';
import { verifyPair } from './matcher.js';
import { adaptStatusForMode } from './mode-adapt.js';
import { assertTransition, calculateTurnDuration, canTransition } from './phases.js';
import {
  hasModifier,
  toPublicCard,
  type AttemptStep,
  type PublicAttemptView,
  type PublicBoardView,
  type PublicMatchView,
  type PublicPendingView,
  type PublicSentencingView,
} from './public-view.js';
import { randomInt, randomUnit, type RandomSource } from './random.js';
import { SKILLS, SOUL_DIVERGENT_STRIKE_EFFECTS, ULTIMATES } from './skills.js';
import { soundCuesForEvents, type SoundListener } from './sound-cues.js';
import { projectTurnQueue, type TurnQueueItem } from './turn-queue.js';
import { consumeStatus, hasStatus, removeStatus, statusValue, tickStatusTurn } from './status.js';
import type { DebugAction, DebugEvent, EngineErrorCode, EngineResult, GameEvent } from './events.js';
import {
  BOARD_MODE,
  CARD_EFFECT_KIND,
  CARD_STATE,
  CARD_TYPE,
  COURTROOM_PHASE,
  DAMAGE_CAUSE,
  MATCH_END_REASON,
  STATUS_KIND,
  TURN_PHASE,
  ULTIMATE_TYPE,
  isTurnBasedMode,
  BLESSING,
  BOARD_CLEAR_REWARD,
  boardClearRewardOf,
  usesOwnBoards,
  type AbilityEffect,
  type BoardId,
  type BoardMode,
  type Card,
  type CardId,
  type CardEffectModifier,
  type CardSubjectId,
  type CharacterId,
  type CourtroomState,
  type EscapeWindow,
  type PairId,
  type SynergyId,
  type DamageCause,
  type EffectBoard,
  type MatchConfig,
  type MatchResult,
  type MatchSetup,
  type PendingResolution,
  type PlayerId,
  type PlayerSetup,
  type PlayerState,
  type StatusEffect,
  type StatusSpec,
  type TurnPhase,
  type BlessingId,
  type BoardClearRewardMode,
  type ResolvedMatchSetup,
  type SetupCharacter,
  type SetupOpponent,
  type PachinkoTier,
} from './types.js';

type Seat = 0 | 1;

/** Scores one Idle Death Gamble spin: three matching reels win; odd digits regular, even digits golden, 7-7-7 supreme. */
function pachinkoTier(reels: readonly number[]): PachinkoTier {
  const [first] = reels;
  if (first === undefined || reels.some((reel) => reel !== first)) return 'MISS';
  if (first === GAME_CONSTANTS.PACHINKO_REELS) return 'SUPREME';
  return first % 2 === 1 ? 'REGULAR' : 'GOLDEN';
}
/** Reel faces the training ground lands an Idle Death Gamble spin on. GOLDEN is the 7-7-7 supreme jackpot. */
const FORCED_HAKARI_REELS: Readonly<Record<'REGULAR' | 'GOLDEN' | 'WHIFF', readonly number[]>> = {
  REGULAR: [1, 1, 1],
  GOLDEN: [GAME_CONSTANTS.PACHINKO_REELS, GAME_CONSTANTS.PACHINKO_REELS, GAME_CONSTANTS.PACHINKO_REELS],
  WHIFF: [1, 2, 3],
};
type Step = 'WAIT' | 'FIRST' | 'SECOND';

interface Attempt {
  openCards: CardId[];
  pending: PendingResolution | null;
}

/** Cards revealed by a scouting effect, to be hidden again once the window closes. */
interface HideTimer {
  readonly at: number;
  readonly cardIds: readonly CardId[];
}

/** Safety bound for the turn-skip loop; charges are finite, so this only guards a bug. */
const MAX_TURN_SKIPS = 8;

const PHASE_BY_SEAT: Readonly<Record<Seat, Readonly<Record<Step, TurnPhase>>>> = {
  0: { WAIT: TURN_PHASE.WAITING_FOR_P1, FIRST: TURN_PHASE.P1_FLIPPED_FIRST, SECOND: TURN_PHASE.P1_FLIPPED_SECOND },
  1: { WAIT: TURN_PHASE.WAITING_FOR_P2, FIRST: TURN_PHASE.P2_FLIPPED_FIRST, SECOND: TURN_PHASE.P2_FLIPPED_SECOND },
};

/** Ability origin, used to label the damage and energy events it produces. */
type EffectOrigin = 'SKILL' | 'ULTIMATE' | 'SYNERGY';

function isValidTimestamp(now: number): boolean {
  return Number.isFinite(now) && now >= 0;
}

function damageCauseOf(origin: EffectOrigin): DamageCause {
  if (origin === 'SKILL') return DAMAGE_CAUSE.SKILL;
  if (origin === 'ULTIMATE') return DAMAGE_CAUSE.ULTIMATE;
  return DAMAGE_CAUSE.SYNERGY;
}

function createPlayerState(setup: PlayerSetup, startingHp: number): PlayerState {
  return {
    id: setup.id,
    characterId: setup.characterId,
    maxHp: startingHp,
    hp: startingHp,
    shield: 0,
    cursedEnergy: 0,
    activeEffects: [],
    comboStreak: 0,
    pairsMatched: 0,
    activeDomain: null,
    activeSimpleDomain: null,
    stunUntil: 0,
    executioner: null,
    guaranteedBlackFlash: false,
    pachinko: { spinsLeft: 0, pity: 0, resetOnExpiry: false },
  };
}

/** The Confiscated Cursed Tool seal on a card, if a courtroom verdict planted one. */
function confiscatedSeal(card: Card): CardEffectModifier | undefined {
  return card.effectModifiers.find(
    (modifier) => modifier.kind === CARD_EFFECT_KIND.LOCKED && modifier.tickOwner !== undefined,
  );
}

/** Picks `count` distinct entries of `pool`, in random order. */
function sampleDistinct<T>(pool: readonly T[], count: number, rng: RandomSource): T[] {
  const remaining = [...pool];
  const picked: T[] = [];
  while (picked.length < count && remaining.length > 0) {
    const [next] = remaining.splice(Math.floor(randomUnit(rng) * remaining.length), 1);
    if (next !== undefined) picked.push(next);
  }
  return picked;
}

/** Every sorcerer may be seated in a trial except Higuruma, who is the Judgeman. */
const SENTENCING_SUBJECTS: readonly CardSubjectId[] = (Object.keys(CHARACTERS) as CardSubjectId[]).filter(
  (id) => id !== 'higuruma',
);

/** Values a one-click chaos roll picks from, matching the setup modal's own options. */
export const SETUP_GRID_CHOICES = [16, 36] as const;
export const SETUP_HP_CHOICES = [100, 200, 300] as const;
export const SETUP_TRAP_CHOICES = [0, 2, 4] as const;
export const SETUP_SYNERGY_CHOICES = [0, 1, 2, 3, 4] as const;
export const SETUP_BOARD_LAYOUT_CHOICES: readonly BoardMode[] = [
  BOARD_MODE.DUAL,
  BOARD_MODE.DUAL_TURN_BASED,
  BOARD_MODE.SHARED,
];
export const SETUP_CLEAR_REWARD_CHOICES: readonly BoardClearRewardMode[] = [
  BOARD_CLEAR_REWARD.MANUAL_CHOICE,
  BOARD_CLEAR_REWARD.RANDOM_AUTO,
];
/** A random opponent only ever lands on a local format: rooms and training need context. */
const SETUP_OPPONENT_CHOICES: readonly ('PVE' | 'PVP')[] = ['PVE', 'PVP'];
const PLAYABLE_CHARACTERS: readonly CharacterId[] = Object.keys(CHARACTERS) as CharacterId[];

function pickSetupValue<T>(pool: readonly T[], rng: RandomSource): T {
  const value = pool[randomInt(rng, pool.length)];
  if (value === undefined) throw new Error('Cannot roll a setup value from an empty pool');
  return value;
}

function rollCharacter(rng: RandomSource, exclude?: CharacterId): CharacterId {
  const pool = exclude === undefined ? PLAYABLE_CHARACTERS : PLAYABLE_CHARACTERS.filter((id) => id !== exclude);
  return pickSetupValue(pool.length > 0 ? pool : PLAYABLE_CHARACTERS, rng);
}

function concreteCharacter(choice: SetupCharacter, rng: RandomSource, exclude?: CharacterId): CharacterId {
  return choice === 'RANDOM' ? rollCharacter(rng, exclude) : choice;
}

export interface ResolveMatchOptions {
  readonly matchId?: string;
  /** Seat ids in the engine: player 1 and player 2. */
  readonly playerIds?: readonly [PlayerId, PlayerId];
  /** The flow owns the opponent: a co-op room cannot silently become a local match. */
  readonly opponent?: SetupOpponent;
  /** Seat 2 is chosen outside the form (AI grade profile, co-op guest). */
  readonly p2Character?: CharacterId;
  /** Training ground context, independent of the opponent label. */
  readonly sandbox?: boolean;
}

/**
 * Turns a possibly-random setup into a concrete, valid `MatchConfig`.
 *
 * Every `RANDOM` field is rolled exactly once, from the caller's RNG, so a seeded source
 * makes a whole "chaos" match reproducible in tests. Seat 2 is rolled to differ from
 * seat 1 when both are random: a mirror duel is legal, but not a pleasant surprise.
 */
export function resolveMatchConfig(
  setup: MatchSetup,
  rng: RandomSource,
  options: ResolveMatchOptions = {},
): ResolvedMatchSetup {
  const opponentChoice = options.opponent ?? setup.opponent;
  const opponent: SetupOpponent =
    opponentChoice === 'RANDOM' ? pickSetupValue(SETUP_OPPONENT_CHOICES, rng) : opponentChoice;
  const sandbox = options.sandbox ?? opponent === 'SANDBOX';
  // Training honours the chosen layout too: a dual training match deals one grid per fighter.
  const boardLayout =
    setup.boardLayout === 'RANDOM' ? pickSetupValue(SETUP_BOARD_LAYOUT_CHOICES, rng) : setup.boardLayout;
  const gridSize = setup.gridSize === 'RANDOM' ? pickSetupValue(SETUP_GRID_CHOICES, rng) : setup.gridSize;
  const startingHp = setup.startingHp === 'RANDOM' ? pickSetupValue(SETUP_HP_CHOICES, rng) : setup.startingHp;
  const cursedTraps =
    setup.cursedTraps === 'RANDOM' ? pickSetupValue(SETUP_TRAP_CHOICES, rng) : setup.cursedTraps;
  const loreSynergies =
    setup.loreSynergies === 'RANDOM' ? pickSetupValue(SETUP_SYNERGY_CHOICES, rng) : setup.loreSynergies;
  const boardClearReward =
    setup.boardClearReward === 'RANDOM'
      ? pickSetupValue(SETUP_CLEAR_REWARD_CHOICES, rng)
      : setup.boardClearReward;
  const p1Character = concreteCharacter(setup.p1Character, rng);
  const p2Character = options.p2Character ?? concreteCharacter(setup.p2Character, rng, p1Character);
  const [firstId, secondId] = options.playerIds ?? ['p1', 'p2'];

  const resolved: MatchSetup = {
    opponent,
    boardLayout,
    boardClearReward,
    gridSize,
    startingHp,
    p1Character,
    p2Character,
    cursedTraps,
    loreSynergies,
  };
  const config: MatchConfig = {
    matchId: options.matchId ?? `match-${Date.now()}`,
    boardMode: boardLayout,
    players: [
      { id: firstId, characterId: p1Character },
      { id: secondId, characterId: p2Character },
    ],
    boardSize: gridSize,
    trapCount: cursedTraps,
    synergyPairCount: loreSynergies,
    startingHp,
    boardClearReward,
    ...(sandbox ? { sandbox: true } : {}),
  };
  return { setup: resolved, config };
}

export interface RollSetupOptions {
  /** Keep an online room or training ground as it is; only re-roll the match rules. */
  readonly lockOpponent?: boolean;
  /** A co-op host never chooses player 2: the joining player does. */
  readonly lockP2Character?: boolean;
}

/**
 * Rolls every setup field into a concrete value for the modal's "Pure Chaos" button.
 * Unlike `resolveMatchConfig` it keeps the choices visible in the controls, so the player
 * can see what was rolled and tweak any field before starting.
 */
export function rollSetup(setup: MatchSetup, rng: RandomSource, options: RollSetupOptions = {}): MatchSetup {
  const lockedOpponent =
    options.lockOpponent === true && (setup.opponent === 'ONLINE' || setup.opponent === 'SANDBOX');
  const opponent: SetupOpponent = lockedOpponent
    ? setup.opponent
    : pickSetupValue(SETUP_OPPONENT_CHOICES, rng);
  const p1Character = rollCharacter(rng);
  return {
    opponent,
    boardLayout: pickSetupValue(SETUP_BOARD_LAYOUT_CHOICES, rng),
    boardClearReward: pickSetupValue(SETUP_CLEAR_REWARD_CHOICES, rng),
    gridSize: pickSetupValue(SETUP_GRID_CHOICES, rng),
    startingHp: pickSetupValue(SETUP_HP_CHOICES, rng),
    p1Character,
    p2Character: options.lockP2Character === true ? 'RANDOM' : rollCharacter(rng, p1Character),
    cursedTraps: pickSetupValue(SETUP_TRAP_CHOICES, rng),
    loreSynergies: pickSetupValue(SETUP_SYNERGY_CHOICES, rng),
  };
}

function validateConfig(config: MatchConfig): void {
  const [first, second] = config.players;
  if (first.id === second.id) throw new Error('Players must have distinct ids');
  if (first.id === SHARED_BOARD_ID || second.id === SHARED_BOARD_ID) {
    throw new Error(`Player id "${SHARED_BOARD_ID}" is reserved`);
  }
  for (const player of config.players) {
    if (!(player.characterId in CHARACTERS)) throw new Error(`Unknown character "${player.characterId}"`);
  }
  if (config.boardSize !== 16 && config.boardSize !== 36) {
    throw new Error(`Match boards must be 16 or 36 cards, got ${config.boardSize}`);
  }
  if (!Object.values(BOARD_MODE).includes(config.boardMode)) {
    throw new Error(`Unknown board mode "${config.boardMode}"`);
  }
  const startingHp = config.startingHp ?? HP_LIMITS.DEFAULT;
  if (!Number.isInteger(startingHp) || startingHp < HP_LIMITS.MIN || startingHp > HP_LIMITS.MAX) {
    throw new Error(`startingHp must be an integer in [${HP_LIMITS.MIN}, ${HP_LIMITS.MAX}], got ${startingHp}`);
  }
}

/**
 * Authoritative match engine.
 *
 * SHARED mode: one grid, strict turn order, the active seat flips up to its flip limit.
 * DUAL_TURN_BASED mode: one grid per player, strict turn order; you flip on your own grid,
 * and offensive skills aimed at "the opponent's grid" sabotage the grid they will play on.
 * DUAL mode: one grid per player, both act concurrently.
 *
 * Cleared grids never end the match: they are re-dealt so long matches stay playable.
 *
 * Commands take an explicit engine time `now` (non-decreasing), which keeps the engine
 * deterministic and testable.
 */
export class GameEngine {
  private readonly matchId: string;
  /** Mutable only so the training ground can switch layouts without leaving the match. */
  private mode: BoardMode;
  /** Turn-based modes alternate the active seat; plain DUAL lets both act at once. */
  private readonly turnBased: boolean;
  /** Dual modes give every player their own grid; SHARED uses one grid for both. */
  private dualBoards: boolean;
  /** Training ground: dummy opponent, no turn clock, turn order frozen on player 1. */
  private readonly sandbox: boolean;
  /** The training dummy's seat, or null outside a sandbox match. */
  private readonly dummyId: PlayerId | null;
  /** How every grid is dealt, reused whenever a cleared grid respawns. */
  private readonly deal: BoardTemplateOptions;
  private readonly playerIds: readonly [PlayerId, PlayerId];
  private readonly players = new Map<PlayerId, PlayerState>();
  private readonly boards = new Map<BoardId, Card[]>();
  private readonly attempts = new Map<PlayerId, Attempt>();
  private readonly hideTimers: HideTimer[] = [];
  private readonly rng: RandomSource;
  /** Optional presentation tap on emitted events; the rules never read it. */
  private soundListener: SoundListener | null = null;

  private phase: TurnPhase = TURN_PHASE.MATCH_START;
  private clock: number | null = null;
  private turnOwnerSeat: Seat = 0;
  private turnNumber = 0;
  private turnDeadline: number | null = null;
  private cycleCount = 0;
  private result: MatchResult | null = null;
  /** A Deadly Sentencing awaiting the victim's escape decision, or null. */
  private escapeWindow: EscapeWindow | null = null;
  /** The Deadly Sentencing trial in progress, or null. */
  private courtroom: CourtroomState | null = null;
  /** Engine time when the turn clock was paused for a sentencing, or null while it runs. */
  private sentencingPausedAt: number | null = null;
  /** A cleared board waiting for its clearer's Awakening Surge blessing, or null. */
  private awakening: { readonly playerId: PlayerId; readonly boardId: BoardId; readonly decideBy: number } | null = null;
  /** The player whose pair most recently matched; the clearer of a board that just emptied. */
  private lastMatcherId: PlayerId | null = null;
  /** How cleared boards settle their Awakening Surge. Fixed for the whole match. */
  private readonly clearReward: BoardClearRewardMode;
  /** Training ground only: the debug X-ray that reveals every card's identity on the grid. */
  private xRay = false;
  /** Training ground only: the reels the next Idle Death Gamble spin lands on, consumed once. */
  private forcedReels: readonly number[] | null = null;

  /**
   * `layout` overrides the random deal (tests, replays, custom boards). It must pass
   * `assertBoardLayout` for the config. In DUAL mode both grids get the same mirrored
   * layout as independent card objects, so neither player is advantaged by the deal.
   */
  constructor(config: MatchConfig, rng: RandomSource, layout?: readonly CardSpec[]) {
    validateConfig(config);
    this.rng = rng;
    this.clearReward = boardClearRewardOf(config);
    this.matchId = config.matchId;
    this.mode = config.boardMode;
    this.sandbox = config.sandbox === true;
    // A sandbox always runs a turn order, even if its grid layout is simultaneous:
    // the dummy must never get a turn of its own to act in.
    this.turnBased = isTurnBasedMode(config.boardMode) || this.sandbox;
    this.dualBoards = usesOwnBoards(config.boardMode);
    this.deal = {
      size: config.boardSize as BoardSize,
      trapCount: config.trapCount,
      synergyPairCount: config.synergyPairCount,
    };
    this.playerIds = [config.players[0].id, config.players[1].id];
    const startingHp = config.startingHp ?? HP_LIMITS.DEFAULT;
    config.players.forEach((setup, index) => {
      // The dummy soaks everything: a huge pool plus IMMORTAL, so a training session
      // never ends in a knockout and every mechanic stays testable.
      const dummy = this.sandbox && index === 1;
      const player = createPlayerState(setup, dummy ? GAME_CONSTANTS.SANDBOX_DUMMY_HP : startingHp);
      if (dummy) player.activeEffects.push(this.immortality(setup.id));
      this.players.set(setup.id, player);
    });
    this.dummyId = this.sandbox ? (this.playerIds[1] ?? null) : null;

    if (this.dualBoards && layout === undefined) {
      // Dual match, random deal: every grid gets its own roster sample and its own
      // shuffle. A mirrored deal would let each player read the other's grid — trap
      // positions included — straight off their own.
      for (const [id, cards] of generateIndependentBoards(this.playerIds, {
        ...this.deal,
        rng: this.rng,
      })) {
        this.boards.set(id, cards);
      }
    } else {
      // A shared grid, the training ground, or an explicit layout (tests, replays and
      // custom boards): one deal, instantiated per grid, so a supplied layout stays the
      // laid-out fixture the caller asked for.
      const template = layout ?? createBoardTemplate(this.deal, rng);
      assertBoardLayout(template, config.boardSize, config.trapCount);
      if (this.dualBoards) {
        for (const id of this.playerIds) this.boards.set(id, instantiateBoard(template, id));
      } else {
        this.boards.set(SHARED_BOARD_ID, instantiateBoard(template, SHARED_BOARD_ID));
      }
    }
    for (const id of this.playerIds) this.attempts.set(id, { openCards: [], pending: null });
  }

  /**
   * Attaches (or clears) the sound tap. The engine calls it once per returned result with
   * the cues its events map to; nothing about the match state depends on it, so headless
   * drivers, tests and the AI simply never set it.
   */
  setSoundListener(listener: SoundListener | null): void {
    this.soundListener = listener;
  }

  getPhase(): TurnPhase {
    return this.phase;
  }

  getResult(): MatchResult | null {
    return this.result;
  }

  getBoardMode(): BoardMode {
    return this.mode;
  }

  /**
   * The next `depth` turns as they will actually be played, or an empty list when the
   * mode has no turn order (simultaneous dual play, or the training ground where the
   * player keeps the turn forever). Read-only: the projection never touches live state.
   */
  getUpcomingTurnQueue(depth = 3): TurnQueueItem[] {
    if (!this.turnBased || this.sandbox) return [];
    if (this.phase === TURN_PHASE.MATCH_START || this.isOver()) return [];
    return projectTurnQueue(
      this.playerIds.map((id) => this.playerState(id)),
      this.turnOwnerSeat,
      depth,
    );
  }

  start(now: number): EngineResult {
    const events: GameEvent[] = [];
    if (this.phase !== TURN_PHASE.MATCH_START) return this.reject('ALREADY_STARTED', events);
    if (!isValidTimestamp(now)) return this.reject('INVALID_TIME', events);
    this.clock = now;
    this.turnNumber = 1;
    events.push({ type: 'MATCH_STARTED', at: now, boardMode: this.mode });

    if (this.turnBased) {
      // No clock in the training ground: the player sets their own pace.
      this.turnDeadline = this.sandbox ? null : now + calculateTurnDuration(this.turnNumber);
      this.transition(PHASE_BY_SEAT[0].WAIT, events);
      events.push({ type: 'TURN_STARTED', playerId: this.turnOwner(), turnNumber: this.turnNumber });
    } else {
      this.turnDeadline = null;
      this.transition(TURN_PHASE.IN_PROGRESS, events);
    }
    return this.accept(events);
  }

  /** Processes time-driven state (evaluation windows, reveal timers, turn timeouts). Call regularly. */
  tick(now: number): EngineResult {
    const events: GameEvent[] = [];
    if (this.phase === TURN_PHASE.MATCH_START) return this.reject('NOT_STARTED', events);
    if (this.phase === TURN_PHASE.MATCH_OVER) return this.accept(events);
    const syncError = this.advance(now, events);
    if (syncError) return this.reject(syncError, events);
    return this.accept(events);
  }

  /**
   * Holds the turn clock for a moment: the time passes, the clock does not.
   *
   * A trap that goes off holds the turn for as long as its burst plays, so the player is
   * never charged for watching it. Only the turn-based modes have a clock to hold; the
   * concurrent ones have none.
   */
  holdTurnClock(ms: number): void {
    if (this.turnDeadline !== null) this.turnDeadline += Math.max(0, ms);
  }

  /** Opens one card for `playerId`. The attempt resolves once a pair appears or the limit is reached. */
  flipCard(playerId: PlayerId, cardId: CardId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.preflight(now, events);
    if (gate) return this.reject(gate, events);

    const seat = this.seatOf(playerId);
    if (seat === null) return this.reject('UNKNOWN_PLAYER', events);
    const player = this.playerState(playerId);
    const attempt = this.attempt(playerId);
    if (attempt.pending) return this.reject('EVALUATING', events);

    // A Confiscated Cursed Tool on the shared grid has its own rules for whoever touches it.
    const tool = this.cardById(cardId);
    const seal = tool && this.mode === BOARD_MODE.SHARED ? confiscatedSeal(tool) : undefined;
    if (tool && seal) return this.touchConfiscatedTool(player, seat, tool, seal, now, events);

    if (this.turnBased && (seat !== this.turnOwnerSeat || !this.isAwaitingAction())) {
      return this.reject('NOT_YOUR_TURN', events);
    }
    if (now < player.stunUntil) return this.reject('STUNNED', events);

    const board = this.boardFor(playerId);
    const card = board.find((candidate) => candidate.id === cardId);
    if (!card) {
      // Aims at the other seat's grid: say so instead of a bare "card not found".
      if (this.dualBoards && this.cardById(cardId) !== undefined) return this.reject('WRONG_BOARD', events);
      return this.reject('CARD_NOT_FOUND', events);
    }
    if (card.state !== CARD_STATE.HIDDEN) return this.reject('CARD_UNAVAILABLE', events);
    if (hasModifier(card, CARD_EFFECT_KIND.LOCKED)) {
      // Jogo's volcanic body incinerates seals on the shared grid instead of being blocked by them.
      if (this.mode === BOARD_MODE.SHARED && player.characterId === 'jogo') {
        return this.absorbSeal(player, card, now, events);
      }
      return this.reject('CARD_LOCKED', events);
    }

    if (card.type === CARD_TYPE.TRAP) {
      // Traps do not count as a pair attempt: any open card stays open. Planted
      // modifiers still resolve, since a trap is an ordinary card on the grid.
      this.triggerCardEffects(player, card, now, events);
      this.triggerTrap(player, card, events);
      this.settleBoards(now, events);
      return this.accept(events);
    }

    this.revealCard(player, card, now, events);
    attempt.openCards.push(card.id);
    if (this.turnBased) {
      this.transition(attempt.openCards.length === 1 ? PHASE_BY_SEAT[seat].FIRST : PHASE_BY_SEAT[seat].SECOND, events);
    }
    this.evaluateIfReady(player, board, now, events);
    this.settleBoards(now, events);
    return this.accept(events);
  }

  /**
   * Jogo's Seal Absorption: touching a sealed card on the shared grid consumes the seal,
   * restores cursed energy, and leaves the card face-down and flippable. It is a utility
   * touch, not a flip attempt, so it neither opens a card nor passes the turn.
   */
  private absorbSeal(player: PlayerState, card: Card, now: number, events: GameEvent[]): EngineResult {
    card.effectModifiers = card.effectModifiers.filter((modifier) => modifier.kind !== CARD_EFFECT_KIND.LOCKED);
    const before = player.cursedEnergy;
    player.cursedEnergy = clampCursedEnergy(before + GAME_CONSTANTS.SEAL_ABSORPTION_CE);
    const gained = player.cursedEnergy - before;
    events.push({ type: 'CE_CHANGED', playerId: player.id, delta: gained, cause: 'CARD_EFFECT' });
    events.push({
      type: 'SEAL_ABSORBED',
      playerId: player.id,
      boardId: SHARED_BOARD_ID,
      cardId: card.id,
      ceGain: gained,
    });
    this.settleBoards(now, events);
    return this.accept(events);
  }

  /**
   * Shared-board Confiscated Cursed Tool. Its victim pays a backlash and loses the turn; its
   * caster reclaims it for barrier and a free flip, which does not consume their turn.
   */
  private touchConfiscatedTool(
    player: PlayerState,
    seat: Seat,
    card: Card,
    seal: CardEffectModifier,
    now: number,
    events: GameEvent[],
  ): EngineResult {
    if (player.id === seal.sourceId) {
      card.effectModifiers = card.effectModifiers.filter((modifier) => modifier !== seal);
      const added = grantShield(player, GAME_CONSTANTS.CONFISCATED_RECLAIM_BARRIER);
      events.push({
        type: 'STATUS_APPLIED',
        playerId: player.id,
        sourceId: player.id,
        status: STATUS_KIND.SHIELD,
        value: added,
        turnsRemaining: null,
      });
      this.applyStatus(player, player, { status: STATUS_KIND.EXTRA_FLIP, value: 1, turns: 1 }, now, events);
      events.push({ type: 'CONFISCATED_TOOL', playerId: player.id, casterId: seal.sourceId, cardId: card.id, outcome: 'RECLAIMED' });
      this.settleBoards(now, events);
      return this.accept(events);
    }

    if (this.turnBased && (seat !== this.turnOwnerSeat || !this.isAwaitingAction())) {
      return this.reject('NOT_YOUR_TURN', events);
    }
    if (now < player.stunUntil) return this.reject('STUNNED', events);

    const backlashCe = GAME_CONSTANTS.CONFISCATED_BACKLASH_CE;
    if (player.cursedEnergy >= backlashCe) {
      player.cursedEnergy = clampCursedEnergy(player.cursedEnergy - backlashCe);
      events.push({ type: 'CE_CHANGED', playerId: player.id, delta: -backlashCe, cause: 'CARD_EFFECT' });
    } else {
      const result = applyDamage(player, GAME_CONSTANTS.CONFISCATED_BACKLASH_DAMAGE);
      events.push({
        type: 'DAMAGE_DEALT',
        sourceId: seal.sourceId,
        targetId: player.id,
        dealt: result.dealt,
        absorbed: result.absorbed,
        critical: false,
        piercing: false,
        cause: DAMAGE_CAUSE.RECOIL,
      });
    }
    events.push({ type: 'CONFISCATED_TOOL', playerId: player.id, casterId: seal.sourceId, cardId: card.id, outcome: 'BACKLASH' });
    this.closePlayerTurn(player, now, events);
    if (this.isOver()) return this.accept(events);
    events.push({ type: 'TURN_ENDED', playerId: player.id, reason: 'TRAP' });
    this.passTurn(now, events);
    return this.accept(events);
  }

  /** Spends 50 CE on the character's skill and applies its real effects. */
  activateSkill(playerId: PlayerId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.preflight(now, events);
    if (gate) return this.reject(gate, events);
    const block = this.actionBlock(playerId, now);
    if (block) return this.reject(block, events);

    const player = this.playerState(playerId);
    // Executioner's Sword takes over Gavel Strike's slot while a sentence lasts.
    const sword = player.executioner;
    const skill = SKILLS[sword ? 'executioners_sword' : CHARACTERS[player.characterId].skillId];
    if (!skill) return this.reject('NO_SKILL', events);
    if (player.cursedEnergy < skill.cost) return this.reject('INSUFFICIENT_CE', events);

    // Yuji's Soul Strike (his ultimate's buff) turns Divergent Fist into Soul Divergent Strike.
    const soulStrike = skill.id === 'divergent_fist' && hasStatus(player.activeEffects, STATUS_KIND.SOUL_STRIKE);
    player.cursedEnergy = clampCursedEnergy(player.cursedEnergy - skill.cost);
    events.push({
      type: 'SKILL_ACTIVATED',
      playerId,
      characterId: player.characterId,
      skillId: skill.id,
      name: soulStrike ? 'Soul Divergent Strike' : skill.name,
      cost: skill.cost,
      vfx: skill.id === 'cleave' ? 'CLEAVE' : 'SKILL',
    });
    // The sword's true damage is fixed by the trial's mistakes, so it replaces the placeholder amount.
    const baseEffects = soulStrike ? SOUL_DIVERGENT_STRIKE_EFFECTS : skill.effects;
    const effects = sword
      ? skill.effects.map((effect): AbilityEffect => (effect.kind === 'DAMAGE' ? { ...effect, amount: sword.damage } : effect))
      : baseEffects;
    this.applyEffects(player, effects, now, events, 'SKILL');
    this.syncLockedEnergy(player);
    this.settleBoards(now, events);
    return this.accept(events);
  }

  /**
   * Spends 100 CE on the character's ultimate. DOMAIN ultimates open a lasting
   * domain; SIMPLE_DOMAIN_MAXIMUM ultimates also neutralize an enemy domain.
   */
  activateUltimate(playerId: PlayerId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.preflight(now, events);
    if (gate) return this.reject(gate, events);
    const block = this.actionBlock(playerId, now);
    if (block) return this.reject(block, events);

    const player = this.playerState(playerId);
    const ultimate = ULTIMATES[CHARACTERS[player.characterId].ultimateId];
    if (!ultimate) return this.reject('NO_DOMAIN', events);
    if (player.cursedEnergy < ultimate.cost) return this.reject('INSUFFICIENT_CE', events);

    const isDomain = ultimate.type === ULTIMATE_TYPE.DOMAIN;
    if (isDomain && player.activeDomain) return this.reject('DOMAIN_ALREADY_ACTIVE', events);
    if (isDomain && ultimate.domainId === null) throw new Error('invariant: domain ultimate without a domainId');

    player.cursedEnergy = clampCursedEnergy(player.cursedEnergy - ultimate.cost);
    if (isDomain && ultimate.domainId !== null) {
      player.activeDomain = { domainId: ultimate.domainId, turnsRemaining: GAME_CONSTANTS.DOMAIN_DURATION_TURNS };
    }

    events.push({
      type: 'ULTIMATE_ACTIVATED',
      playerId,
      characterId: player.characterId,
      ultimateId: ultimate.id,
      name: ultimate.name,
      cost: ultimate.cost,
      ultimateType: ultimate.type,
      domainId: ultimate.domainId,
      turnsRemaining: isDomain ? GAME_CONSTANTS.DOMAIN_DURATION_TURNS : null,
      vfx: isDomain ? 'DOMAIN' : 'SIMPLE_DOMAIN',
    });
    this.applyEffects(player, ultimate.effects, now, events, 'ULTIMATE');
    this.syncLockedEnergy(player);
    this.settleBoards(now, events);
    return this.accept(events);
  }

  /**
   * Idle Death Gamble: pulls the lever once, spending one of the open Domain's free re-spins.
   * Three odd digits are a regular jackpot; three even digits or 7-7-7 a golden one. A final
   * whiff shatters the Domain, costs max HP and feeds the pity counter for the next cast.
   * Spinning is a free action: it does not end the turn.
   */
  spinPachinko(playerId: PlayerId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.preflight(now, events);
    if (gate) return this.reject(gate, events);
    const block = this.actionBlock(playerId, now);
    if (block) return this.reject(block, events);

    const player = this.playerState(playerId);
    if (player.pachinko.spinsLeft <= 0) return this.reject('NO_SPINS', events);

    const reels = this.rollPachinkoReels(player.pachinko.pity);
    const spinsLeft = player.pachinko.spinsLeft - 1;
    const rolled = pachinkoTier(reels);
    let outcome: PachinkoTier = rolled;
    let pity = player.pachinko.pity;
    if (rolled === 'MISS' && spinsLeft === 0) {
      outcome = 'BANKRUPT';
      pity = Math.min(1, pity + GAME_CONSTANTS.PACHINKO_PITY_STEP);
    } else if (rolled !== 'MISS') {
      pity = 0;
    }
    const remaining = outcome === 'MISS' ? spinsLeft : 0;
    const golden = outcome === 'GOLDEN' || outcome === 'SUPREME';
    const jackpot = outcome === 'REGULAR' || outcome === 'GOLDEN' || outcome === 'SUPREME' ? outcome : null;
    player.pachinko = { spinsLeft: remaining, pity, resetOnExpiry: golden, ...(jackpot ? { jackpot } : {}) };

    events.push({
      type: 'PACHINKO_SPUN',
      playerId,
      reels,
      tier: outcome,
      spinsLeft: remaining,
      pity,
    });

    if (outcome === 'BANKRUPT') {
      if (player.activeDomain) {
        events.push({ type: 'DOMAIN_EXPIRED', playerId, domainId: player.activeDomain.domainId });
        player.activeDomain = null;
      }
      const backlash = Math.round(maxHpOf(player) * GAME_CONSTANTS.PACHINKO_BANKRUPT_MAX_HP_FRACTION);
      player.hp = Math.max(1, player.hp - backlash);
      events.push({ type: 'GAMBLE_RESOLVED', playerId, won: false, amount: backlash });
    } else if (outcome === 'REGULAR' || golden) {
      const turns = golden ? GAME_CONSTANTS.PACHINKO_GOLDEN_JACKPOT_TURNS : GAME_CONSTANTS.PACHINKO_REGULAR_JACKPOT_TURNS;
      this.applyStatus(player, player, { status: STATUS_KIND.IMMORTAL, value: 1, turns }, now, events);
      if (golden) {
        this.applyStatus(
          player,
          player,
          { status: STATUS_KIND.DAMAGE_BOOST, value: GAME_CONSTANTS.PACHINKO_GOLDEN_DAMAGE_MULTIPLIER, turns },
          now,
          events,
        );
      } else {
        this.applyStatus(
          player,
          player,
          { status: STATUS_KIND.CE_LOCKED, value: GAME_CONSTANTS.MAX_CURSED_ENERGY, turns },
          now,
          events,
        );
      }
    }

    this.syncLockedEnergy(player);
    this.settleBoards(now, events);
    return this.accept(events);
  }

  /** Rolls three reels. Pity makes a spin more likely to be forced into a triple. */
  private rollPachinkoReels(pity: number): number[] {
    if (this.forcedReels) return [...this.forcedReels];
    const symbol = (): number => 1 + Math.floor(randomUnit(this.rng) * GAME_CONSTANTS.PACHINKO_REELS);
    if (randomUnit(this.rng) < pity) {
      const forced = symbol();
      return [forced, forced, forced];
    }
    return [symbol(), symbol(), symbol()];
  }

  /** The victim answers a Deadly Sentencing prompt: `escape` spends 100 CE to neutralize it, otherwise the trial begins. */
  answerEscape(playerId: PlayerId, escape: boolean, now: number): EngineResult {
    const events: GameEvent[] = [];
    const syncError = this.advance(now, events);
    if (syncError) return this.reject(syncError, events);
    if (this.isOver()) return this.reject('GAME_OVER', events);

    const prompt = this.escapeWindow;
    if (!prompt) return this.reject('NO_ESCAPE_WINDOW', events);
    if (playerId !== prompt.victimId) return this.reject('NOT_YOUR_TURN', events);

    if (escape) {
      const victim = this.playerState(prompt.victimId);
      if (victim.cursedEnergy < GAME_CONSTANTS.COURTROOM_ESCAPE_COST) return this.reject('INSUFFICIENT_CE', events);
      victim.cursedEnergy = clampCursedEnergy(victim.cursedEnergy - GAME_CONSTANTS.COURTROOM_ESCAPE_COST);
      this.playerState(prompt.casterId).activeDomain = null;
      this.escapeWindow = null;
      events.push({ type: 'SENTENCING_NEUTRALIZED', casterId: prompt.casterId, victimId: prompt.victimId });
      this.resumeClock(now);
    } else {
      this.escapeWindow = null;
      this.openCourtroom(prompt.casterId, prompt.victimId, prompt.rounds, now, events);
    }
    return this.accept(events);
  }

  /** The victim names a face-down slot in the trial. A wrong pick seals one of their hidden cards. */
  pickCourtroomSlot(playerId: PlayerId, slot: number, now: number): EngineResult {
    const events: GameEvent[] = [];
    const syncError = this.advance(now, events);
    if (syncError) return this.reject(syncError, events);
    if (this.isOver()) return this.reject('GAME_OVER', events);

    const trial = this.courtroom;
    if (!trial) return this.reject('NO_COURTROOM', events);
    if (playerId !== trial.victimId) return this.reject('NOT_YOUR_TURN', events);
    if (trial.phase !== COURTROOM_PHASE.PICK) return this.reject('COURTROOM_BUSY', events);
    if (!Number.isInteger(slot) || slot < 0 || slot >= trial.slots.length) return this.reject('INVALID_SLOT', events);

    this.resolvePick(trial, playerId, slot, now, events);
    return this.accept(events);
  }

  /**
   * The prosecutor names the subject the victim must locate. Only the caster may do this, and
   * only while the prosecution is open; the Judgeman then moves on to the victim's pick.
   */
  chooseProsecution(playerId: PlayerId, subject: CardSubjectId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const syncError = this.advance(now, events);
    if (syncError) return this.reject(syncError, events);
    if (this.isOver()) return this.reject('GAME_OVER', events);

    const trial = this.courtroom;
    if (!trial) return this.reject('NO_COURTROOM', events);
    if (playerId !== trial.casterId) return this.reject('NOT_YOUR_TURN', events);
    if (trial.phase !== COURTROOM_PHASE.PROSECUTE) return this.reject('COURTROOM_BUSY', events);
    if (!trial.slots.includes(subject)) return this.reject('INVALID_SUBJECT', events);

    this.beginPick(trial, now, subject);
    return this.accept(events);
  }

  getPublicView(): PublicMatchView {
    const boards: PublicBoardView[] = [...this.boards.entries()].map(([boardId, cards]) => ({
      boardId,
      ownerId: boardId === SHARED_BOARD_ID ? null : boardId,
      cards: cards.map((card, index) => toPublicCard(card, index, this.xRay)),
    }));

    const activeAttempt = this.turnBased ? this.attempt(this.turnOwner()) : null;

    return {
      matchId: this.matchId,
      boardMode: this.mode,
      phase: this.phase,
      turnOwner: this.turnBased ? this.turnOwner() : null,
      turnNumber: this.turnNumber,
      turnDeadline: this.turnBased && !this.sandbox ? this.turnDeadline : null,
      // The bar must scale against the budget this turn actually has, not a flat value.
      turnTimeMs: !this.turnBased
        ? calculateTurnDuration(this.turnNumber)
        : this.sandbox
          ? null
          : this.turnTimeFor(this.playerState(this.turnOwner())),
      openFirstId: activeAttempt?.openCards[0] ?? null,
      pending: activeAttempt ? this.publicPending(activeAttempt.pending) : null,
      cycles: this.turnBased ? this.turnNumber : this.cycleCount,
      players: this.playerIds.map((id) => {
        const player = this.playerState(id);
        return {
          id: player.id,
          characterId: player.characterId,
          hp: player.hp,
          maxHp: maxHpOf(player),
          shield: player.shield,
          cursedEnergy: player.cursedEnergy,
          comboStreak: player.comboStreak,
          pairsMatched: player.pairsMatched,
          activeEffects: player.activeEffects,
          activeDomain: player.activeDomain,
          activeSimpleDomain: player.activeSimpleDomain,
          pachinko: player.pachinko,
          stunnedUntil: player.stunUntil,
          flipLimit: this.flipLimitFor(player),
          executioner: player.executioner
            ? { damage: player.executioner.damage, turnsRemaining: player.executioner.turnsRemaining }
            : null,
        };
      }),
      boards,
      board: boards[0]?.cards ?? [],
      sentencing: this.publicSentencing(),
      awakening: this.awakening,
      attempts: this.playerIds.map((id) => this.publicAttempt(id)),
      result: this.result,
    };
  }

  // ---------------------------------------------------------------------------
  // Training ground controls (sandbox only)
  // ---------------------------------------------------------------------------

  /**
   * Debug controls. Each one is refused outside a sandbox match, so a competitive
   * game can never be doctored from the toolbar.
   */

  /** Adds cursed energy (clamped to the 0..100 pool). */
  sandboxFillEnergy(playerId: PlayerId, amount: number, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);

    const player = this.playerState(playerId);
    const before = player.cursedEnergy;
    player.cursedEnergy = clampCursedEnergy(before + Math.max(0, Math.round(amount)));
    events.push({ type: 'CE_CHANGED', playerId, delta: player.cursedEnergy - before, cause: 'SANDBOX' });
    this.syncLockedEnergy(player);
    events.push(this.debug('ENERGY', playerId, `${player.cursedEnergy}/${GAME_CONSTANTS.MAX_CURSED_ENERGY} CE`));
    return this.accept(events);
  }

  /** Arms the very next match as a Black Flash. */
  sandboxArmBlackFlash(playerId: PlayerId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);

    const player = this.playerState(playerId);
    this.applyStatus(player, player, { status: STATUS_KIND.FLASH_WINDOW, value: 1, turns: 1 }, now, events);
    events.push(this.debug('FLASH_READY', playerId, 'next match is a guaranteed Black Flash'));
    return this.accept(events);
  }

  /** Grants barrier points to either fighter, so piercing can be tested against one. */
  sandboxGrantBarrier(targetId: PlayerId, amount: number, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(targetId, now, events);
    if (gate) return this.reject(gate, events);

    const target = this.playerState(targetId);
    const added = grantShield(target, Math.max(0, Math.round(amount)));
    events.push({
      type: 'STATUS_APPLIED',
      playerId: target.id,
      sourceId: target.id,
      status: STATUS_KIND.SHIELD,
      value: added,
      turnsRemaining: null,
    });
    events.push(this.debug('BARRIER', target.id, `${target.shield} barrier (ceiling ${shieldCapOf(target)})`));
    return this.accept(events);
  }

  /**
   * Deals a lore synergy pair face-up and resolves it through the normal pipeline, so
   * the cue, the effects and the follow-up state are exactly what playing the pair
   * produces. When the grid does not already hold that pair the two cards are rebuilt
   * in place: a debug control has to produce the state it promises.
   */
  sandboxSpawnSynergy(playerId: PlayerId, synergyId: SynergyId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);
    const attempt = this.attempt(playerId);
    if (attempt.pending) return this.reject('EVALUATING', events);

    const player = this.playerState(playerId);
    const synergy = SYNERGIES[synergyId];
    const board = this.boardFor(playerId);
    const pair = this.sandboxPairFor(board, synergy.id, synergy.subjects);
    if (pair === null) return this.reject('CARD_NOT_FOUND', events);

    for (const card of pair) {
      card.state = CARD_STATE.REVEALED;
      card.revealedBy = playerId;
      events.push({ type: 'CARD_REVEALED', playerId, cardId: card.id });
    }
    attempt.openCards = [pair[0].id, pair[1].id];
    if (this.turnBased) {
      // Walk the real phases a two-card flip would walk, so every transition stays legal.
      this.transition(PHASE_BY_SEAT[this.turnOwnerSeat].FIRST, events);
      this.transition(PHASE_BY_SEAT[this.turnOwnerSeat].SECOND, events);
    }
    this.evaluateIfReady(player, board, now, events);
    events.push(this.debug('SPAWN_SYNERGY', playerId, `${synergy.name}: ${synergy.subjects.join(' + ')}`));
    this.settleBoards(now, events);
    return this.accept(events);
  }

  /** Re-deals every grid with a fresh shuffle. Players, HP, CE and statuses are untouched. */
  sandboxReshuffle(now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(this.playerIds[0], now, events);
    if (gate) return this.reject(gate, events);

    for (const [boardId] of [...this.boards.entries()]) {
      this.boards.set(boardId, this.dealBoard(boardId));
      // Scouting windows and selections refer to cards of the old deal.
      this.dropHideTimersFor(boardId);
      for (const playerId of this.playerIds) {
        if (this.boardIdFor(playerId) !== boardId) continue;
        const attempt = this.attempt(playerId);
        attempt.openCards = [];
        attempt.pending = null;
      }
      events.push({
        type: 'BOARD_RESPAWNED',
        boardId,
        ownerId: boardId === SHARED_BOARD_ID ? null : boardId,
        cardCount: this.board(boardId).length,
      });
    }
    this.sandboxResetPhase(events);
    events.push(this.debug('RESHUFFLE', null, 'every grid re-dealt'));
    return this.accept(events);
  }

  /**
   * Wipes stuns, statuses and open domains from both fighters. The training dummy's
   * immortality is part of the mode, not a buff, so the wipe keeps it: a cleared
   * dummy must still be impossible to knock out.
   */
  sandboxClearStatuses(now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(this.playerIds[0], now, events);
    if (gate) return this.reject(gate, events);

    for (const playerId of this.playerIds) {
      const player = this.playerState(playerId);
      player.activeEffects = [];
      player.stunUntil = 0;
      player.activeDomain = null;
      player.activeSimpleDomain = null;
      if (playerId === this.dummyId) player.activeEffects.push(this.immortality(playerId));
      events.push(this.debug('CLEAR_STATUSES', playerId, 'statuses, stuns and domains cleared'));
    }
    return this.accept(events);
  }

  /** Training ground: the dummy fights as another fighter, with that fighter's skill, ultimate and Domain. */
  debugSetDummyCharacter(characterId: CharacterId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const dummyId = this.dummyId;
    if (dummyId === null) return this.reject('NOT_SANDBOX', events);
    const gate = this.sandboxGate(dummyId, now, events);
    if (gate) return this.reject(gate, events);
    if (!(characterId in CHARACTERS)) return this.reject('INVALID_CHARACTER', events);

    const dummy = this.playerState(dummyId);
    dummy.characterId = characterId;
    // A Domain or Simple Domain belongs to the fighter who opened it, so the swap closes both.
    dummy.activeDomain = null;
    dummy.activeSimpleDomain = null;
    events.push(this.debug('DUMMY', dummyId, `now fights as ${characterId}`));
    return this.accept(events);
  }

  /**
   * Training ground: casts the skill or the Domain at full cursed energy, through the normal
   * activation rules. The cast can still be refused by a gate such as a stun or an open Domain.
   */
  debugForceCast(playerId: PlayerId, skillKey: 'skill1' | 'domain', now: number): EngineResult {
    if (!this.sandbox) return this.reject('NOT_SANDBOX', []);
    if (!this.playerIds.includes(playerId)) return this.reject('UNKNOWN_PLAYER', []);
    const player = this.playerState(playerId);
    player.cursedEnergy = GAME_CONSTANTS.MAX_CURSED_ENERGY;
    this.syncLockedEnergy(player);
    return skillKey === 'skill1' ? this.activateSkill(playerId, now) : this.activateUltimate(playerId, now);
  }

  /**
   * Training ground: the caster's next Idle Death Gamble spin lands on the chosen tier and
   * then resolves through the normal rules. WHIFF is a miss on the last spin, the bankrupt.
   */
  debugForceHakariTier(playerId: PlayerId, tier: 'REGULAR' | 'GOLDEN' | 'WHIFF', now: number): EngineResult {
    if (!this.sandbox) return this.reject('NOT_SANDBOX', []);
    if (!this.playerIds.includes(playerId)) return this.reject('UNKNOWN_PLAYER', []);
    const player = this.playerState(playerId);
    player.pachinko = {
      ...player.pachinko,
      spinsLeft: tier === 'WHIFF' ? 1 : Math.max(1, player.pachinko.spinsLeft),
    };
    this.forcedReels = FORCED_HAKARI_REELS[tier];
    try {
      return this.spinPachinko(playerId, now);
    } finally {
      this.forcedReels = null;
    }
  }

  /** Training ground: arms the caster's two-turn Simple Domain window, exactly as its own ultimate would. */
  debugArmSimpleDomain(playerId: PlayerId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);

    const player = this.playerState(playerId);
    const ultimateId = ULTIMATES[CHARACTERS[player.characterId].ultimateId].id;
    player.activeSimpleDomain = { ultimateId, turnsRemaining: 2 };
    events.push(this.debug('SIMPLE_DOMAIN', playerId, `${ultimateId}: two turns of Simple Domain`));
    return this.accept(events);
  }

  /** Training ground: breaks the caster's active Domain at once. */
  debugBreakDomain(playerId: PlayerId, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);

    const player = this.playerState(playerId);
    if (player.activeDomain) {
      events.push({ type: 'DOMAIN_EXPIRED', playerId, domainId: player.activeDomain.domainId });
      player.activeDomain = null;
    }
    events.push(this.debug('BREAK_DOMAIN', playerId, 'active Domain broken'));
    return this.accept(events);
  }

  /** Training ground: sets current HP, kept between 1 and the match maximum. */
  debugSetHp(playerId: PlayerId, hp: number, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);

    const player = this.playerState(playerId);
    const next = Math.max(1, Math.min(player.maxHp, Math.round(hp)));
    // Strict state diffing: an unchanged HP is not an event. The dock can be clicked as
    // often as the player likes without writing a new "1/100 HP" line each time, and the
    // presentation layer only ever hears about health that actually moved.
    if (next === player.hp) return this.accept(events);
    player.hp = next;
    events.push(this.debug('HP', playerId, `${player.hp}/${player.maxHp} HP`));
    return this.accept(events);
  }

  /**
   * Training ground: spawns a trap on one unflipped pair. A trap is a single card, so both
   * cards of the pair become traps: the grid stays clearable.
   */
  debugSpawnTrap(playerId: PlayerId, trapId: keyof typeof TRAPS, now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);
    const trap = TRAPS[trapId];
    if (!trap) return this.reject('INVALID_TRAP', events);
    const attempt = this.attempt(playerId);
    if (attempt.pending) return this.reject('EVALUATING', events);
    if (attempt.openCards.length > 0) return this.reject('FLIP_IN_PROGRESS', events);

    const board = this.boardFor(playerId);
    const hiddenPairs = board.filter(
      (card) =>
        card.state === CARD_STATE.HIDDEN &&
        card.type !== CARD_TYPE.TRAP &&
        board.filter((other) => other.pairId === card.pairId && other.state === CARD_STATE.HIDDEN).length === 2,
    );
    const pick = hiddenPairs[Math.floor(randomUnit(this.rng) * hiddenPairs.length)];
    if (!pick) return this.reject('CARD_UNAVAILABLE', events);
    for (const card of board.filter((other) => other.pairId === pick.pairId)) {
      const index = board.indexOf(card);
      board[index] = {
        ...card,
        pairId: `trap:${trap.id}:${card.id}`,
        type: CARD_TYPE.TRAP,
        characterId: trap.subject,
        trapId: trap.id,
        revealedBy: null,
      };
    }
    events.push(this.debug('TRAP', playerId, `${trap.id} spawned on a pair`));
    return this.accept(events);
  }

  /** Training ground: the spec's name for arming the next hit as a Kokusen. */
  debugSetNextHitBlackFlash(playerId: PlayerId, now: number): EngineResult {
    return this.sandboxArmBlackFlash(playerId, now);
  }

  /**
   * Training ground: plants one hazard on a random hidden card of the caster's own grid, the way
   * a skill would, so it detonates on whoever flips that card.
   */
  debugPlantHazard(
    playerId: PlayerId,
    hazard: 'LAVA' | 'NAILED' | 'LOCKED' | 'FLESH',
    now: number,
  ): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(playerId, now, events);
    if (gate) return this.reject(gate, events);
    const kind = CARD_EFFECT_KIND[hazard];
    const candidates = this.boardFor(playerId).filter(
      (card) =>
        card.state === CARD_STATE.HIDDEN && card.type !== CARD_TYPE.TRAP && !hasModifier(card, kind),
    );
    const card = candidates[Math.floor(randomUnit(this.rng) * candidates.length)];
    if (!card) return this.reject('CARD_UNAVAILABLE', events);
    const turnsRemaining = hazard === 'LOCKED' ? GAME_CONSTANTS.CONFISCATED_TURNS : null;
    card.effectModifiers.push({ kind, sourceId: playerId, turnsRemaining });
    events.push({
      type: 'CARD_MODIFIED',
      sourceId: playerId,
      boardId: this.boardIdFor(playerId),
      cardIds: [card.id],
      modifier: kind,
      turnsRemaining,
    });
    events.push(this.debug('TRAP', playerId, `${hazard} planted on a hidden card`));
    return this.accept(events);
  }

  /** Training ground: toggles the X-ray. Returns whether it is now on; always off outside a sandbox. */
  debugToggleXRay(): boolean {
    if (!this.sandbox) return false;
    this.xRay = !this.xRay;
    return this.xRay;
  }

  /**
   * Training ground: re-deals the match onto one shared grid or one grid per fighter, without
   * leaving the match. Refused while a sentencing or an Awakening Surge waits on a grid.
   */
  debugSwitchBoardLayout(layout: 'shared' | 'dual', now: number): EngineResult {
    const events: GameEvent[] = [];
    const gate = this.sandboxGate(this.playerIds[0], now, events);
    if (gate) return this.reject(gate, events);
    if (this.escapeWindow) return this.reject('SENTENCING_IN_PROGRESS', events);
    if (this.courtroom) return this.reject('SENTENCING_IN_PROGRESS', events);
    if (this.awakening) return this.reject('AWAKENING_IN_PROGRESS', events);

    const dual = layout === 'dual';
    if (dual === this.dualBoards) return this.accept(events);
    for (const boardId of this.boards.keys()) this.dropHideTimersFor(boardId);
    this.dualBoards = dual;
    this.mode = dual ? BOARD_MODE.DUAL : BOARD_MODE.SHARED;
    this.boards.clear();
    const boardIds: readonly BoardId[] = dual ? this.playerIds : [SHARED_BOARD_ID];
    for (const boardId of boardIds) this.boards.set(boardId, this.dealBoard(boardId));
    for (const playerId of this.playerIds) {
      const attempt = this.attempt(playerId);
      attempt.openCards = [];
      attempt.pending = null;
    }
    for (const boardId of boardIds) {
      events.push({
        type: 'BOARD_RESPAWNED',
        boardId,
        ownerId: dual ? boardId : null,
        cardCount: this.board(boardId).length,
      });
    }
    this.sandboxResetPhase(events);
    events.push(this.debug('LAYOUT', null, dual ? 'dual boards' : 'shared board'));
    return this.accept(events);
  }

  /** The dummy's unkillable marker, shared by setup and the status wipe. */
  private immortality(playerId: PlayerId): StatusEffect {
    return { kind: STATUS_KIND.IMMORTAL, sourceId: playerId, turnsRemaining: null, value: 1 };
  }

  private debug(action: DebugAction, playerId: PlayerId | null, detail: string): DebugEvent {
    return { type: 'DEBUG_ACTION', action, playerId, detail };
  }

  private sandboxGate(playerId: PlayerId, now: number, events: GameEvent[]): EngineErrorCode | null {
    if (!this.sandbox) return 'NOT_SANDBOX';
    const gate = this.preflight(now, events);
    if (gate) return gate;
    return this.playerIds.includes(playerId) ? null : 'UNKNOWN_PLAYER';
  }

  /** The two cards that will become the spawned synergy pair, rebuilt to share its id. */
  private sandboxPairFor(
    board: Card[],
    synergyId: SynergyId,
    subjects: readonly [CardSubjectId, CardSubjectId],
  ): [Card, Card] | null {
    const pairId = `${SYNERGY_PAIR_PREFIX}${synergyId}`;
    const chosen: number[] = [];
    for (const subject of subjects) {
      const depicted = board.findIndex((card, index) => card.characterId === subject && !chosen.includes(index));
      const spare = board.findIndex(
        (card, index) =>
          !chosen.includes(index) && card.type === CARD_TYPE.STANDARD && card.state === CARD_STATE.HIDDEN,
      );
      const index = depicted >= 0 ? depicted : spare;
      if (index >= 0) chosen.push(index);
    }
    const [firstIndex, secondIndex] = chosen;
    const firstSubject = subjects[0];
    const secondSubject = subjects[1];
    if (firstIndex === undefined || secondIndex === undefined) return null;
    return [
      this.rebrand(board, firstIndex, pairId, firstSubject),
      this.rebrand(board, secondIndex, pairId, secondSubject),
    ];
  }

  /** Rebuilds a card in place as one face of the spawned pair, keeping its id. */
  private rebrand(board: Card[], index: number, pairId: PairId, subject: CardSubjectId): Card {
    const card = board[index];
    if (!card) throw new Error(`invariant: no card at position ${index}`);
    const rebranded: Card = {
      ...card,
      pairId,
      characterId: subject,
      type: CARD_TYPE.SYNERGY,
      trapId: null,
      state: CARD_STATE.HIDDEN,
      revealedBy: null,
    };
    board[index] = rebranded;
    return rebranded;
  }

  /** Puts the turn FSM back in a phase where the turn owner may act again. */
  private sandboxResetPhase(events: GameEvent[]): void {
    if (!this.turnBased) return;
    const steps = PHASE_BY_SEAT[this.turnOwnerSeat];
    if (this.phase === steps.WAIT) return;
    if (canTransition(this.phase, steps.WAIT)) {
      this.transition(steps.WAIT, events);
      return;
    }
    // FIRST/SECOND cannot jump straight back to WAIT; step down the legal path.
    if (canTransition(this.phase, steps.FIRST)) this.transition(steps.FIRST, events);
    if (canTransition(this.phase, steps.WAIT)) this.transition(steps.WAIT, events);
  }

  // ---------------------------------------------------------------------------
  // Time sync and turn flow
  // ---------------------------------------------------------------------------

  /** Shared gate for commands: handles not-started/over states and applies due time events. */
  private preflight(now: number, events: GameEvent[]): EngineErrorCode | null {
    if (this.phase === TURN_PHASE.MATCH_START) return 'NOT_STARTED';
    if (this.isOver()) return 'GAME_OVER';
    const syncError = this.advance(now, events);
    if (syncError) return syncError;
    if (this.isOver()) return 'GAME_OVER';
    if (this.sentencingActive()) return 'SENTENCING_IN_PROGRESS';
    return this.awakening === null ? null : 'AWAKENING_IN_PROGRESS';
  }

  private advance(now: number, events: GameEvent[]): EngineErrorCode | null {
    if (!isValidTimestamp(now)) return 'INVALID_TIME';
    if (this.clock === null) return 'NOT_STARTED';
    if (now < this.clock) return 'TIME_REGRESSED';
    this.clock = now;

    for (const playerId of this.playerIds) {
      const attempt = this.attempt(playerId);
      if (attempt.pending && now >= attempt.pending.resolveAt) {
        this.finishEvaluation(this.playerState(playerId), now, events);
        if (this.isOver()) return null;
      }
    }

    this.flushHideTimers(now, events);
    this.advanceEscape(now, events);
    this.advanceCourtroom(now, events);
    this.advanceAwakening(now, events);

    // The turn clock stands still while a Deadly Sentencing or Awakening Surge plays out (see pauseClock).
    if (this.turnBased && !this.sandbox && !this.isOver() && !this.clockHeld() && this.isAwaitingAction()) {
      const deadline = this.turnDeadline;
      if (deadline !== null && now >= deadline) {
        const owner = this.playerState(this.turnOwner());
        events.push({ type: 'TURN_TIMED_OUT', playerId: owner.id });
        this.abandonOpenCards(owner, events);
        this.closePlayerTurn(owner, now, events);
        if (this.isOver()) return null;
        events.push({ type: 'TURN_ENDED', playerId: owner.id, reason: 'TIMEOUT' });
        this.passTurn(now, events);
      }
    }
    return null;
  }

  /** Runs when an evaluation window closes: hides a mismatch or keeps the turn after a match. */
  private finishEvaluation(player: PlayerState, now: number, events: GameEvent[]): void {
    const attempt = this.attempt(player.id);
    const pending = attempt.pending;
    if (!pending) return;
    attempt.pending = null;
    attempt.openCards = [];

    if (pending.outcome === 'MISMATCH') {
      for (const cardId of pending.cardIds) this.hideCard(cardId, events);
      this.closePlayerTurn(player, now, events);
      if (this.isOver()) return;
      if (this.turnBased && !this.sandbox) {
        events.push({ type: 'TURN_ENDED', playerId: player.id, reason: 'MISMATCH' });
        this.passTurn(now, events);
      } else if (this.sandbox) {
        // The dummy never plays, so a missed pair just hands the grid straight back.
        this.transition(PHASE_BY_SEAT[this.turnOwnerSeat].WAIT, events);
      }
      return;
    }

    if (this.turnBased) {
      // A match keeps the same player on turn with a fresh time budget for the next attempt.
      if (!this.sandbox) this.turnDeadline = now + this.turnTimeFor(player);
      this.transition(PHASE_BY_SEAT[this.turnOwnerSeat].WAIT, events);
    }
  }

  /**
   * Resolves a completed attempt once a matching pair appears or the flip limit is reached.
   *
   * The cards judged are exactly the ones in the explicit selection (`openCards`), pulled
   * through the live grid. Traps, scouting reveals and the opponent's flips never enter it,
   * so the length of the selection is what decides the attempt, not the number of face-up
   * cards on the board.
   */
  private evaluateIfReady(player: PlayerState, board: readonly Card[], now: number, events: GameEvent[]): void {
    const attempt = this.attempt(player.id);
    const opened = attempt.openCards
      .map((id) => board.find((card) => card.id === id))
      .filter((card): card is Card => card !== undefined && card.state === CARD_STATE.REVEALED);

    // Drop anything that is no longer part of a live selection (a respawn or a forced
    // hide), so a stale id can never hold the attempt open forever.
    if (opened.length !== attempt.openCards.length) {
      attempt.openCards = opened.map((card) => card.id);
      if (opened.length === 0) {
        if (this.turnBased) this.transition(PHASE_BY_SEAT[this.turnOwnerSeat].WAIT, events);
        return;
      }
    }
    if (opened.length < GAME_CONSTANTS.BASE_FLIP_LIMIT) return;

    const pair = this.findMatchingPair(opened);
    if (pair === null && opened.length < this.flipLimitFor(player)) return;

    if (pair !== null) {
      for (const card of opened) {
        if (card !== pair[0] && card !== pair[1]) {
          card.state = CARD_STATE.HIDDEN;
          card.revealedBy = null;
          events.push({ type: 'CARD_HIDDEN', cardId: card.id });
        }
      }
      this.resolveMatch(player, pair[0], pair[1], opened, now, events);
    } else {
      this.resolveMismatch(player, opened, now, events);
    }
    if (this.turnBased) this.transition(TURN_PHASE.EVALUATING, events);
  }

  /** Resolves a successful pair: damage, CE, streaks, lore synergy, then the evaluation window. */
  private resolveMatch(
    player: PlayerState,
    first: Card,
    second: Card,
    opened: readonly Card[],
    now: number,
    events: GameEvent[],
  ): void {
    first.state = CARD_STATE.MATCHED;
    second.state = CARD_STATE.MATCHED;

    // A Latent Black Flash blessing is spent on the first pair this player matches afterwards.
    const blackFlash =
      player.guaranteedBlackFlash || isBlackFlash(player.comboStreak, this.blackFlashThreshold(player));
    player.guaranteedBlackFlash = false;
    this.lastMatcherId = player.id;
    player.comboStreak += 1;
    player.pairsMatched += 1;

    const effects = calculateMatchEffects({
      cardType: first.type,
      blackFlash,
      attackerStatuses: player.activeEffects,
      domainActive: this.domainActiveFor(player),
    });
    player.cursedEnergy = clampCursedEnergy(player.cursedEnergy + effects.ceGain);
    events.push({ type: 'CE_CHANGED', playerId: player.id, delta: effects.ceGain, cause: 'MATCH' });

    // Consumed on use: a guaranteed critical and a Divergent Fist mark.
    player.activeEffects = removeStatus(player.activeEffects, STATUS_KIND.CRITICAL_STRIKE);
    if (hasStatus(player.activeEffects, STATUS_KIND.DIVERGENT_MARK)) {
      const mark = statusValue(player.activeEffects, STATUS_KIND.DIVERGENT_MARK);
      player.activeEffects = removeStatus(player.activeEffects, STATUS_KIND.DIVERGENT_MARK);
      player.activeEffects.push({
        kind: STATUS_KIND.SHOCKWAVE,
        sourceId: player.id,
        turnsRemaining: 1,
        value: mark,
      });
    }

    const healed = heal(player, effects.healing, maxHpOf(player));
    if (healed > 0) events.push({ type: 'HEALED', playerId: player.id, amount: healed });
    // Black Flash raises a barrier on top of the heal, so a Kokusen both restores HP
    // and leaves something for the next trade to chew through.
    const barrier = grantShield(player, effects.shieldGain);
    if (barrier > 0) {
      events.push({
        type: 'STATUS_APPLIED',
        playerId: player.id,
        sourceId: player.id,
        status: STATUS_KIND.SHIELD,
        value: barrier,
        turnsRemaining: null,
      });
    }
    if (blackFlash) events.push({ type: 'BLACK_FLASH', playerId: player.id, streak: player.comboStreak });

    // Hakari's Gamble Turn: a won gamble doubles the strike and refunds CE. Golden jackpots
    // (DAMAGE_BOOST) multiply every match strike while they last.
    const gamble = hasStatus(player.activeEffects, STATUS_KIND.GAMBLE_TURN);
    if (gamble) {
      player.activeEffects = removeStatus(player.activeEffects, STATUS_KIND.GAMBLE_TURN);
      player.cursedEnergy = clampCursedEnergy(player.cursedEnergy + GAME_CONSTANTS.GAMBLE_REFUND_CE);
      events.push({ type: 'CE_CHANGED', playerId: player.id, delta: GAME_CONSTANTS.GAMBLE_REFUND_CE, cause: 'MATCH' });
    }
    const boost = hasStatus(player.activeEffects, STATUS_KIND.DAMAGE_BOOST)
      ? statusValue(player.activeEffects, STATUS_KIND.DAMAGE_BOOST)
      : 1;
    const strike = Math.round(effects.damage * (gamble ? GAME_CONSTANTS.GAMBLE_DAMAGE_MULTIPLIER : 1) * boost);

    const target = this.playerState(this.opponentOf(player.id));
    const damage = applyDamage(target, strike, { piercing: effects.piercing });
    if (gamble) events.push({ type: 'GAMBLE_RESOLVED', playerId: player.id, won: true, amount: damage.dealt });
    events.push({
      type: 'DAMAGE_DEALT',
      sourceId: player.id,
      targetId: target.id,
      dealt: damage.dealt,
      absorbed: damage.absorbed,
      critical: effects.critical,
      piercing: effects.piercing,
      cause: DAMAGE_CAUSE.MATCH,
    });
    events.push({
      type: 'PAIR_MATCHED',
      playerId: player.id,
      pairId: first.pairId,
      cardIds: [first.id, second.id],
      cardType: first.type,
    });

    const synergy = synergyByPairId(first.pairId);
    if (synergy) {
      events.push({ type: 'SYNERGY_TRIGGERED', playerId: player.id, synergyId: synergy.id, cue: synergy.vfx });
      this.applyEffects(player, synergy.effects, now, events, 'SYNERGY');
    }

    this.syncLockedEnergy(player);
    this.attempt(player.id).pending = {
      outcome: 'MATCH',
      cardIds: opened.map((card) => card.id),
      resolveAt: now + GAME_CONSTANTS.MATCH_RESOLVE_MS,
    };
  }

  /** Resolves a failed attempt: penalties, resonance recoil, then the reveal window. */
  private resolveMismatch(player: PlayerState, opened: readonly Card[], now: number, events: GameEvent[]): void {
    player.comboStreak = 0;
    // A lost Gamble Turn backfires on the gambler, and the turn passes on as usual.
    if (hasStatus(player.activeEffects, STATUS_KIND.GAMBLE_TURN)) {
      player.activeEffects = removeStatus(player.activeEffects, STATUS_KIND.GAMBLE_TURN);
      const backlash = Math.round(maxHpOf(player) * GAME_CONSTANTS.GAMBLE_BACKLASH_MAX_HP_FRACTION);
      player.hp = Math.max(1, player.hp - backlash);
      events.push({ type: 'GAMBLE_RESOLVED', playerId: player.id, won: false, amount: backlash });
    }
    player.cursedEnergy = clampCursedEnergy(player.cursedEnergy - GAME_CONSTANTS.MISMATCH_CE_PENALTY);
    events.push({ type: 'CE_CHANGED', playerId: player.id, delta: -GAME_CONSTANTS.MISMATCH_CE_PENALTY, cause: 'MISMATCH' });
    events.push({ type: 'PAIR_MISMATCHED', playerId: player.id, cardIds: opened.map((card) => card.id) });

    for (const recoil of player.activeEffects.filter((effect) => effect.kind === STATUS_KIND.RESONANCE_RECOIL)) {
      const result = applyDamage(player, recoil.value);
      events.push({
        type: 'DAMAGE_DEALT',
        sourceId: recoil.sourceId,
        targetId: player.id,
        dealt: result.dealt,
        absorbed: result.absorbed,
        critical: false,
        piercing: false,
        cause: DAMAGE_CAUSE.RECOIL,
      });
    }

    this.syncLockedEnergy(player);
    this.attempt(player.id).pending = {
      outcome: 'MISMATCH',
      cardIds: opened.map((card) => card.id),
      resolveAt: now + GAME_PACING.MISMATCH_REVEAL_DURATION_MS,
    };
  }

  /**
   * End-of-turn bookkeeping for one player: delayed damage, statuses, modifiers, domain timer.
   *
   * `countStatuses: false` is used for a turn that was *skipped* (Unlimited Void): the
   * queued damage still lands and the domain still ages, but a status the victim never got
   * to spend is not consumed. That is what keeps Unlimited Void's "skip one turn, then rush
   * the next" working: the rushed-turn timer is waiting for the turn after the skip.
   */
  private closePlayerTurn(
    player: PlayerState,
    now: number,
    events: GameEvent[],
    options: { readonly countStatuses?: boolean } = {},
  ): void {
    this.cycleCount += 1;
    player.comboStreak = 0;
    this.resolveEndOfTurnDamage(player, events);
    if (options.countStatuses !== false) player.activeEffects = tickStatusTurn(player.activeEffects);
    this.tickCardModifiers(player.id);
    this.ageConfiscatedSeals(player.id);
    this.syncLockedEnergy(player);

    if (player.activeDomain) {
      const remaining = player.activeDomain.turnsRemaining - 1;
      if (remaining > 0) {
        player.activeDomain = { domainId: player.activeDomain.domainId, turnsRemaining: remaining };
      } else {
        events.push({ type: 'DOMAIN_EXPIRED', playerId: player.id, domainId: player.activeDomain.domainId });
        player.activeDomain = null;
      }
    }

    // Idle Death Gamble: unspent re-spins lapse with their Domain. A golden or supreme jackpot
    // resets the Domain once its immortality ends: any Domain still standing is cleared and the
    // Domain's CE cost is refunded, so it can be cast again.
    if (!player.activeDomain && player.pachinko.spinsLeft > 0) {
      player.pachinko = { ...player.pachinko, spinsLeft: 0 };
    }
    if (player.pachinko.jackpot && !hasStatus(player.activeEffects, STATUS_KIND.IMMORTAL)) {
      const { jackpot: _ended, ...rest } = player.pachinko;
      player.pachinko = rest;
    }
    if (player.pachinko.resetOnExpiry && !hasStatus(player.activeEffects, STATUS_KIND.IMMORTAL)) {
      player.pachinko = { ...player.pachinko, resetOnExpiry: false };
      if (player.activeDomain) {
        events.push({ type: 'DOMAIN_EXPIRED', playerId: player.id, domainId: player.activeDomain.domainId });
        player.activeDomain = null;
      }
      player.cursedEnergy = clampCursedEnergy(player.cursedEnergy + GAME_CONSTANTS.DOMAIN_CE_COST);
      events.push({ type: 'CE_CHANGED', playerId: player.id, delta: GAME_CONSTANTS.DOMAIN_CE_COST, cause: 'CARD_EFFECT' });
    }

    // A Simple Domain window ages like a domain does, so "2 turns of cover" means two
    // of its owner's turns and the anti-domain can never outlive its own cast by much.
    if (player.activeSimpleDomain) {
      const remaining = player.activeSimpleDomain.turnsRemaining - 1;
      if (remaining > 0) {
        player.activeSimpleDomain = { ultimateId: player.activeSimpleDomain.ultimateId, turnsRemaining: remaining };
      } else {
        events.push({
          type: 'SIMPLE_DOMAIN_CLOSED',
          playerId: player.id,
          ultimateId: player.activeSimpleDomain.ultimateId,
        });
        player.activeSimpleDomain = null;
      }
    }

    // Executioner's Sword lasts this many of its owner's turns after the one that granted it.
    const sword = player.executioner;
    if (sword?.graceClose) {
      player.executioner = { ...sword, graceClose: false };
    } else if (sword && sword.turnsRemaining > 1) {
      player.executioner = { ...sword, turnsRemaining: sword.turnsRemaining - 1 };
    } else if (sword) {
      // The sentence is spent: the caster's CE is wiped so a Domain cannot be chained right after.
      player.executioner = null;
      player.cursedEnergy = 0;
      this.releaseConfiscatedSeals(player.id);
      events.push({ type: 'EXECUTIONER_EXPIRED', playerId: player.id });
    }
  }

  /** Queued blasts and damage-over-time fire at the end of their owner's turn. */
  private resolveEndOfTurnDamage(player: PlayerState, events: GameEvent[]): void {
    const shockwaves = player.activeEffects.filter((effect) => effect.kind === STATUS_KIND.SHOCKWAVE);
    if (shockwaves.length > 0) {
      player.activeEffects = removeStatus(player.activeEffects, STATUS_KIND.SHOCKWAVE);
      const target = this.playerState(this.opponentOf(player.id));
      for (const wave of shockwaves) {
        const result = applyDamage(target, wave.value);
        events.push({
          type: 'DAMAGE_DEALT',
          sourceId: player.id,
          targetId: target.id,
          dealt: result.dealt,
          absorbed: result.absorbed,
          critical: false,
          piercing: false,
          cause: DAMAGE_CAUSE.SHOCKWAVE,
        });
      }
    }

    for (const burn of player.activeEffects.filter((effect) => effect.kind === STATUS_KIND.DAMAGE_OVER_TIME)) {
      const result = applyDamage(player, burn.value);
      events.push({
        type: 'DAMAGE_DEALT',
        sourceId: burn.sourceId,
        targetId: player.id,
        dealt: result.dealt,
        absorbed: result.absorbed,
        critical: false,
        piercing: false,
        cause: DAMAGE_CAUSE.OVER_TIME,
      });
    }
  }

  /** Ages every card modifier planted by `sourceId`, dropping the expired ones. */
  private tickCardModifiers(sourceId: PlayerId): void {
    for (const board of this.boards.values()) {
      for (const card of board) {
        if (card.effectModifiers.length === 0) continue;
        card.effectModifiers = card.effectModifiers.flatMap((modifier) => {
          // Confiscated seals age on their victim's turns instead (see ageConfiscatedSeals).
          if (modifier.sourceId !== sourceId || modifier.tickOwner !== undefined) return [modifier];
          if (modifier.turnsRemaining === null) return [modifier];
          const left = modifier.turnsRemaining - 1;
          return left > 0 ? [{ ...modifier, turnsRemaining: left }] : [];
        });
      }
    }
  }

  /** Ages the Confiscated seals on `victimId`'s cards by one of the victim's own turns. */
  private ageConfiscatedSeals(victimId: PlayerId): void {
    for (const board of this.boards.values()) {
      for (const card of board) {
        if (!card.effectModifiers.some((modifier) => modifier.tickOwner === victimId)) continue;
        card.effectModifiers = card.effectModifiers.flatMap((modifier) => {
          if (modifier.tickOwner !== victimId || modifier.turnsRemaining === null) return [modifier];
          const left = modifier.turnsRemaining - 1;
          return left > 0 ? [{ ...modifier, turnsRemaining: left }] : [];
        });
      }
    }
  }

  /** Lifts every Confiscated seal `casterId` planted, once the Executioner's Sword is spent. */
  private releaseConfiscatedSeals(casterId: PlayerId): void {
    for (const board of this.boards.values()) {
      for (const card of board) {
        if (!card.effectModifiers.some((modifier) => modifier.tickOwner !== undefined && modifier.sourceId === casterId)) {
          continue;
        }
        card.effectModifiers = card.effectModifiers.filter(
          (modifier) => !(modifier.tickOwner !== undefined && modifier.sourceId === casterId),
        );
      }
    }
  }

  /** Hides every scouting reveal whose window has closed. */
  private flushHideTimers(now: number, events: GameEvent[]): void {
    for (let i = this.hideTimers.length - 1; i >= 0; i--) {
      const timer = this.hideTimers[i];
      if (!timer || timer.at > now) continue;
      this.hideTimers.splice(i, 1);
      for (const cardId of timer.cardIds) this.hideCard(cardId, events);
    }
  }

  private hideCard(cardId: CardId, events: GameEvent[]): void {
    const card = this.cardById(cardId);
    if (!card || card.state !== CARD_STATE.REVEALED) return;
    // Invariant: a card the player has open in an active attempt is never hidden out
    // from under them. Only the resolution, a timeout or a respawn releases it.
    if (this.isSelected(cardId)) return;
    card.state = CARD_STATE.HIDDEN;
    card.revealedBy = null;
    events.push({ type: 'CARD_HIDDEN', cardId });
  }

  /** True when the card is part of any player's open selection. */
  private isSelected(cardId: CardId): boolean {
    for (const attempt of this.attempts.values()) {
      if (attempt.openCards.includes(cardId)) return true;
    }
    return false;
  }

  /** Drops the active player's unfinished first flip (timeout, or an abandoned attempt). */
  private abandonOpenCards(player: PlayerState, events: GameEvent[]): void {
    const attempt = this.attempt(player.id);
    // Release the selection first: an open card is protected from hiding while selected.
    const open = attempt.openCards;
    attempt.openCards = [];
    attempt.pending = null;
    for (const cardId of open) this.hideCard(cardId, events);
  }

  private passTurn(now: number, events: GameEvent[]): void {
    // Training ground: the turn never leaves the player.
    if (this.sandbox) return;
    this.turnOwnerSeat = this.turnOwnerSeat === 0 ? 1 : 0;
    this.turnNumber += 1;

    // Unlimited Void can strip several turns; each skip costs the victim one charge, and
    // the skipped turn still *closes* for them: end-of-turn damage, status timers, card
    // modifiers and the domain clock all advance, exactly as if they had played and
    // passed. Without this a skipped player keeps burn/shockwave damage queued and a
    // rushed-turn timer that never expires.
    for (let guard = 0; guard < MAX_TURN_SKIPS; guard++) {
      const next = this.playerState(this.turnOwner());
      if (statusValue(next.activeEffects, STATUS_KIND.SKIP_TURNS) <= 0) break;
      next.activeEffects = consumeStatus(next.activeEffects, STATUS_KIND.SKIP_TURNS, 1);
      events.push({ type: 'TURN_SKIPPED', playerId: next.id, reason: 'DOMAIN' });
      this.closePlayerTurn(next, now, events, { countStatuses: false });
      if (this.isOver()) return;
      this.turnOwnerSeat = this.turnOwnerSeat === 0 ? 1 : 0;
      this.turnNumber += 1;
    }

    this.turnDeadline = now + this.turnTimeFor(this.playerState(this.turnOwner()));
    this.transition(PHASE_BY_SEAT[this.turnOwnerSeat].WAIT, events);
    events.push({ type: 'TURN_STARTED', playerId: this.turnOwner(), turnNumber: this.turnNumber });
  }

  /**
   * Solo end condition: a knockout. A cleared grid does not end the match, so with both
   * fighters standing every exhausted grid is re-dealt instead (endless boards).
   */
  private settleBoards(now: number, events: GameEvent[]): void {
    if (this.isOver()) return;
    const first = this.playerState(this.playerIds[0]);
    const second = this.playerState(this.playerIds[1]);

    if (first.hp <= 0 || second.hp <= 0) {
      const winnerId = first.hp <= 0 && second.hp <= 0 ? null : first.hp <= 0 ? second.id : first.id;
      this.finish({ winnerId, reason: MATCH_END_REASON.KNOCKOUT, endedAt: now }, events);
      return;
    }

    this.respawnClearedBoards(now, events);
  }

  /**
   * Endless boards: every grid whose non-trap cards are all matched is re-dealt from a
   * fresh Fisher-Yates shuffle. Player HP, cursed energy, statuses, combo streaks, card
   * modifiers elsewhere and the active turn are all left strictly untouched, so the
   * clearing player carries their combo straight onto the new cards.
   */
  private respawnClearedBoards(now: number, events: GameEvent[]): void {
    const cleared = [...this.boards.entries()].filter(([, cards]) => isBoardCleared(cards));
    for (const [boardId] of cleared) {
      // A grid waiting on its clearer's blessing stays empty until that choice settles.
      if (this.awakening?.boardId === boardId) continue;
      const ownerId = boardId === SHARED_BOARD_ID ? null : boardId;
      events.push({ type: 'BOARD_CLEARED', boardId, ownerId });

      const clearerId = this.lastMatcherId;
      if (clearerId !== null) {
        this.openAwakening(boardId, clearerId, now, events);
      } else {
        this.dealFreshBoard(boardId, events);
      }
    }
  }

  /** Re-deals a grid from a fresh Fisher-Yates shuffle and returns the new cards. */
  private dealFreshBoard(boardId: BoardId, events: GameEvent[]): Card[] {
    const ownerId = boardId === SHARED_BOARD_ID ? null : boardId;
    const fresh = this.dealBoard(boardId);
    this.boards.set(boardId, fresh);

    // Scouting windows on the old cards must not hide cards of the new deal.
    this.dropHideTimersFor(boardId);
    // A half-finished attempt on this grid refers to cards that no longer exist.
    // The pending resolution is kept: it carries the ids of the pair just matched.
    for (const playerId of this.playerIds) {
      if (this.boardIdFor(playerId) === boardId) this.attempt(playerId).openCards = [];
    }

    events.push({ type: 'BOARD_RESPAWNED', boardId, ownerId, cardCount: fresh.length });
    return fresh;
  }

  /** Holds a cleared grid open until its clearer picks an Awakening Surge blessing. */
  private openAwakening(boardId: BoardId, playerId: PlayerId, now: number, events: GameEvent[]): void {
    if (this.clearReward === BOARD_CLEAR_REWARD.RANDOM_AUTO) {
      // Instant roll: the blessing lands at once and the turn clock never stops for it.
      const options = Object.values(BLESSING) as BlessingId[];
      const blessing = options[randomInt(this.rng, options.length)] ?? BLESSING.SORCERY_RESTORATION;
      this.resolveAwakening({ playerId, boardId }, blessing, false, true, now, events);
      return;
    }
    const delayMs =
      playerId === this.dummyId ? GAME_CONSTANTS.AWAKENING_AI_DELAY_MS : GAME_CONSTANTS.AWAKENING_DECISION_MS;
    const decideBy = now + delayMs;
    this.awakening = { playerId, boardId, decideBy };
    this.pauseClock(now);
    events.push({ type: 'AWAKENING_OPENED', playerId, boardId, decideBy });
  }

  /** The clearer of a board picks one of the three blessings. */
  chooseBlessing(playerId: PlayerId, blessing: BlessingId, now: number): EngineResult {
    const events: GameEvent[] = [];
    if (this.phase === TURN_PHASE.MATCH_START) return this.reject('NOT_STARTED', events);
    if (this.isOver()) return this.reject('GAME_OVER', events);
    const syncError = this.advance(now, events);
    if (syncError) return this.reject(syncError, events);
    if (this.isOver()) return this.reject('GAME_OVER', events);

    const awakening = this.awakening;
    if (awakening === null) return this.reject('NO_AWAKENING', events);
    if (awakening.playerId !== playerId) return this.reject('NOT_YOUR_AWAKENING', events);
    if (!Object.values(BLESSING).includes(blessing)) return this.reject('INVALID_BLESSING', events);

    this.resolveAwakening(awakening, blessing, false, false, now, events);
    return this.accept(events);
  }

  /** Past the decision window the clearer is given Sorcery Restoration. */
  private advanceAwakening(now: number, events: GameEvent[]): void {
    const awakening = this.awakening;
    if (awakening === null || now < awakening.decideBy) return;
    this.resolveAwakening(awakening, BLESSING.SORCERY_RESTORATION, true, false, now, events);
  }

  /**
   * Applies the chosen blessing, deals the held grid and gives the paused time back.
   * Runs on the clearer's choice, on the timeout, or on the instant roll (`rolled`).
   */
  private resolveAwakening(
    awakening: { readonly playerId: PlayerId; readonly boardId: BoardId },
    blessing: BlessingId,
    automatic: boolean,
    rolled: boolean,
    now: number,
    events: GameEvent[],
  ): void {
    this.awakening = null;
    const player = this.playerState(awakening.playerId);

    if (blessing === BLESSING.LATENT_BLACK_FLASH) {
      player.guaranteedBlackFlash = true;
    } else if (blessing === BLESSING.SORCERY_RESTORATION) {
      const barrier = grantShield(player, GAME_CONSTANTS.AWAKENING_RESTORE_BARRIER);
      if (barrier > 0) {
        events.push({
          type: 'STATUS_APPLIED',
          playerId: player.id,
          sourceId: player.id,
          status: STATUS_KIND.SHIELD,
          value: barrier,
          turnsRemaining: null,
        });
      }
      const before = player.cursedEnergy;
      player.cursedEnergy = clampCursedEnergy(before + GAME_CONSTANTS.AWAKENING_RESTORE_CE);
      this.syncLockedEnergy(player);
      events.push({ type: 'CE_CHANGED', playerId: player.id, delta: player.cursedEnergy - before, cause: 'AWAKENING' });
    }
    events.push({ type: 'AWAKENING_CHOSEN', playerId: player.id, boardId: awakening.boardId, blessing, automatic, rolled });

    const fresh = this.dealFreshBoard(awakening.boardId, events);
    if (blessing === BLESSING.SIX_EYES_INSIGHT) this.revealSixEyes(player, awakening.boardId, fresh, now, events);
    // An instant roll never paused the clock, so there is nothing to give back.
    if (!rolled && !this.sentencingActive()) this.resumeClock(now);
  }

  /** Six Eyes Insight: two random pairs of the new grid are shown face-up for a short preview. */
  private revealSixEyes(
    player: PlayerState,
    boardId: BoardId,
    fresh: readonly Card[],
    now: number,
    events: GameEvent[],
  ): void {
    const pairIds = [...new Set(fresh.filter((card) => card.type !== CARD_TYPE.TRAP).map((card) => card.pairId))];
    const chosen = sampleDistinct(pairIds, 2, this.rng);
    const cardIds: CardId[] = [];
    for (const card of fresh) {
      if (!chosen.includes(card.pairId) || card.state !== CARD_STATE.HIDDEN) continue;
      card.state = CARD_STATE.REVEALED;
      card.revealedBy = player.id;
      cardIds.push(card.id);
    }
    if (cardIds.length === 0) return;
    this.hideTimers.push({ at: now + GAME_CONSTANTS.SIX_EYES_REVEAL_MS, cardIds });
    events.push({
      type: 'CARDS_REVEALED',
      sourceId: player.id,
      boardId,
      cardIds,
      revealMs: GAME_CONSTANTS.SIX_EYES_REVEAL_MS,
      cue: 'SKILL',
    });
  }

  /** True while a Deadly Sentencing or an Awakening Surge holds the turn clock. */
  private clockHeld(): boolean {
    return this.sentencingActive() || this.awakening !== null;
  }

  /** Drops reveal timers that point at cards of `boardId`, in place. */
  private dropHideTimersFor(boardId: BoardId): void {
    const prefix = `${boardId}:`;
    for (let i = this.hideTimers.length - 1; i >= 0; i--) {
      const timer = this.hideTimers[i];
      if (timer?.cardIds.some((cardId) => cardId.startsWith(prefix))) this.hideTimers.splice(i, 1);
    }
  }

  private finish(result: MatchResult, events: GameEvent[]): void {
    for (const playerId of this.playerIds) {
      const attempt = this.attempt(playerId);
      attempt.pending = null;
      attempt.openCards = [];
    }
    this.result = result;
    this.transition(TURN_PHASE.MATCH_OVER, events);
    events.push({ type: 'MATCH_ENDED', result });
  }

  private triggerTrap(player: PlayerState, card: Card, events: GameEvent[]): void {
    const trap = card.trapId === null ? undefined : TRAPS[card.trapId];
    if (!trap) throw new Error(`invariant: trap card ${card.id} has no definition`);
    card.state = CARD_STATE.MATCHED;
    card.revealedBy = player.id;
    player.cursedEnergy = clampCursedEnergy(player.cursedEnergy + trap.cursedEnergyGain);
    events.push({
      type: 'TRAP_TRIGGERED',
      playerId: player.id,
      cardId: card.id,
      trapId: trap.id,
      cursedEnergyGain: trap.cursedEnergyGain,
    });
  }

  // ---------------------------------------------------------------------------
  // Card reveal and planted modifiers
  // ---------------------------------------------------------------------------

  private revealCard(player: PlayerState, card: Card, now: number, events: GameEvent[]): void {
    card.state = CARD_STATE.REVEALED;
    card.revealedBy = player.id;
    events.push({ type: 'CARD_REVEALED', playerId: player.id, cardId: card.id });
    this.triggerCardEffects(player, card, now, events);
  }

  /**
   * Planted modifiers fire for whoever flips the card, except their owner. A cursed
   * nail stuns the flipper; an ember insect detonates for damage and drains CE.
   */
  private triggerCardEffects(player: PlayerState, card: Card, now: number, events: GameEvent[]): void {
    if (card.effectModifiers.length === 0) return;
    const remaining: typeof card.effectModifiers = [];

    for (const modifier of card.effectModifiers) {
      const rules = CARD_EFFECT_RULES[modifier.kind];
      const inert = rules.damage === 0 && rules.stunMs === 0 && rules.ceDrain === 0;
      if (inert || modifier.sourceId === player.id) {
        remaining.push(modifier);
        continue;
      }

      if (rules.damage > 0) {
        const result = applyDamage(player, rules.damage);
        events.push({
          type: 'DAMAGE_DEALT',
          sourceId: modifier.sourceId,
          targetId: player.id,
          dealt: result.dealt,
          absorbed: result.absorbed,
          critical: false,
          piercing: false,
          cause: DAMAGE_CAUSE.CARD_EFFECT,
        });
      }
      if (rules.stunMs > 0) {
        player.stunUntil = Math.max(player.stunUntil, now + rules.stunMs);
        events.push({ type: 'STUNNED', playerId: player.id, until: player.stunUntil });
      }
      if (rules.ceDrain > 0) {
        const drained = Math.min(rules.ceDrain, player.cursedEnergy);
        player.cursedEnergy = clampCursedEnergy(player.cursedEnergy - drained);
        events.push({ type: 'CE_CHANGED', playerId: player.id, delta: -drained, cause: 'CARD_EFFECT' });
      }
      events.push({
        type: 'CARD_EFFECT_TRIGGERED',
        playerId: player.id,
        cardId: card.id,
        modifier: modifier.kind,
        damage: rules.damage,
        stunMs: rules.stunMs,
        ceDrain: rules.ceDrain,
      });
    }
    card.effectModifiers = remaining;
  }

  // ---------------------------------------------------------------------------
  // Ability effects
  // ---------------------------------------------------------------------------

  private applyEffects(
    actor: PlayerState,
    effects: readonly AbilityEffect[],
    now: number,
    events: GameEvent[],
    origin: EffectOrigin,
  ): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'STATUS':
          this.applyStatus(
            actor,
            effect.target === 'SELF' ? actor : this.opponentState(actor.id),
            effect.spec,
            now,
            events,
          );
          break;

        case 'DAMAGE': {
          const target = effect.target === 'SELF' ? actor : this.opponentState(actor.id);
          const amount =
            effect.currentHpFraction !== undefined
              ? Math.max(1, Math.round(target.hp * Math.max(0, effect.currentHpFraction)))
              : effect.maxHpFraction === undefined
                ? effect.amount
                : Math.round(maxHpOf(target) * Math.max(0, effect.maxHpFraction));
          const result = applyDamage(target, amount, { piercing: effect.piercing });
          events.push({
            type: 'DAMAGE_DEALT',
            sourceId: actor.id,
            targetId: target.id,
            dealt: result.dealt,
            absorbed: result.absorbed,
            critical: false,
            piercing: effect.piercing,
            cause: damageCauseOf(origin),
          });
          break;
        }

        case 'HEAL': {
          const healed = heal(actor, effect.amount, maxHpOf(actor));
          if (healed > 0) events.push({ type: 'HEALED', playerId: actor.id, amount: healed });
          break;
        }

        case 'MAX_HP_CUT': {
          const target = effect.target === 'SELF' ? actor : this.opponentState(actor.id);
          const before = maxHpOf(target);
          const cut = Math.min(
            Math.max(0, Math.round(before * Math.max(0, effect.fraction))),
            Math.max(0, before - GAME_CONSTANTS.MIN_MAX_HP),
          );
          if (cut > 0) {
            target.activeEffects.push({
              kind: STATUS_KIND.MAX_HP_REDUCTION,
              sourceId: actor.id,
              turnsRemaining: null,
              value: cut,
            });
            target.hp = Math.min(target.hp, maxHpOf(target));
            // A shrunken pool also lowers the barrier ceiling.
            target.shield = Math.min(target.shield, shieldCapOf(target));
            events.push({
              type: 'MAX_HP_CUT',
              playerId: target.id,
              sourceId: actor.id,
              amount: cut,
              fraction: effect.fraction,
              maxHp: maxHpOf(target),
            });
          }
          break;
        }

        case 'CE_GAIN':
          actor.cursedEnergy = clampCursedEnergy(actor.cursedEnergy + effect.amount);
          events.push({ type: 'CE_CHANGED', playerId: actor.id, delta: effect.amount, cause: origin });
          break;

        case 'CE_SIPHON': {
          const victim = this.opponentState(actor.id);
          const moved = Math.min(effect.amount, victim.cursedEnergy);
          victim.cursedEnergy = clampCursedEnergy(victim.cursedEnergy - moved);
          actor.cursedEnergy = clampCursedEnergy(actor.cursedEnergy + moved);
          events.push({ type: 'CE_CHANGED', playerId: victim.id, delta: -moved, cause: 'SIPHON' });
          events.push({ type: 'CE_CHANGED', playerId: actor.id, delta: moved, cause: 'SIPHON' });
          break;
        }

        case 'CE_DRAIN': {
          const target = effect.target === 'SELF' ? actor : this.opponentState(actor.id);
          const drained = Math.min(effect.amount, target.cursedEnergy);
          target.cursedEnergy = clampCursedEnergy(target.cursedEnergy - drained);
          events.push({ type: 'CE_CHANGED', playerId: target.id, delta: -drained, cause: 'DRAIN' });
          break;
        }

        case 'BOARD_SWAP': {
          const board = this.effectBoard(actor, effect.board);
          const positions = pickHiddenPositions(board.cards, 2, this.rng);
          const [firstIndex, secondIndex] = positions;
          if (firstIndex === undefined || secondIndex === undefined) break;
          const firstCard = board.cards[firstIndex];
          const secondCard = board.cards[secondIndex];
          if (!firstCard || !secondCard) break;
          if (!swapPositions(board.cards, firstIndex, secondIndex)) break;
          events.push({
            type: 'CARDS_SWAPPED',
            boardId: board.id,
            cardIds: [firstCard.id, secondCard.id],
            positions: [firstIndex, secondIndex],
          });
          break;
        }

        case 'COURTROOM_TRIAL': {
          if (this.sentencingActive()) break;
          const victim = this.opponentState(actor.id);
          const victimUltimate = ULTIMATES[CHARACTERS[victim.characterId].ultimateId];
          // Only a Simple Domain can cut a Deadly Sentencing short, and only with 100 CE to spend.
          const canEscape =
            victimUltimate?.type === ULTIMATE_TYPE.SIMPLE_DOMAIN_MAXIMUM &&
            victim.cursedEnergy >= GAME_CONSTANTS.COURTROOM_ESCAPE_COST;
          this.pauseClock(now);
          if (canEscape) {
            this.escapeWindow = {
              casterId: actor.id,
              victimId: victim.id,
              rounds: effect.rounds,
              closesAt: now + this.victimDeadlineMs(victim.id),
            };
            events.push({ type: 'SENTENCING_ESCAPE_OFFERED', casterId: actor.id, victimId: victim.id });
          } else {
            this.openCourtroom(actor.id, victim.id, effect.rounds, now, events);
          }
          break;
        }

        case 'PLANT_MODIFIER': {
          const board = this.effectBoard(actor, effect.board);
          const positions = pickHiddenPositions(board.cards, effect.count, this.rng);
          const cardIds: CardId[] = [];
          for (const position of positions) {
            const card = board.cards[position];
            if (!card) continue;
            card.effectModifiers.push({
              kind: effect.modifier,
              sourceId: actor.id,
              turnsRemaining: effect.turnsRemaining,
            });
            cardIds.push(card.id);
          }
          if (cardIds.length > 0) {
            events.push({
              type: 'CARD_MODIFIED',
              sourceId: actor.id,
              boardId: board.id,
              cardIds,
              modifier: effect.modifier,
              turnsRemaining: effect.turnsRemaining,
            });
          }
          break;
        }

        case 'SCOUT': {
          const board = this.effectBoard(actor, effect.board);
          const positions =
            effect.pool === 'PAIR'
              ? (pickPairPositions(board.cards, this.rng) ?? [])
              : effect.pool === 'ALL'
                ? board.cards.flatMap((card, index) => (card.state === CARD_STATE.HIDDEN ? [index] : []))
                : pickHiddenPositions(board.cards, effect.count, this.rng);
          const cardIds: CardId[] = [];
          for (const position of positions) {
            const card = board.cards[position];
            if (!card || card.state !== CARD_STATE.HIDDEN) continue;
            card.state = CARD_STATE.REVEALED;
            card.revealedBy = actor.id;
            cardIds.push(card.id);
          }
          if (cardIds.length === 0) break;
          this.hideTimers.push({ at: now + effect.revealMs, cardIds });
          events.push({
            type: 'CARDS_REVEALED',
            sourceId: actor.id,
            boardId: board.id,
            cardIds,
            revealMs: effect.revealMs,
            cue: effect.cue,
          });
          break;
        }

        case 'DETONATE_CARD': {
          const board = this.effectBoard(actor, effect.board);
          const position = pickHiddenPositions(board.cards, 1, this.rng)[0];
          const card = position === undefined ? undefined : board.cards[position];
          if (!card) break;
          card.state = CARD_STATE.REVEALED;
          card.revealedBy = actor.id;
          this.hideTimers.push({ at: now + effect.revealMs, cardIds: [card.id] });
          events.push({
            type: 'CARDS_REVEALED',
            sourceId: actor.id,
            boardId: board.id,
            cardIds: [card.id],
            revealMs: effect.revealMs,
            cue: 'SKILL',
          });
          const target = this.opponentState(actor.id);
          const result = applyDamage(target, effect.damage);
          events.push({
            type: 'DAMAGE_DEALT',
            sourceId: actor.id,
            targetId: target.id,
            dealt: result.dealt,
            absorbed: result.absorbed,
            critical: false,
            piercing: false,
            cause: damageCauseOf(origin),
          });
          break;
        }

        case 'AUTO_MATCH_PAIRS': {
          const board = this.effectBoard(actor, effect.board);
          const pairs = pickPairPositionsList(board.cards, effect.count, this.rng);
          for (const [firstIndex, secondIndex] of pairs) {
            const first = board.cards[firstIndex];
            const second = board.cards[secondIndex];
            if (!first || !second) continue;
            first.state = CARD_STATE.MATCHED;
            second.state = CARD_STATE.MATCHED;
            actor.pairsMatched += 1;

            const matchEffects = calculateMatchEffects({
              cardType: first.type,
              blackFlash: false,
              attackerStatuses: actor.activeEffects,
              domainActive: this.domainActiveFor(actor),
            });
            actor.cursedEnergy = clampCursedEnergy(actor.cursedEnergy + matchEffects.ceGain);
            events.push({ type: 'CE_CHANGED', playerId: actor.id, delta: matchEffects.ceGain, cause: 'MATCH' });
            events.push({
              type: 'CARDS_AUTO_MATCHED',
              playerId: actor.id,
              boardId: board.id,
              cardIds: [first.id, second.id],
              pairId: first.pairId,
            });
            events.push({
              type: 'PAIR_MATCHED',
              playerId: actor.id,
              pairId: first.pairId,
              cardIds: [first.id, second.id],
              cardType: first.type,
            });
            const target = this.opponentState(actor.id);
            const result = applyDamage(target, matchEffects.damage, { piercing: matchEffects.piercing });
            events.push({
              type: 'DAMAGE_DEALT',
              sourceId: actor.id,
              targetId: target.id,
              dealt: result.dealt,
              absorbed: result.absorbed,
              critical: false,
              piercing: matchEffects.piercing,
              cause: damageCauseOf(origin),
            });
          }
          break;
        }

        case 'DOMAIN_COUNTER': {
          // The counter window opens whether or not a domain was standing: a sorcerer
          // who raises a Simple Domain keeps it armed for its full duration.
          const counterId = ULTIMATES[CHARACTERS[actor.characterId].ultimateId].id;
          actor.activeSimpleDomain = { ultimateId: counterId, turnsRemaining: effect.turns };
          events.push({
            type: 'SIMPLE_DOMAIN_OPENED',
            playerId: actor.id,
            ultimateId: counterId,
            turnsRemaining: effect.turns,
          });

          const enemy = this.opponentState(actor.id);
          if (!enemy.activeDomain) break;
          enemy.activeEffects.push({
            kind: STATUS_KIND.DOMAIN_NULLIFIED,
            sourceId: actor.id,
            turnsRemaining: effect.turns,
            value: 1,
          });
          events.push({
            type: 'DOMAIN_NULLIFIED',
            playerId: enemy.id,
            sourceId: actor.id,
            turnsRemaining: effect.turns,
          });
          break;
        }

        case 'PACHINKO_OPEN': {
          actor.pachinko = { ...actor.pachinko, spinsLeft: effect.spins };
          events.push({ type: 'PACHINKO_OPENED', playerId: actor.id, spins: effect.spins });
          break;
        }
      }
    }
  }

  /**
   * Applies one status, translated for the mode in play (see `mode-adapt.ts`).
   *
   * Two kinds are special: a SHIELD spec is a one-shot barrier *grant* that lands in
   * `PlayerState.shield` instead of the effect list, and a turn-based spec that has no
   * meaning in simultaneous play is converted into an equal real-time lock-out.
   */
  private applyStatus(actor: PlayerState, target: PlayerState, spec: StatusSpec, now: number, events: GameEvent[]): void {
    const adapted = adaptStatusForMode(spec, this.mode);

    if (adapted.stunMs > 0) {
      target.stunUntil = Math.max(target.stunUntil, now + adapted.stunMs);
      events.push({ type: 'STUNNED', playerId: target.id, until: target.stunUntil });
    }
    if (adapted.note !== null) {
      events.push({
        type: 'STATUS_ADAPTED',
        playerId: target.id,
        sourceId: actor.id,
        status: spec.status,
        value: spec.value,
        mode: this.mode,
        note: adapted.note,
      });
    }
    if (adapted.spec === null) return;

    const granted = adapted.spec.status;
    const value = adapted.spec.value;
    if (granted === STATUS_KIND.SHIELD) {
      const added = grantShield(target, value);
      events.push({
        type: 'STATUS_APPLIED',
        playerId: target.id,
        sourceId: actor.id,
        status: granted,
        value: added,
        turnsRemaining: null,
      });
      return;
    }

    target.activeEffects.push({
      kind: granted,
      sourceId: actor.id,
      turnsRemaining: adapted.spec.turns,
      value,
    });
    events.push({
      type: 'STATUS_APPLIED',
      playerId: target.id,
      sourceId: actor.id,
      status: granted,
      value,
      turnsRemaining: adapted.spec.turns,
    });
    if (granted === STATUS_KIND.MAX_HP_REDUCTION) {
      target.hp = Math.min(target.hp, maxHpOf(target));
      // A shrunken maximum can leave the barrier above its own ceiling.
      target.shield = Math.min(target.shield, shieldCapOf(target));
    }
  }

  /** While CE is locked (Hakari's jackpot) cursed energy snaps back to the lock value. */
  // ---------------------------------------------------------------------------
  // Deadly Sentencing (Higuruma's courtroom)

  private sentencingActive(): boolean {
    return this.escapeWindow !== null || this.courtroom !== null;
  }

  /** Stops the turn clock while a sentencing is open. The first pause sets the mark. */
  private pauseClock(now: number): void {
    if (this.sentencingPausedAt === null) this.sentencingPausedAt = now;
  }

  /** Gives the paused time back to the turn that was running. */
  private resumeClock(now: number): void {
    const pausedAt = this.sentencingPausedAt;
    if (pausedAt === null) return;
    if (this.turnDeadline !== null) this.turnDeadline += Math.max(0, now - pausedAt);
    this.sentencingPausedAt = null;
  }

  private openCourtroom(casterId: PlayerId, victimId: PlayerId, rounds: number, now: number, events: GameEvent[]): void {
    this.courtroom = {
      casterId,
      victimId,
      round: 1,
      totalRounds: rounds,
      slots: [],
      phase: COURTROOM_PHASE.REVEAL,
      phaseEndsAt: null,
      swaps: [],
      target: null,
      pickedSlot: null,
      pickDeadlineAt: null,
      pickAutoAt: null,
      mistakes: 0,
    };
    events.push({ type: 'COURTROOM_OPENED', casterId, victimId, rounds });
    this.startRound(this.courtroom, now, events);
  }

  /** Seats fresh subjects face-up for the memorize reveal. */
  private startRound(trial: CourtroomState, startAt: number, events: GameEvent[]): void {
    trial.slots = sampleDistinct(SENTENCING_SUBJECTS, GAME_CONSTANTS.COURTROOM_SLOTS, this.rng);
    trial.swaps = [];
    trial.target = null;
    trial.pickedSlot = null;
    trial.phase = COURTROOM_PHASE.REVEAL;
    trial.phaseEndsAt = startAt + GAME_PACING.COURTROOM_REVEAL_DURATION_MS;
    events.push({ type: 'COURTROOM_ROUND_STARTED', round: trial.round, totalRounds: trial.totalRounds });
  }

  /** Plans the face-down swaps. Each one is played out physically, so the timing counts the swaps. */
  private beginShuffle(trial: CourtroomState, startAt: number, events: GameEvent[]): void {
    const size = trial.slots.length;
    const swaps: Array<readonly [number, number]> = [];
    for (let i = 0; i < GAME_CONSTANTS.COURTROOM_SWAPS; i++) {
      // Any other slot on a four-card board is adjacent or diagonal, so every swap reads on screen.
      const from = Math.floor(randomUnit(this.rng) * size);
      const to = (from + 1 + Math.floor(randomUnit(this.rng) * (size - 1))) % size;
      const fromSubject = trial.slots[from];
      const toSubject = trial.slots[to];
      if (fromSubject === undefined || toSubject === undefined) continue;
      trial.slots[from] = toSubject;
      trial.slots[to] = fromSubject;
      swaps.push([from, to]);
    }
    trial.swaps = swaps;
    trial.phase = COURTROOM_PHASE.SHUFFLE;
    trial.phaseEndsAt = startAt + swaps.length * GAME_PACING.COURTROOM_SWAP_DURATION_MS;
    events.push({ type: 'COURTROOM_SHUFFLED', swaps });
  }

  /**
   * The shuffle is over: the prosecutor names the subject the victim must locate. Its clock is
   * the phase timeout; past it the Judgeman names a random subject instead.
   */
  private beginProsecution(trial: CourtroomState, startAt: number): void {
    trial.target = null;
    trial.phase = COURTROOM_PHASE.PROSECUTE;
    trial.phaseEndsAt = startAt + GAME_PACING.COURTROOM_PHASE_TIMEOUT_MS;
  }

  /**
   * The Judgeman has named `target`; the victim has until the pick deadline to answer. A sandbox
   * dummy victim answers on its own after a short delay instead.
   */
  private beginPick(trial: CourtroomState, startAt: number, target: CardSubjectId): void {
    trial.target = target;
    trial.phase = COURTROOM_PHASE.PICK;
    trial.phaseEndsAt = null;
    trial.pickDeadlineAt = startAt + GAME_PACING.COURTROOM_PHASE_TIMEOUT_MS;
    trial.pickAutoAt = trial.victimId === this.dummyId ? startAt + GAME_PACING.COURTROOM_DUMMY_DELAY_MS : null;
  }

  /** How long a human-or-dummy victim has to answer a prompt before the engine moves on. */
  private victimDeadlineMs(victimId: PlayerId): number {
    return victimId === this.dummyId ? GAME_PACING.COURTROOM_DUMMY_DELAY_MS : GAME_PACING.COURTROOM_PHASE_TIMEOUT_MS;
  }

  /** A subject from the trial's slots, chosen at random. */
  private randomSubject(trial: CourtroomState): CardSubjectId {
    const subject = trial.slots[Math.floor(randomUnit(this.rng) * trial.slots.length)];
    if (subject === undefined) throw new Error('a courtroom trial always has subjects to name');
    return subject;
  }

  /**
   * Judges one pick and holds the verdict on screen: a wrong pick seals a card, then the
   * trial waits out the inspection beat before the next round or the close. The victim's
   * own pick and the pick timeout both end here. Nothing is dealt away while the player is
   * still reading it, which is why `pickedSlot` survives until the next deal.
   */
  private resolvePick(trial: CourtroomState, playerId: PlayerId, slot: number, at: number, events: GameEvent[]): void {
    trial.pickDeadlineAt = null;
    trial.pickAutoAt = null;
    const verdictNotGuilty = trial.slots[slot] === trial.target;
    if (!verdictNotGuilty) {
      trial.mistakes += 1;
      this.sealHiddenCard(trial, events);
    }
    trial.pickedSlot = slot;
    events.push({
      type: 'COURTROOM_VERDICT',
      playerId,
      slot,
      verdict: verdictNotGuilty ? 'NOT_GUILTY' : 'GUILTY',
      mistakes: trial.mistakes,
    });

    trial.phase = COURTROOM_PHASE.INSPECT;
    trial.phaseEndsAt = at + GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS;
  }

  /** The slot a timed-out pick counts as: a random one that does not hold the target. */
  private wrongSlot(trial: CourtroomState): number {
    const wrong: number[] = [];
    trial.slots.forEach((subject, slot) => {
      if (subject !== trial.target) wrong.push(slot);
    });
    const slot = wrong[Math.floor(randomUnit(this.rng) * wrong.length)];
    if (slot === undefined) throw new Error('a courtroom pick always has a wrong slot to name');
    return slot;
  }

  /**
   * Runs the trial's timed steps whose end has passed, so it follows the clock whatever the
   * call rate. An unanswered pick past its deadline is resolved as a GUILTY guess by the victim.
   */
  private advanceCourtroom(now: number, events: GameEvent[]): void {
    // Each pass moves the trial one step on, so the loop ends once the clock is behind it.
    for (;;) {
      const trial = this.courtroom;
      if (!trial) return;
      if (trial.phase === COURTROOM_PHASE.PICK) {
        const autoAt = trial.pickAutoAt;
        if (autoAt !== null && now >= autoAt) {
          // The sandbox dummy answers on its own: right half the time, otherwise a wrong slot.
          const correctSlot = trial.slots.findIndex((subject) => subject === trial.target);
          const correct = randomUnit(this.rng) < GAME_CONSTANTS.COURTROOM_DUMMY_ACCURACY && correctSlot >= 0;
          this.resolvePick(trial, trial.victimId, correct ? correctSlot : this.wrongSlot(trial), autoAt, events);
          continue;
        }
        const deadline = trial.pickDeadlineAt;
        if (deadline === null || now < deadline) return;
        this.resolvePick(trial, trial.victimId, this.wrongSlot(trial), deadline, events);
        continue;
      }
      const dueAt = trial.phaseEndsAt;
      if (dueAt === null || now < dueAt) return;
      if (trial.phase === COURTROOM_PHASE.INSPECT) {
        // The inspection beat is over: deal the next round, or close the courtroom for good.
        if (trial.round < trial.totalRounds) {
          trial.round += 1;
          this.startRound(trial, dueAt, events);
        } else {
          this.closeCourtroom(trial, dueAt, events);
        }
      } else if (trial.phase === COURTROOM_PHASE.REVEAL) this.beginShuffle(trial, dueAt, events);
      else if (trial.phase === COURTROOM_PHASE.SHUFFLE) this.beginProsecution(trial, dueAt);
      else this.beginPick(trial, dueAt, this.randomSubject(trial));
    }
  }

  /** A prompt the victim never answered lapses: the trial begins as if the victim declined to escape. */
  private advanceEscape(now: number, events: GameEvent[]): void {
    const prompt = this.escapeWindow;
    if (!prompt || now < prompt.closesAt) return;
    this.escapeWindow = null;
    this.openCourtroom(prompt.casterId, prompt.victimId, prompt.rounds, prompt.closesAt, events);
  }

  /** A wrong pick plants a lock on one of the victim's hidden cards, chosen at random. */
  private sealHiddenCard(trial: CourtroomState, events: GameEvent[]): void {
    const candidates = this.boardFor(trial.victimId).filter(
      (card) => card.state === CARD_STATE.HIDDEN && !hasModifier(card, CARD_EFFECT_KIND.LOCKED),
    );
    if (candidates.length === 0) return;
    const card = candidates[Math.floor(randomUnit(this.rng) * candidates.length)];
    if (!card) return;
    // The seal ages on the victim's own turns and lifts after CONFISCATED_TURNS of them.
    const turnsRemaining = GAME_CONSTANTS.CONFISCATED_TURNS;
    card.effectModifiers.push({
      kind: CARD_EFFECT_KIND.LOCKED,
      sourceId: trial.casterId,
      turnsRemaining,
      tickOwner: trial.victimId,
    });
    events.push({
      type: 'CARD_MODIFIED',
      sourceId: trial.casterId,
      boardId: this.boardIdFor(trial.victimId),
      cardIds: [card.id],
      modifier: CARD_EFFECT_KIND.LOCKED,
      turnsRemaining,
    });
  }

  /** Ends the trial. Any mistake hands the caster the Executioner's Sword, scaled by the mistakes. */
  private closeCourtroom(trial: CourtroomState, now: number, events: GameEvent[]): void {
    this.courtroom = null;
    events.push({
      type: 'COURTROOM_CLOSED',
      casterId: trial.casterId,
      victimId: trial.victimId,
      mistakes: trial.mistakes,
    });
    if (trial.mistakes > 0) {
      const caster = this.playerState(trial.casterId);
      const damage =
        GAME_CONSTANTS.EXECUTIONER_BASE_DAMAGE + GAME_CONSTANTS.EXECUTIONER_DAMAGE_PER_MISTAKE * trial.mistakes;
      caster.executioner = { damage, turnsRemaining: GAME_CONSTANTS.EXECUTIONER_TURNS, graceClose: true };
      events.push({
        type: 'EXECUTIONER_GRANTED',
        playerId: caster.id,
        damage,
        turns: GAME_CONSTANTS.EXECUTIONER_TURNS,
      });
    }
    this.resumeClock(now);
  }

  private publicSentencing(): PublicSentencingView | null {
    const prompt = this.escapeWindow;
    if (prompt) {
      return {
        stage: 'ESCAPE',
        casterId: prompt.casterId,
        victimId: prompt.victimId,
        round: 0,
        totalRounds: prompt.rounds,
        phase: null,
        phaseEndsAt: prompt.closesAt,
        slots: null,
        candidates: null,
        swaps: [],
        target: null,
        pickedSlot: null,
        mistakes: 0,
      };
    }
    const trial = this.courtroom;
    if (!trial) return null;
    return {
      stage: 'TRIAL',
      casterId: trial.casterId,
      victimId: trial.victimId,
      round: trial.round,
      totalRounds: trial.totalRounds,
      phase: trial.phase,
      phaseEndsAt: trial.phase === COURTROOM_PHASE.PICK ? (trial.pickAutoAt ?? trial.pickDeadlineAt) : trial.phaseEndsAt,
      // Subjects are visible during the reveal, and again for the verdict inspection.
      slots:
        trial.phase === COURTROOM_PHASE.REVEAL || trial.phase === COURTROOM_PHASE.INSPECT
          ? [...trial.slots]
          : null,
      // Catalog order, not slot order: the prosecutor sees the four names without their positions.
      candidates:
        trial.phase === COURTROOM_PHASE.PROSECUTE
          ? SENTENCING_SUBJECTS.filter((subject) => trial.slots.includes(subject))
          : null,
      swaps: [...trial.swaps],
      target: trial.target,
      pickedSlot: trial.phase === COURTROOM_PHASE.INSPECT ? trial.pickedSlot : null,
      mistakes: trial.mistakes,
    };
  }

  private syncLockedEnergy(player: PlayerState): void {
    if (!hasStatus(player.activeEffects, STATUS_KIND.CE_LOCKED)) return;
    player.cursedEnergy = clampCursedEnergy(statusValue(player.activeEffects, STATUS_KIND.CE_LOCKED));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Narrowing-safe check: `this.phase` may change during `advance()`. */
  private isOver(): boolean {
    return this.phase === TURN_PHASE.MATCH_OVER;
  }

  /** True while the active turn-based player may act (no evaluation window is open). */
  private isAwaitingAction(): boolean {
    if (!this.turnBased) return !this.isOver();
    if (this.attempt(this.turnOwner()).pending !== null) return false;
    const steps = PHASE_BY_SEAT[this.turnOwnerSeat];
    return this.phase === steps.WAIT || this.phase === steps.FIRST || this.phase === steps.SECOND;
  }

  /** Skills and ultimates are only used between flip attempts, by a player who may act. */
  private actionBlock(playerId: PlayerId, now: number): EngineErrorCode | null {
    const seat = this.seatOf(playerId);
    if (seat === null) return 'UNKNOWN_PLAYER';
    const attempt = this.attempt(playerId);
    if (attempt.pending) return 'EVALUATING';
    if (this.turnBased && (seat !== this.turnOwnerSeat || !this.isAwaitingAction())) {
      return 'NOT_YOUR_TURN';
    }
    if (now < this.playerState(playerId).stunUntil) return 'STUNNED';
    if (attempt.openCards.length > 0) return 'FLIP_IN_PROGRESS';
    return null;
  }

  private findMatchingPair(cards: readonly Card[]): [Card, Card] | null {
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const first = cards[i];
        const second = cards[j];
        if (!first || !second) continue;
        if (verifyPair(first, second).isMatch) return [first, second];
      }
    }
    return null;
  }

  private flipLimitFor(player: PlayerState): number {
    return GAME_CONSTANTS.BASE_FLIP_LIMIT + statusValue(player.activeEffects, STATUS_KIND.EXTRA_FLIP);
  }

  private blackFlashThreshold(player: PlayerState): number {
    return hasStatus(player.activeEffects, STATUS_KIND.FLASH_WINDOW)
      ? 1
      : GAME_CONSTANTS.BLACK_FLASH_STREAK_LENGTH;
  }

  /** A domain only boosts damage while it has not been neutralized. */
  private domainActiveFor(player: PlayerState): boolean {
    return player.activeDomain !== null && !hasStatus(player.activeEffects, STATUS_KIND.DOMAIN_NULLIFIED);
  }

  /**
   * Budget for the turn that is starting: the escalating schedule for this turn number,
   * shortened further by a rushed-turn debuff (Unlimited Void) when one is active.
   */
  private turnTimeFor(player: PlayerState): number {
    const scheduled = calculateTurnDuration(this.turnNumber);
    if (!hasStatus(player.activeEffects, STATUS_KIND.SHORT_TIMER)) return scheduled;
    return Math.min(scheduled, statusValue(player.activeEffects, STATUS_KIND.SHORT_TIMER));
  }

  private publicPending(pending: PendingResolution | null): PublicPendingView | null {
    return pending ? { outcome: pending.outcome, cardIds: pending.cardIds, resolveAt: pending.resolveAt } : null;
  }

  private publicAttempt(playerId: PlayerId): PublicAttemptView {
    const attempt = this.attempt(playerId);
    const player = this.playerState(playerId);
    const step: AttemptStep =
      attempt.pending !== null ? 'EVALUATING' : attempt.openCards.length > 0 ? 'FLIPPED_FIRST' : 'IDLE';
    return {
      playerId,
      boardId: this.boardIdFor(playerId),
      phase: step,
      currentSelection: [...attempt.openCards],
      isEvaluating: attempt.pending !== null,
      flipLimit: this.flipLimitFor(player),
      pending: this.publicPending(attempt.pending),
      stunnedUntil: player.stunUntil,
    };
  }

  private transition(to: TurnPhase, events: GameEvent[]): void {
    const from = this.phase;
    if (from === to) return;
    assertTransition(from, to);
    this.phase = to;
    events.push({ type: 'PHASE_CHANGED', from, to });
  }

  private seatOf(playerId: PlayerId): Seat | null {
    if (this.playerIds[0] === playerId) return 0;
    if (this.playerIds[1] === playerId) return 1;
    return null;
  }

  private turnOwner(): PlayerId {
    return this.playerIds[this.turnOwnerSeat];
  }

  private opponentOf(playerId: PlayerId): PlayerId {
    return this.playerIds[0] === playerId ? this.playerIds[1] : this.playerIds[0];
  }

  private boardIdFor(playerId: PlayerId): BoardId {
    return this.dualBoards ? playerId : SHARED_BOARD_ID;
  }

  private boardFor(playerId: PlayerId): Card[] {
    return this.board(this.boardIdFor(playerId));
  }

  private board(boardId: BoardId): Card[] {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`invariant: unknown board ${boardId}`);
    return board;
  }

  /** The grid an effect touches: the caster's own, or the one the opponent plays on. */
  private effectBoard(actor: PlayerState, which: EffectBoard): { id: BoardId; cards: Card[] } {
    const owner = which === 'OWN' ? actor.id : this.opponentOf(actor.id);
    const id = this.boardIdFor(owner);
    return { id, cards: this.board(id) };
  }

  private cardById(cardId: CardId): Card | undefined {
    for (const board of this.boards.values()) {
      const card = board.find((candidate) => candidate.id === cardId);
      if (card) return card;
    }
    return undefined;
  }

  private attempt(playerId: PlayerId): Attempt {
    const attempt = this.attempts.get(playerId);
    if (!attempt) throw new Error(`invariant: unknown player ${playerId}`);
    return attempt;
  }

  /**
   * Deals one grid from fresh entropy, steered away from the other grids of the match —
   * in a dual match that is the grid the opponent is still playing, so the new cards are
   * not a read of theirs. A shared-board match has a single grid, so nothing is avoided.
   */
  private dealBoard(boardId: BoardId): Card[] {
    return generateBoardAvoiding(boardId, {
      ...this.deal,
      rng: this.rng,
      avoid: [...this.boards.entries()]
        .filter(([id]) => id !== boardId)
        .map(([, cards]) => cards),
    });
  }

  private playerState(id: PlayerId): PlayerState {
    const player = this.players.get(id);
    if (!player) throw new Error(`invariant: unknown player ${id}`);
    return player;
  }

  private opponentState(id: PlayerId): PlayerState {
    return this.playerState(this.opponentOf(id));
  }

  private accept(events: GameEvent[]): EngineResult {
    this.emitSounds(events);
    return { ok: true, events };
  }

  private reject(code: EngineErrorCode, events: GameEvent[]): EngineResult {
    // A rejection can still carry real events: a turn timeout or match end surfaced by
    // the clock sync that ran before the gate. Those deserve their feedback too.
    this.emitSounds(events);
    return { ok: false, code, events };
  }

  private emitSounds(events: readonly GameEvent[]): void {
    if (this.soundListener === null || events.length === 0) return;
    for (const cue of soundCuesForEvents(events)) this.soundListener(cue);
  }
}

/** Alias kept for the tests and callers that predate the dual-board refactor. */
export { GameEngine as TurnEngine };
