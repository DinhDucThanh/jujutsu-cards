import type {
  BoardId,
  BlessingId,
  BoardMode,
  CardEffectKind,
  CardId,
  CardType,
  CharacterId,
  DamageCause,
  DomainId,
  MatchResult,
  PachinkoTier,
  PairId,
  PlayerId,
  SkillId,
  StatusKind,
  TrapId,
  TurnPhase,
  UltimateId,
  UltimateType,
  VfxCue,
} from './types.js';

export type EngineErrorCode =
  | 'NOT_STARTED'
  | 'ALREADY_STARTED'
  | 'GAME_OVER'
  | 'INVALID_TIME'
  | 'TIME_REGRESSED'
  | 'UNKNOWN_PLAYER'
  | 'NOT_YOUR_TURN'
  | 'EVALUATING'
  | 'FLIP_IN_PROGRESS'
  | 'CARD_NOT_FOUND'
  /** The card exists, but on a grid this player may not flip on. */
  | 'WRONG_BOARD'
  | 'CARD_UNAVAILABLE'
  | 'CARD_LOCKED'
  | 'STUNNED'
  | 'INSUFFICIENT_CE'
  | 'NO_SKILL'
  | 'NO_DOMAIN'
  | 'NO_SPINS'
  | 'DOMAIN_ALREADY_ACTIVE'
  /** Training-ground controls are refused outside a sandbox match. */
  | 'NOT_SANDBOX'
  /** A Deadly Sentencing escape prompt or trial is open, so skills, flips and domains wait. */
  | 'SENTENCING_IN_PROGRESS'
  /** No Deadly Sentencing escape prompt is waiting on this player. */
  | 'NO_ESCAPE_WINDOW'
  /** No Deadly Sentencing trial is in progress. */
  | 'NO_COURTROOM'
  /** The trial is still revealing or shuffling; the Judgeman has not asked yet. */
  | 'COURTROOM_BUSY'
  /** The pick names a slot outside the trial's four. */
  | 'INVALID_SLOT'
  /** The prosecutor names a subject that is not one of the trial's four. */
  | 'INVALID_SUBJECT'
  /** An Awakening Surge blessing is waiting, so skills, flips and domains wait. */
  | 'AWAKENING_IN_PROGRESS'
  /** No Awakening Surge blessing is waiting. */
  | 'NO_AWAKENING'
  /** Only the player who cleared the board may choose its blessing. */
  | 'NOT_YOUR_AWAKENING'
  /** The blessing id is not one of the three offered. */
  | 'INVALID_BLESSING'
  /** The dummy's new fighter is not in the roster. */
  | 'INVALID_CHARACTER'
  /** The trap is not in the trap catalogue. */
  | 'INVALID_TRAP'
  /** The board is mid-flip or mid-resolution, so a trap cannot land on it yet. */
  | 'FLIP_IN_PROGRESS'
  /** A match-resolving step is pending, so the grid is not settled. */
  | 'EVALUATING'
  /** No hidden pair is left on the grid to convert. */
  | 'CARD_UNAVAILABLE';

export type EnergyCause =
  | 'SKILL'
  | 'ULTIMATE'
  | 'SYNERGY'
  | 'SIPHON'
  | 'DRAIN'
  | 'CARD_EFFECT'
  | 'MISMATCH'
  | 'MATCH'
  | 'AWAKENING'
  | 'SANDBOX';

/** Training-ground controls, reported so the log can show what the debugger did. */
export type DebugAction =
  | 'ENERGY'
  | 'FLASH_READY'
  | 'BARRIER'
  | 'SPAWN_SYNERGY'
  | 'RESHUFFLE'
  | 'CLEAR_STATUSES'
  | 'DUMMY'
  | 'SIMPLE_DOMAIN'
  | 'BREAK_DOMAIN'
  | 'HP'
  | 'TRAP'
  | 'LAYOUT';

export interface DebugEvent {
  readonly type: 'DEBUG_ACTION';
  readonly action: DebugAction;
  readonly playerId: PlayerId | null;
  readonly detail: string;
}

export type GameEvent =
  | { readonly type: 'MATCH_STARTED'; readonly at: number; readonly boardMode: BoardMode }
  | { readonly type: 'PHASE_CHANGED'; readonly from: TurnPhase; readonly to: TurnPhase }
  | { readonly type: 'TURN_STARTED'; readonly playerId: PlayerId; readonly turnNumber: number }
  | { readonly type: 'TURN_ENDED'; readonly playerId: PlayerId; readonly reason: 'MISMATCH' | 'TIMEOUT' | 'TRAP' }
  | { readonly type: 'TURN_TIMED_OUT'; readonly playerId: PlayerId }
  | { readonly type: 'TURN_SKIPPED'; readonly playerId: PlayerId; readonly reason: 'DOMAIN' }
  | {
      readonly type: 'SIMPLE_DOMAIN_OPENED';
      readonly playerId: PlayerId;
      readonly ultimateId: UltimateId;
      readonly turnsRemaining: number;
    }
  | { readonly type: 'SIMPLE_DOMAIN_CLOSED'; readonly playerId: PlayerId; readonly ultimateId: UltimateId }
  | { readonly type: 'CARD_REVEALED'; readonly playerId: PlayerId; readonly cardId: CardId }
  | { readonly type: 'CARD_HIDDEN'; readonly cardId: CardId }
  | {
      readonly type: 'CARDS_REVEALED';
      readonly sourceId: PlayerId;
      readonly boardId: BoardId;
      readonly cardIds: readonly CardId[];
      readonly revealMs: number;
      readonly cue: VfxCue;
    }
  | {
      readonly type: 'CARD_MODIFIED';
      readonly sourceId: PlayerId;
      readonly boardId: BoardId;
      readonly cardIds: readonly CardId[];
      readonly modifier: CardEffectKind;
      readonly turnsRemaining: number | null;
    }
  | {
      readonly type: 'CARD_EFFECT_TRIGGERED';
      readonly playerId: PlayerId;
      readonly cardId: CardId;
      readonly modifier: CardEffectKind;
      readonly damage: number;
      readonly stunMs: number;
      readonly ceDrain: number;
    }
  | {
      readonly type: 'CARDS_SWAPPED';
      readonly boardId: BoardId;
      readonly cardIds: readonly [CardId, CardId];
      readonly positions: readonly [number, number];
    }
  | {
      readonly type: 'CARDS_AUTO_MATCHED';
      readonly playerId: PlayerId;
      readonly boardId: BoardId;
      readonly cardIds: readonly [CardId, CardId];
      readonly pairId: PairId;
    }
  | {
      readonly type: 'PAIR_MATCHED';
      readonly playerId: PlayerId;
      readonly pairId: PairId;
      readonly cardIds: readonly CardId[];
      readonly cardType: CardType;
    }
  | { readonly type: 'PAIR_MISMATCHED'; readonly playerId: PlayerId; readonly cardIds: readonly CardId[] }
  | { readonly type: 'BLACK_FLASH'; readonly playerId: PlayerId; readonly streak: number }
  | { readonly type: 'SYNERGY_TRIGGERED'; readonly playerId: PlayerId; readonly synergyId: string; readonly cue: VfxCue }
  | {
      readonly type: 'DAMAGE_DEALT';
      readonly sourceId: PlayerId;
      readonly targetId: PlayerId;
      readonly dealt: number;
      readonly absorbed: number;
      readonly critical: boolean;
      /** True when the hit went straight through a barrier instead of chewing it down. */
      readonly piercing: boolean;
      readonly cause: DamageCause;
    }
  | { readonly type: 'HEALED'; readonly playerId: PlayerId; readonly amount: number }
  /** Mahito's Idle Transfiguration permanently shrank the victim's soul and HP pool. */
  | {
      readonly type: 'MAX_HP_CUT';
      readonly playerId: PlayerId;
      readonly sourceId: PlayerId;
      /** HP removed from the pool for good. */
      readonly amount: number;
      /** The share that was removed, as a fraction of the pool before the cut. */
      readonly fraction: number;
      /** The victim's new effective maximum HP. */
      readonly maxHp: number;
    }
  /** Jogo burned a seal off the shared grid and absorbed its cursed energy. */
  | {
      readonly type: 'SEAL_ABSORBED';
      readonly playerId: PlayerId;
      readonly boardId: BoardId;
      readonly cardId: CardId;
      readonly ceGain: number;
    }
  | {
      readonly type: 'CE_CHANGED';
      readonly playerId: PlayerId;
      readonly delta: number;
      readonly cause: EnergyCause;
    }
  | { readonly type: 'STUNNED'; readonly playerId: PlayerId; readonly until: number }
  /** A board was fully matched: its clearer may now choose an Awakening Surge blessing. */
  | {
      readonly type: 'AWAKENING_OPENED';
      readonly playerId: PlayerId;
      readonly boardId: BoardId;
      readonly decideBy: number;
    }
  /** The Awakening Surge was settled, by the clearer's choice or by the timeout. */
  | {
      readonly type: 'AWAKENING_CHOSEN';
      readonly playerId: PlayerId;
      readonly boardId: BoardId;
      readonly blessing: BlessingId;
      /** True when the blessing was rolled instantly (RANDOM_AUTO) rather than chosen. */
      readonly rolled: boolean;
      readonly automatic: boolean;
    }
  | {
      readonly type: 'STATUS_APPLIED';
      readonly playerId: PlayerId;
      readonly sourceId: PlayerId;
      readonly status: StatusKind;
      readonly value: number;
      readonly turnsRemaining: number | null;
    }
  | {
      /**
       * A turn-based status was translated for the mode in play: turn skips become
       * real-time lock-outs in simultaneous play (and vice versa).
       */
      readonly type: 'STATUS_ADAPTED';
      readonly playerId: PlayerId;
      readonly sourceId: PlayerId;
      readonly status: StatusKind;
      readonly value: number;
      readonly mode: BoardMode;
      readonly note: string;
    }
  | {
      /** A Confiscated Cursed Tool on the shared grid was touched. */
      readonly type: 'CONFISCATED_TOOL';
      readonly playerId: PlayerId;
      readonly casterId: PlayerId;
      readonly cardId: CardId;
      /** BACKLASH: the victim touched it. RECLAIMED: the caster took it back. */
      readonly outcome: 'BACKLASH' | 'RECLAIMED';
    }
  | {
      readonly type: 'TRAP_TRIGGERED';
      readonly playerId: PlayerId;
      readonly cardId: CardId;
      readonly trapId: TrapId;
      readonly cursedEnergyGain: number;
    }
  | {
      readonly type: 'SKILL_ACTIVATED';
      readonly playerId: PlayerId;
      readonly characterId: CharacterId;
      readonly skillId: SkillId;
      readonly name: string;
      readonly cost: number;
      readonly vfx: VfxCue;
    }
  | {
      readonly type: 'ULTIMATE_ACTIVATED';
      readonly playerId: PlayerId;
      readonly characterId: CharacterId;
      readonly ultimateId: UltimateId;
      readonly name: string;
      readonly cost: number;
      readonly ultimateType: UltimateType;
      readonly domainId: DomainId | null;
      readonly turnsRemaining: number | null;
      readonly vfx: VfxCue;
    }
  | { readonly type: 'DOMAIN_EXPIRED'; readonly playerId: PlayerId; readonly domainId: DomainId }
  | {
      /** Every non-trap card on a grid was matched. The UI shows the reshuffle overlay here. */
      readonly type: 'BOARD_CLEARED';
      readonly boardId: BoardId;
      /** Null for the shared grid. */
      readonly ownerId: PlayerId | null;
    }
  | {
      /** A cleared grid has been re-dealt in place: fresh cards, back to HIDDEN. */
      readonly type: 'BOARD_RESPAWNED';
      readonly boardId: BoardId;
      /** Null for the shared grid. */
      readonly ownerId: PlayerId | null;
      /** Cards in the new deal, always the configured board size. */
      readonly cardCount: number;
    }
  | {
      readonly type: 'DOMAIN_NULLIFIED';
      readonly playerId: PlayerId;
      readonly sourceId: PlayerId;
      readonly turnsRemaining: number;
    }
  | { readonly type: 'PACHINKO_OPENED'; readonly playerId: PlayerId; readonly spins: number }
  | { readonly type: 'PACHINKO_SPUN'; readonly playerId: PlayerId; readonly reels: readonly number[]; readonly tier: PachinkoTier; readonly spinsLeft: number; readonly pity: number }
  | { readonly type: 'GAMBLE_RESOLVED'; readonly playerId: PlayerId; readonly won: boolean; readonly amount: number }
  /** The victim may spend 100 CE to neutralize the incoming Deadly Sentencing. */
  | { readonly type: 'SENTENCING_ESCAPE_OFFERED'; readonly casterId: PlayerId; readonly victimId: PlayerId }
  | { readonly type: 'SENTENCING_NEUTRALIZED'; readonly casterId: PlayerId; readonly victimId: PlayerId }
  | { readonly type: 'COURTROOM_OPENED'; readonly casterId: PlayerId; readonly victimId: PlayerId; readonly rounds: number }
  | { readonly type: 'COURTROOM_ROUND_STARTED'; readonly round: number; readonly totalRounds: number }
  | { readonly type: 'COURTROOM_SHUFFLED'; readonly swaps: ReadonlyArray<readonly [number, number]> }
  | {
      readonly type: 'COURTROOM_VERDICT';
      readonly playerId: PlayerId;
      readonly slot: number;
      readonly verdict: 'NOT_GUILTY' | 'GUILTY';
      readonly mistakes: number;
    }
  | { readonly type: 'COURTROOM_CLOSED'; readonly casterId: PlayerId; readonly victimId: PlayerId; readonly mistakes: number }
  | { readonly type: 'EXECUTIONER_GRANTED'; readonly playerId: PlayerId; readonly damage: number; readonly turns: number }
  | { readonly type: 'EXECUTIONER_EXPIRED'; readonly playerId: PlayerId }
  | DebugEvent
  | { readonly type: 'MATCH_ENDED'; readonly result: MatchResult };

/**
 * Every command returns the events produced so far. On rejection, events from the
 * time sync that ran first are still included, so clients see timeouts and results.
 */
export type EngineResult =
  | { readonly ok: true; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly code: EngineErrorCode; readonly events: readonly GameEvent[] };
