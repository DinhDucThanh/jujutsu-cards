import { SHARED_BOARD_ID } from './constants.js';
import {
  CARD_EFFECT_KIND,
  CARD_STATE,
  isTurnBasedMode,
  usesOwnBoards,
  type ActiveDomain,
  type BoardId,
  type BoardMode,
  type CardEffectModifier,
  type CardId,
  type CardState,
  type CardSubjectId,
  type CardType,
  type CharacterId,
  type CourtroomPhase,
  type MatchResult,
  type PachinkoState,
  type PairId,
  type PlayerId,
  type SimpleDomainWindow,
  type StatusEffect,
  type TurnPhase,
  type Card,
  type TrapId,
} from './types.js';

/** Card as clients may see it. Identity, type and pair are null while the card is face down. */
export interface PublicCardView {
  readonly id: CardId;
  readonly position: number;
  readonly state: CardState;
  readonly revealedBy: PlayerId | null;
  readonly pairId: PairId | null;
  readonly characterId: CardSubjectId | null;
  readonly type: CardType | null;
  /**
   * Which trap this is, once the card is face-up. A face-down trap stays anonymous:
   * the grid is a memory game, so hidden cards never leak their identity.
   */
  readonly trapId: TrapId | null;
  readonly effectModifiers: readonly CardEffectModifier[];
  /** Transfigured by Mahito: the real face stays hidden even while face-up. */
  readonly corrupted: boolean;
  /** Sealed by a domain: cannot be flipped while locked. */
  readonly locked: boolean;
}

export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly characterId: CharacterId;
  readonly hp: number;
  /** The configured maximum HP minus any permanent reduction. */
  readonly maxHp: number;
  /** Barrier points, soaked before HP. Never above half of `maxHp`. */
  readonly shield: number;
  readonly cursedEnergy: number;
  readonly comboStreak: number;
  readonly pairsMatched: number;
  readonly activeEffects: readonly StatusEffect[];
  readonly activeDomain: ActiveDomain | null;
  /** An armed Simple Domain / Maximum Technique window, or null. */
  readonly activeSimpleDomain: SimpleDomainWindow | null;
  /** Engine time until which this player cannot act; 0 when free. */
  readonly stunnedUntil: number;
  /** Cards this player may open per attempt (2, or 3 under Chimera Shadow Garden). */
  readonly flipLimit: number;
  /** An active Executioner's Sword, or null. */
  readonly executioner: PublicExecutionerView | null;
  /** Idle Death Gamble slot state: spins left, pity, and whether the next expiry resets the Domain. */
  readonly pachinko: PachinkoState;
}

/** Executioner's Sword as clients may see it. */
export interface PublicExecutionerView {
  readonly damage: number;
  readonly turnsRemaining: number;
}

/**
 * A Deadly Sentencing in progress. `slots` is only set while the four subjects are
 * face-up in the reveal; during the shuffle and the pick they stay hidden.
 */
export interface PublicSentencingView {
  readonly stage: 'ESCAPE' | 'TRIAL';
  readonly casterId: PlayerId;
  readonly victimId: PlayerId;
  /** 1-based round of the trial; 0 while the escape prompt is open. */
  readonly round: number;
  readonly totalRounds: number;
  readonly phase: CourtroomPhase | null;
  /**
   * Engine time at which the current step times out: the escape prompt's close, the phase end,
   * or the pick deadline. Null when no step is on a clock.
   */
  readonly phaseEndsAt: number | null;
  /**
   * Subject at each slot. Published during the reveal, and again during the verdict
   * inspection so the picked card and the true target can be turned face-up.
   */
  readonly slots: readonly CardSubjectId[] | null;
  /**
   * The four subjects the prosecutor may name, set only during the prosecution. Listed in catalog
   * order rather than slot order, so it reveals no positions.
   */
  readonly candidates: readonly CardSubjectId[] | null;
  /** Swap pairs of the current shuffle, played in order. */
  readonly swaps: ReadonlyArray<readonly [number, number]>;
  /** The subject the Judgeman asked for; set from the pick phase on. */
  readonly target: CardSubjectId | null;
  /** The slot the victim answered, set only during the verdict inspection. */
  readonly pickedSlot: number | null;
  readonly mistakes: number;
}

export interface PublicPendingView {
  readonly outcome: 'MATCH' | 'MISMATCH';
  readonly cardIds: readonly CardId[];
  readonly resolveAt: number;
}

export interface PublicBoardView {
  readonly boardId: BoardId;
  /** Null for the single shared grid. */
  readonly ownerId: PlayerId | null;
  readonly cards: readonly PublicCardView[];
}

export type AttemptStep = 'IDLE' | 'FLIPPED_FIRST' | 'EVALUATING';

export interface PublicAttemptView {
  readonly playerId: PlayerId;
  readonly boardId: BoardId;
  readonly phase: AttemptStep;
  /**
   * The explicit selection: the 1..`flipLimit` cards opened in the active action, and
   * nothing else. It is never derived from the grid, so face-up trap cards, scouting
   * reveals and an opponent's open cards can never pollute it.
   */
  readonly currentSelection: readonly CardId[];
  /** True while the opened cards are being judged. */
  readonly isEvaluating: boolean;
  readonly flipLimit: number;
  readonly pending: PublicPendingView | null;
  readonly stunnedUntil: number;
}

/** A cleared grid waiting on its clearer's Awakening Surge blessing. */
export interface PublicAwakeningView {
  readonly playerId: PlayerId;
  readonly boardId: BoardId;
  /** Engine time at which the blessing is forced to Sorcery Restoration. */
  readonly decideBy: number;
}

export interface PublicMatchView {
  readonly matchId: string;
  readonly boardMode: BoardMode;
  readonly phase: TurnPhase;
  /** Null in DUAL mode, where both players act concurrently. */
  readonly turnOwner: PlayerId | null;
  readonly turnNumber: number;
  /** Engine time at which the active player's turn times out; null in DUAL and sandbox. */
  readonly turnDeadline: number | null;
  /** Budget for the current turn; null when the mode runs no clock (DUAL, sandbox). */
  readonly turnTimeMs: number | null;
  /** First card the active SHARED-mode player has open, if any. */
  readonly openFirstId: CardId | null;
  readonly pending: PublicPendingView | null;
  readonly players: readonly PublicPlayerView[];
  /** Turn counter in the turn-based modes; resolved-attempt counter in DUAL mode. Drives memory decay. */
  readonly cycles: number;
  readonly boards: readonly PublicBoardView[];
  /** Primary grid: the shared board, or player 1's grid in DUAL mode. */
  readonly board: readonly PublicCardView[];
  readonly attempts: readonly PublicAttemptView[];
  /** A Deadly Sentencing escape prompt or trial in progress, or null. */
  readonly sentencing: PublicSentencingView | null;
  /** An Awakening Surge blessing waiting to be chosen, or null. */
  readonly awakening: PublicAwakeningView | null;
  readonly result: MatchResult | null;
}

/** True when the card carries a modifier of that kind. */
export function hasModifier(card: Card, kind: CardEffectModifier['kind']): boolean {
  return card.effectModifiers.some((modifier) => modifier.kind === kind);
}

/** Projects a server-side card into its client-safe shape. */
export function toPublicCard(card: Card, position: number, reveal = false): PublicCardView {
  const corrupted = hasModifier(card, CARD_EFFECT_KIND.FLESH);
  // The training X-ray shows every identity; corruption still masks the face on purpose.
  const faceUp = (reveal || card.state === CARD_STATE.REVEALED || card.state === CARD_STATE.MATCHED) && !corrupted;
  return {
    id: card.id,
    position,
    state: card.state,
    revealedBy: card.revealedBy,
    pairId: faceUp ? card.pairId : null,
    characterId: faceUp ? card.characterId : null,
    type: faceUp ? card.type : null,
    trapId: faceUp ? card.trapId : null,
    effectModifiers: card.effectModifiers,
    corrupted,
    locked: hasModifier(card, CARD_EFFECT_KIND.LOCKED),
  };
}

/** The grid a player flips on: the shared grid, or that player's own grid in the dual modes. */
export function boardIdOfPlayer(view: PublicMatchView, playerId: PlayerId): BoardId {
  if (!usesOwnBoards(view.boardMode)) return SHARED_BOARD_ID;
  return view.boards.find((candidate) => candidate.ownerId === playerId)?.boardId ?? SHARED_BOARD_ID;
}

/** The grid a player interacts with: the shared board, or that player's own grid. */
export function boardOfPlayer(view: PublicMatchView, playerId: PlayerId): readonly PublicCardView[] {
  const boardId = boardIdOfPlayer(view, playerId);
  return view.boards.find((candidate) => candidate.boardId === boardId)?.cards ?? [];
}

export function attemptOfPlayer(view: PublicMatchView, playerId: PlayerId): PublicAttemptView | undefined {
  return view.attempts.find((attempt) => attempt.playerId === playerId);
}

/** True when `playerId` may open a card right now. */
export function canPlayerAct(view: PublicMatchView, playerId: PlayerId, now: number): boolean {
  if (view.result !== null) return false;
  const attempt = attemptOfPlayer(view, playerId);
  if (!attempt || attempt.phase === 'EVALUATING') return false;
  if (attempt.stunnedUntil > now) return false;
  if (isTurnBasedMode(view.boardMode)) return view.turnOwner === playerId && view.phase !== 'MATCH_START';
  return true;
}
