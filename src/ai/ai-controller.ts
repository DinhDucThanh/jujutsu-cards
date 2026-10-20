import {
  CARD_STATE,
  CHARACTERS,
  COURTROOM_PHASE,
  GAME_CONSTANTS,
  TURN_PHASE,
  ULTIMATES,
  ULTIMATE_TYPE,
  attemptOfPlayer,
  boardIdOfPlayer,
  boardOfPlayer,
  isTurnBasedMode,
  matchKeyOf,
  randomUnit,
  BLESSING,
  type BlessingId,
  type CardId,
  type CardSubjectId,
  type EngineResult,
  type GameEngine,
  type PlayerId,
  type PublicCardView,
  type PublicMatchView,
  type PublicPlayerView,
  type PublicSentencingView,
  type RandomSource,
} from '../engine/index.js';
import { CardMemory } from './card-memory.js';
import { AI_GRADE_PROFILES, type AiGrade, type AiGradeProfile } from './difficulty.js';

export type BotAbility = { readonly type: 'SKILL' } | { readonly type: 'ULTIMATE' };

/**
 * A Deadly Sentencing answer the bot owes now: the Simple Domain prompt, the prosecutor's
 * target, or the victim's slot pick.
 */
export type SentencingDecision = { readonly type: 'ESCAPE' } | { readonly type: 'PROSECUTE' } | { readonly type: 'PICK' };

/** Chance that a bot able to pay for it spends 100 CE on a Simple Domain against a sentencing. */
export const AI_ESCAPE_CHANCE = 0.8;
/** Simulated thinking before the bot answers the Simple Domain prompt. */
export const AI_ESCAPE_DELAY_MS = 1_000;
/** Simulated deliberation before the bot names a slot in the courtroom, drawn uniformly. */
export const AI_PICK_DELAY_MS = { min: 1_200, max: 1_800 } as const;
/** Simulated pause before a bot prosecutor names the subject the victim must locate. */
export const AI_PROSECUTE_DELAY_MS = 800;

/** The subjects seen face-up in one round's reveal, kept while the shuffle hides them. */
interface RevealedRound {
  readonly round: number;
  readonly slots: readonly CardSubjectId[];
}

/** Public-view-only decision maker for one bot seat. */
export class AiController {
  readonly memory: CardMemory;
  /** The latest reveal. Only the reveal shows the subjects, so the bot must remember them. */
  private revealed: RevealedRound | null = null;

  constructor(
    readonly botId: PlayerId,
    readonly profile: AiGradeProfile,
    private readonly rng: RandomSource,
  ) {
    this.memory = new CardMemory(profile.memoryRetention, rng);
  }

  static forGrade(botId: PlayerId, grade: AiGrade, rng: RandomSource): AiController {
    return new AiController(botId, AI_GRADE_PROFILES[grade], rng);
  }

  /**
   * Feeds memory with the public view. Call on every poll, whether or not it is the bot's
   * turn. Only the grid the bot flips on is studied: in the dual modes the opponent's grid
   * is none of its business, and in SHARED mode both seats share the one grid.
   */
  observe(view: PublicMatchView): void {
    this.memory.observe(view, boardIdOfPlayer(view, this.botId));
    const sentencing = view.sentencing;
    if (sentencing?.stage === 'TRIAL' && sentencing.slots !== null) {
      this.revealed = { round: sentencing.round, slots: sentencing.slots };
    }
  }

  /**
   * True when the bot may act: its turn in the turn-based modes (SHARED, DUAL_TURN_BASED),
   * any time in DUAL mode, and never while an evaluation window is open or while stunned.
   */
  isMyTurn(view: PublicMatchView, now = Number.POSITIVE_INFINITY): boolean {
    if (view.result !== null) return false;
    if (view.phase === TURN_PHASE.MATCH_START || view.phase === TURN_PHASE.MATCH_OVER) return false;
    const attempt = attemptOfPlayer(view, this.botId);
    if (!attempt || attempt.phase === 'EVALUATING') return false;
    if (attempt.stunnedUntil > now) return false;
    if (view.phase === TURN_PHASE.EVALUATING) return false;
    if (isTurnBasedMode(view.boardMode)) return view.turnOwner === this.botId;
    return true;
  }

  /** Ultimate or skill to use before flipping, if the grade's rules call for it. */
  chooseAbility(view: PublicMatchView): BotAbility | null {
    if (!this.isMyTurn(view) || this.currentSelection(view).length > 0) return null;
    const bot = this.botState(view);
    if (!bot) return null;

    const character = CHARACTERS[bot.characterId];
    const ultimate = ULTIMATES[character.ultimateId];
    const ce = bot.cursedEnergy;

    const ultimateThreshold = this.profile.ultimateCeThreshold;
    const domainBlocked = ultimate.type === ULTIMATE_TYPE.DOMAIN && bot.activeDomain !== null;
    if (ultimateThreshold !== null && !domainBlocked && ce >= ultimateThreshold) return { type: 'ULTIMATE' };

    // Cast the ultimate the moment it is affordable; otherwise fall back to the skill.
    const skillThreshold = this.profile.skillCeThreshold;
    if (skillThreshold !== null && ce >= skillThreshold) return { type: 'SKILL' };
    return null;
  }

  /**
   * Picks the next card to open. Prefers the remembered partner of an open flip,
   * else a known pair, else an unknown face-down card. A blind-guess roll
   * (grade-dependent) skips memory and picks at random.
   */
  chooseFlip(view: PublicMatchView): CardId | null {
    if (!this.isMyTurn(view)) return null;
    const board = boardOfPlayer(view, this.botId);
    const hidden = board.filter((card) => card.state === CARD_STATE.HIDDEN);
    if (hidden.length === 0) return null;

    const blind = randomUnit(this.rng) < this.profile.blindGuessRate;
    const firstOpenId = this.currentSelection(view)[0];
    const openFirst = firstOpenId === undefined ? undefined : board.find((card) => card.id === firstOpenId);

    const openKey = openFirst === undefined ? null : matchKeyOf(openFirst);
    if (openFirst !== undefined && openKey !== null) {
      if (!blind) {
        const partner = this.memory.partnerOf(openKey, board, openFirst.id);
        if (partner !== null) return partner;
      }
      return this.pickRandom(
        hidden.filter((card) => card.id !== openFirst.id),
        blind,
      );
    }

    if (!blind) {
      const pair = this.memory.knownPairs(board)[0];
      if (pair) return pair[0];
    }
    return this.pickRandom(hidden, blind);
  }

  /**
   * The Awakening Surge blessing the bot picks for a board it cleared, or null when it owes none.
   * Each of the three is drawn uniformly.
   */
  chooseBlessing(view: PublicMatchView): BlessingId | null {
    if (view.awakening?.playerId !== this.botId) return null;
    const options = [BLESSING.LATENT_BLACK_FLASH, BLESSING.SORCERY_RESTORATION, BLESSING.SIX_EYES_INSIGHT];
    return options[Math.floor(randomUnit(this.rng) * options.length)] ?? null;
  }

  /** The Deadly Sentencing answer the bot owes right now, or null when it owes none. */
  sentencingDecision(view: PublicMatchView): SentencingDecision | null {
    const sentencing = view.sentencing;
    if (!sentencing) return null;
    if (sentencing.stage === 'ESCAPE') return sentencing.victimId === this.botId ? { type: 'ESCAPE' } : null;
    if (sentencing.phase === COURTROOM_PHASE.PROSECUTE && sentencing.casterId === this.botId) {
      return { type: 'PROSECUTE' };
    }
    if (sentencing.phase === COURTROOM_PHASE.PICK && sentencing.victimId === this.botId) return { type: 'PICK' };
    return null;
  }

  /** Thinking time before the bot answers a sentencing decision. */
  sentencingDelayMs(decision: SentencingDecision): number {
    if (decision.type === 'ESCAPE') return AI_ESCAPE_DELAY_MS;
    if (decision.type === 'PROSECUTE') return AI_PROSECUTE_DELAY_MS;
    const { min, max } = AI_PICK_DELAY_MS;
    return min + randomUnit(this.rng) * (max - min);
  }

  /**
   * The subject a bot prosecutor charges the victim with locating: drawn uniformly from the four
   * candidates the public view names. Null when the bot holds no prosecution right now.
   */
  chooseTarget(view: PublicMatchView): CardSubjectId | null {
    const sentencing = view.sentencing;
    if (!sentencing || sentencing.casterId !== this.botId || sentencing.phase !== COURTROOM_PHASE.PROSECUTE) {
      return null;
    }
    const candidates = sentencing.candidates ?? [];
    return candidates[Math.floor(randomUnit(this.rng) * candidates.length)] ?? null;
  }

  /**
   * Whether the bot spends 100 CE on a Simple Domain to neutralize the incoming sentencing.
   * It needs the means (a Simple Domain ultimate and the CE) and then a roll.
   */
  chooseEscape(view: PublicMatchView): boolean {
    const bot = this.botState(view);
    if (!bot) return false;
    const ultimate = ULTIMATES[CHARACTERS[bot.characterId].ultimateId];
    const hasCounter = ultimate.type === ULTIMATE_TYPE.SIMPLE_DOMAIN_MAXIMUM;
    if (!hasCounter || bot.cursedEnergy < GAME_CONSTANTS.COURTROOM_ESCAPE_COST) return false;
    return randomUnit(this.rng) < AI_ESCAPE_CHANCE;
  }

  /**
   * The slot the bot names in the pick. With the target located it names that slot with the
   * grade's accuracy and a wrong slot otherwise. Without a location it can only guess.
   */
  chooseSlot(view: PublicMatchView): number | null {
    const sentencing = view.sentencing;
    if (!sentencing || sentencing.victimId !== this.botId || sentencing.phase !== COURTROOM_PHASE.PICK) return null;
    const all = Array.from({ length: GAME_CONSTANTS.COURTROOM_SLOTS }, (_, slot) => slot);
    const located = this.locateTarget(sentencing);
    if (located === null) return this.pickOne(all);
    if (randomUnit(this.rng) < this.profile.courtroomAccuracy) return located;
    return this.pickOne(all.filter((slot) => slot !== located));
  }

  /**
   * The slot the bot believes holds the target: the subjects it saw in the reveal, replayed
   * through the shuffle's swaps. Null when it missed the reveal of this round.
   */
  private locateTarget(sentencing: PublicSentencingView): number | null {
    const revealed = this.revealed;
    if (!revealed || revealed.round !== sentencing.round || sentencing.target === null) return null;
    const slots = [...revealed.slots];
    for (const [from, to] of sentencing.swaps) {
      const fromSubject = slots[from];
      const toSubject = slots[to];
      if (fromSubject === undefined || toSubject === undefined) return null;
      slots[from] = toSubject;
      slots[to] = fromSubject;
    }
    const slot = slots.indexOf(sentencing.target);
    return slot === -1 ? null : slot;
  }

  private pickOne(options: readonly number[]): number | null {
    return options[Math.floor(randomUnit(this.rng) * options.length)] ?? null;
  }

  /** Blind moves pick from every face-down card; otherwise prefer cards the bot has not seen. */
  private pickRandom(candidates: readonly PublicCardView[], blind: boolean): CardId | null {
    const pool = blind ? candidates : candidates.filter((card) => !this.memory.isKnown(card.id));
    const source = pool.length > 0 ? pool : candidates;
    if (source.length === 0) return null;
    const index = Math.floor(randomUnit(this.rng) * source.length);
    return source[index]?.id ?? null;
  }

  private currentSelection(view: PublicMatchView): readonly CardId[] {
    return attemptOfPlayer(view, this.botId)?.currentSelection ?? [];
  }

  private botState(view: PublicMatchView): PublicPlayerView | undefined {
    return view.players.find((player) => player.id === this.botId);
  }
}

/** What the turn driver needs from the match. */
export interface AiHost {
  getView(): PublicMatchView;
  /** Engine time, used to respect stun locks. */
  now(): number;
  flip(cardId: CardId): EngineResult;
  useAbility(ability: BotAbility): EngineResult;
  /** Answers the Simple Domain prompt: true spends the 100 CE to escape the sentencing. */
  answerEscape(escape: boolean): EngineResult;
  /** Names the subject the victim must locate, as the prosecutor. */
  prosecute(subject: CardSubjectId): EngineResult;
  /** Names the slot the bot judges to hold the Judgeman's target. */
  pickSlot(slot: number): EngineResult;
  /** Picks the Awakening Surge blessing for the board the bot cleared. */
  chooseBlessing(blessing: BlessingId): EngineResult;
}

export const AI_POLL_MS = 100;

export interface AiDriverOptions {
  readonly pollMs?: number;
  /** Receives every bot command result, so the UI can show the events it produced. */
  readonly onResult?: (result: EngineResult) => void;
}

/**
 * Drives the bot with a setTimeout chain: poll the view while waiting; when it is
 * the bot's turn, think for the grade's delay, then take one action. Returns a stop function.
 */
export function startAiDriver(controller: AiController, host: AiHost, options: AiDriverOptions = {}): () => void {
  const pollMs = options.pollMs ?? AI_POLL_MS;
  const report = options.onResult ?? ((): void => undefined);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const later = (delay: number, next: () => void): void => {
    timer = setTimeout(next, delay);
  };

  /** Picks the Awakening Surge blessing the bot owes, if the view still asks for one. */
  const answerAwakening = (view: PublicMatchView): void => {
    const blessing = controller.chooseBlessing(view);
    if (blessing !== null) report(host.chooseBlessing(blessing));
  };

  /** Answers the sentencing decision the bot owes, if the view still asks for one. */
  const answerSentencing = (view: PublicMatchView): void => {
    const decision = controller.sentencingDecision(view);
    if (decision?.type === 'ESCAPE') {
      report(host.answerEscape(controller.chooseEscape(view)));
    } else if (decision?.type === 'PROSECUTE') {
      const subject = controller.chooseTarget(view);
      if (subject !== null) report(host.prosecute(subject));
    } else if (decision?.type === 'PICK') {
      const slot = controller.chooseSlot(view);
      if (slot !== null) report(host.pickSlot(slot));
    }
  };

  const poll = (): void => {
    if (stopped) return;
    const view = host.getView();
    controller.observe(view);
    if (view.result !== null) return;
    if (view.awakening?.playerId === controller.botId) {
      // The bot cleared a board: it picks its blessing after the AI pause.
      later(GAME_CONSTANTS.AWAKENING_AI_DELAY_MS, act);
      return;
    }
    if (view.sentencing !== null) {
      // A Deadly Sentencing holds the match: the bot acts only on its own prompt, and waits otherwise.
      const decision = controller.sentencingDecision(view);
      if (decision === null) later(pollMs, poll);
      else later(controller.sentencingDelayMs(decision), act);
      return;
    }
    if (!controller.isMyTurn(view, host.now())) {
      later(pollMs, poll);
      return;
    }
    later(controller.profile.moveDelayMs, act);
  };

  const act = (): void => {
    if (stopped) return;
    const view = host.getView();
    controller.observe(view);
    if (view.result !== null) return;
    if (view.awakening?.playerId === controller.botId) {
      answerAwakening(view);
      later(pollMs, poll);
      return;
    }
    if (view.sentencing !== null) {
      answerSentencing(view);
      later(pollMs, poll);
      return;
    }
    if (!controller.isMyTurn(view, host.now())) {
      later(pollMs, poll);
      return;
    }

    const ability = controller.chooseAbility(view);
    if (ability) {
      const result = host.useAbility(ability);
      report(result);
      if (result.ok) {
        later(pollMs, poll);
        return;
      }
    }

    const cardId = controller.chooseFlip(view);
    if (cardId !== null) report(host.flip(cardId));
    later(pollMs, poll);
  };

  later(0, poll);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Adapter from a GameEngine to the driver's host, acting as `botId` at engine time `now()`. */
export function engineHost(engine: GameEngine, botId: PlayerId, now: () => number): AiHost {
  return {
    getView: () => engine.getPublicView(),
    now,
    flip: (cardId) => engine.flipCard(botId, cardId, now()),
    useAbility: (ability) =>
      ability.type === 'SKILL' ? engine.activateSkill(botId, now()) : engine.activateUltimate(botId, now()),
    answerEscape: (escape) => engine.answerEscape(botId, escape, now()),
    prosecute: (subject) => engine.chooseProsecution(botId, subject, now()),
    pickSlot: (slot) => engine.pickCourtroomSlot(botId, slot, now()),
    chooseBlessing: (blessing) => engine.chooseBlessing(botId, blessing, now()),
  };
}
