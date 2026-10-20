export type PlayerId = string;
export type CardId = string;
export type PairId = string;
export type BoardId = string;

export const BOARD_MODE = {
  /** Two independent grids, one per player. Both act concurrently, no turn order. */
  DUAL: 'DUAL',
  /** Two independent grids, one per player, strict alternation: you flip on your own grid. */
  DUAL_TURN_BASED: 'DUAL_TURN_BASED',
  /** One shared grid, turn-based. */
  SHARED: 'SHARED',
} as const;
export type BoardMode = (typeof BOARD_MODE)[keyof typeof BOARD_MODE];

/** True when the mode alternates turns instead of letting both seats act at once. */
export function isTurnBasedMode(mode: BoardMode): boolean {
  return mode !== BOARD_MODE.DUAL;
}

/** True when every player plays their own grid instead of one shared grid. */
export function usesOwnBoards(mode: BoardMode): boolean {
  return mode !== BOARD_MODE.SHARED;
}

export const CARD_STATE = {
  HIDDEN: 'HIDDEN',
  REVEALED: 'REVEALED',
  MATCHED: 'MATCHED',
  DISABLED: 'DISABLED',
} as const;
export type CardState = (typeof CARD_STATE)[keyof typeof CARD_STATE];

export const CARD_TYPE = {
  STANDARD: 'STANDARD',
  SYNERGY: 'SYNERGY',
  TRAP: 'TRAP',
} as const;
export type CardType = (typeof CARD_TYPE)[keyof typeof CARD_TYPE];

/**
 * Turn FSM for SHARED mode: the active seat flips up to its flip limit.
 * DUAL mode runs concurrent attempts, so it stays in IN_PROGRESS until MATCH_OVER.
 */
export const TURN_PHASE = {
  MATCH_START: 'MATCH_START',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING_FOR_P1: 'WAITING_FOR_P1',
  P1_FLIPPED_FIRST: 'P1_FLIPPED_FIRST',
  P1_FLIPPED_SECOND: 'P1_FLIPPED_SECOND',
  WAITING_FOR_P2: 'WAITING_FOR_P2',
  P2_FLIPPED_FIRST: 'P2_FLIPPED_FIRST',
  P2_FLIPPED_SECOND: 'P2_FLIPPED_SECOND',
  EVALUATING: 'EVALUATING',
  MATCH_OVER: 'MATCH_OVER',
} as const;
export type TurnPhase = (typeof TURN_PHASE)[keyof typeof TURN_PHASE];

export type CharacterId =
  | 'yuji_itadori'
  | 'aoi_todo'
  | 'nobara_kugisaki'
  | 'mahito'
  | 'kento_nanami'
  | 'jogo'
  | 'satoru_gojo'
  | 'sukuna'
  | 'megumi_fushiguro'
  | 'kinji_hakari'
  | 'higuruma';

/** Characters plus summons/tools/body parts that appear on synergy and trap cards. */
export type CardSubjectId = CharacterId | 'divine_dog' | 'ratio_blade' | 'six_eyes';

export type SkillId =
  | 'divergent_fist'
  | 'boogie_woogie'
  | 'hairpin'
  | 'critical_ratio'
  | 'infinity'
  | 'cleave'
  | 'ten_shadows_nue'
  | 'idle_transfiguration'
  | 'ember_insects'
  | 'gamble_turn'
  | 'gavel_strike'
  | 'executioners_sword';

export type UltimateId =
  | 'soul_strike'
  | 'potential_120'
  | 'resonance_burst'
  | 'overtime_collapse'
  | 'unlimited_void'
  | 'malevolent_shrine'
  | 'chimera_shadow_garden'
  | 'self_embodiment_of_perfection'
  | 'coffin_of_the_iron_mountain'
  | 'idle_death_gamble'
  | 'deadly_sentencing';

export const ULTIMATE_TYPE = {
  /** True Domain Expansion: grants a lasting sure-hit field. */
  DOMAIN: 'DOMAIN',
  /** Simple Domain / Maximum Technique: neutralizes an enemy domain, then applies its own effect. */
  SIMPLE_DOMAIN_MAXIMUM: 'SIMPLE_DOMAIN_MAXIMUM',
} as const;
export type UltimateType = (typeof ULTIMATE_TYPE)[keyof typeof ULTIMATE_TYPE];

export type DomainId =
  | 'unlimited_void'
  | 'malevolent_shrine'
  | 'chimera_shadow_garden'
  | 'idle_death_gamble'
  | 'self_embodiment_of_perfection'
  | 'coffin_of_the_iron_mountain'
  | 'deadly_sentencing';

export type TrapId = 'sukuna_finger';
export type SynergyId = 'brotherhood_barrage' | 'divine_dog_pact' | 'seven_three_blade' | 'six_eyes_vision';

/** Card modifiers: planted by skills on the grid the target plays on. */
export const CARD_EFFECT_KIND = {
  /** Cursed nail: stuns the flipper and hurts. */
  NAILED: 'NAILED',
  /** Ember insect: detonates on the flipper. */
  LAVA: 'LAVA',
  /** Transfigured flesh: the card's real face is hidden while active. */
  FLESH: 'FLESH',
  /** Sealed: the card cannot be flipped while active. */
  LOCKED: 'LOCKED',
} as const;
export type CardEffectKind = (typeof CARD_EFFECT_KIND)[keyof typeof CARD_EFFECT_KIND];

export interface CardEffectModifier {
  readonly kind: CardEffectKind;
  readonly sourceId: PlayerId;
  /** Turns until the modifier expires; null = until the card is matched. */
  readonly turnsRemaining: number | null;
  /**
   * Set on a Confiscated Cursed Tool: the victim whose turns age this seal (it is not
   * aged by its caster's turns). Absent on every other modifier.
   */
  readonly tickOwner?: PlayerId;
}

export interface Card {
  readonly id: CardId;
  readonly pairId: PairId;
  readonly characterId: CardSubjectId;
  readonly type: CardType;
  /** Set only for TRAP cards. */
  readonly trapId: TrapId | null;
  state: CardState;
  revealedBy: PlayerId | null;
  effectModifiers: CardEffectModifier[];
}

export const STATUS_KIND = {
  /** Cannot be reduced below 1 HP. */
  IMMORTAL: 'IMMORTAL',
  /** All incoming damage is negated while active. */
  ABSOLUTE_SHIELD: 'ABSOLUTE_SHIELD',
  /**
   * Barrier points. Unlike the other kinds this is a one-shot *grant*: applying it
   * adds to `PlayerState.shield` (capped at half of max HP) and is never stored as a
   * lasting effect, so a barrier can soak damage on any later turn.
   */
  SHIELD: 'SHIELD',
  /** The next successful match deals `value`x damage. */
  CRITICAL_STRIKE: 'CRITICAL_STRIKE',
  /** Black Flash triggers from the next match instead of the second. */
  FLASH_WINDOW: 'FLASH_WINDOW',
  /** Matches ignore enemy shields. */
  PIERCING_ATTACKS: 'PIERCING_ATTACKS',
  /** Takes `value` damage at the end of its owner's turn. */
  DAMAGE_OVER_TIME: 'DAMAGE_OVER_TIME',
  /** The owner's next successful match queues a delayed shockwave. */
  DIVERGENT_MARK: 'DIVERGENT_MARK',
  /** Queued blast resolved at the owner's turn end. */
  SHOCKWAVE: 'SHOCKWAVE',
  /** Takes `value` damage every time its owner mismatches. */
  RESONANCE_RECOIL: 'RESONANCE_RECOIL',
  /** Adds `value` extra cards to each flip attempt. */
  EXTRA_FLIP: 'EXTRA_FLIP',
  /** Skips `value` of its owner's turns. */
  SKIP_TURNS: 'SKIP_TURNS',
  /** The owner's turns last `value` ms. */
  SHORT_TIMER: 'SHORT_TIMER',
  /** Cursed energy is pinned at `value` while active. */
  CE_LOCKED: 'CE_LOCKED',
  /** Lowers the owner's maximum HP by `value`. */
  MAX_HP_REDUCTION: 'MAX_HP_REDUCTION',
  /** The owner's active domain is neutralized while this lasts. */
  DOMAIN_NULLIFIED: 'DOMAIN_NULLIFIED',
  /** The owner's next successful match is a high-stakes gamble (Hakari's Gamble Turn). */
  GAMBLE_TURN: 'GAMBLE_TURN',
  /** Matches deal `value`x damage while active (Idle Death Gamble's golden jackpot). */
  DAMAGE_BOOST: 'DAMAGE_BOOST',
  /** Yuji's Soul Divergent Strike: the next Divergent Fist is a current-HP piercing strike. */
  SOUL_STRIKE: 'SOUL_STRIKE',
} as const;
export type StatusKind = (typeof STATUS_KIND)[keyof typeof STATUS_KIND];

export interface StatusEffect {
  readonly kind: StatusKind;
  readonly sourceId: PlayerId;
  /** Counted down at the end of the owner's turns; null = until match end. */
  readonly turnsRemaining: number | null;
  /** Kind-specific magnitude, e.g. shield HP, burn damage per turn, crit multiplier. */
  readonly value: number;
}

export const MATCH_END_REASON = {
  /** A player was reduced to 0 HP. Clearing a grid no longer ends the match: it is re-dealt. */
  KNOCKOUT: 'KNOCKOUT',
} as const;
export type MatchEndReason = (typeof MATCH_END_REASON)[keyof typeof MATCH_END_REASON];

export interface MatchResult {
  readonly winnerId: PlayerId | null;
  readonly reason: MatchEndReason;
  readonly endedAt: number;
}

/** Cards opened in one attempt, waiting for the evaluation window to close. */
export interface PendingResolution {
  readonly outcome: 'MATCH' | 'MISMATCH';
  readonly cardIds: readonly CardId[];
  readonly resolveAt: number;
}

export interface ActiveDomain {
  readonly domainId: DomainId;
  readonly turnsRemaining: number;
}

/** How one Idle Death Gamble spin landed. */
export type PachinkoTier = 'MISS' | 'REGULAR' | 'GOLDEN' | 'SUPREME' | 'BANKRUPT';

/**
 * Idle Death Gamble slot state. `spinsLeft` counts the free re-spins of the open Domain
 * (0 when no Domain is spinning). `pity` is kept across Domains: each bankrupt Domain
 * adds to it, and it raises the forced-jackpot chance of the next spins until a jackpot lands.
 */
export interface PachinkoState {
  readonly spinsLeft: number;
  readonly pity: number;
  /** Set by a golden or supreme jackpot: when its immortality ends the Domain resets and refunds its CE. */
  readonly resetOnExpiry: boolean;
  /**
   * The jackpot whose immortality is running, so the music can tell a regular jackpot from a
   * golden one and 7-7-7 (SUPREME). Absent when no jackpot is active; cleared when it ends.
   */
  readonly jackpot?: 'REGULAR' | 'GOLDEN' | 'SUPREME';
}

/**
 * The window a Simple Domain or Maximum Technique stays open for.
 *
 * A domain counter is cast by sorcerers who own no domain of their own, so there is no
 * `domainId` to record: the window names the ultimate that raised it instead. It is kept
 * on the caster even when no enemy domain was standing to cancel, so the UI can show an
 * anti-domain that is armed and waiting rather than only a counter that already fired.
 */
export interface SimpleDomainWindow {
  readonly ultimateId: UltimateId;
  readonly turnsRemaining: number;
}

/**
 * Executioner's Sword: granted by a Deadly Sentencing trial that the victim lost at least
 * once. It replaces the caster's skill for `turnsRemaining` of the caster's turns.
 */
export interface ExecutionerState {
  /** True damage dealt by the sword, fixed by the trial's mistake count. */
  readonly damage: number;
  readonly turnsRemaining: number;
  /**
   * True until the owner's next turn close. The trial always ends inside the caster's
   * open turn, so that turn's own close must not count the sword down.
   */
  readonly graceClose: boolean;
}

export const COURTROOM_PHASE = {
  /** The four cards are face-up so the victim can memorize their slots. */
  REVEAL: 'REVEAL',
  /** The cards are face-down and physically swap slots, one swap at a time. */
  SHUFFLE: 'SHUFFLE',
  /** The prosecutor (caster) names the subject the victim must locate. */
  PROSECUTE: 'PROSECUTE',
  /** The Judgeman has named a target; the victim picks a face-down slot. */
  PICK: 'PICK',
  /**
   * The verdict is on screen: the picked card is face-up, the true slot is named, and the
   * trial holds this beat before it deals the next round or closes.
   */
  INSPECT: 'INSPECT',
} as const;
export type CourtroomPhase = (typeof COURTROOM_PHASE)[keyof typeof COURTROOM_PHASE];

/**
 * A Deadly Sentencing trial in progress. The caster's domain is the only thing that
 * opens it, and it is closed by the engine once every round is judged.
 */
export interface CourtroomState {
  readonly casterId: PlayerId;
  readonly victimId: PlayerId;
  /** 1-based round number. */
  round: number;
  readonly totalRounds: number;
  /** Subject at each physical slot. Hidden from the public view outside the reveal. */
  slots: CardSubjectId[];
  phase: CourtroomPhase;
  /** Engine time when the current timed phase ends; null while waiting for a pick. */
  phaseEndsAt: number | null;
  /** Engine time by which the victim must pick; set only while the pick is open. */
  pickDeadlineAt: number | null;
  /** Engine time at which a sandbox dummy victim answers on its own; null for a human victim. */
  pickAutoAt: number | null;
  /** Slot pairs swapped during the current shuffle, in the order they happen. */
  swaps: Array<readonly [number, number]>;
  /** The subject the Judgeman asked for. Set only once the shuffle has finished. */
  target: CardSubjectId | null;
  /** Slot the victim picked this round; set once the verdict is in, cleared by the next deal. */
  pickedSlot: number | null;
  /** Wrong picks so far across all rounds. */
  mistakes: number;
}

/**
 * A Simple Domain prompt: the victim may spend 100 CE to neutralize an incoming
 * Deadly Sentencing before the trial begins. Closes on the victim's answer.
 */
export interface EscapeWindow {
  readonly casterId: PlayerId;
  readonly victimId: PlayerId;
  /** Rounds the trial will run if the victim does not escape. */
  readonly rounds: number;
  /** Engine time at which the prompt lapses and the trial begins without an escape. */
  readonly closesAt: number;
}

/** The three blessings an Awakening Surge clearer chooses between. */
export const BLESSING = {
  LATENT_BLACK_FLASH: 'LATENT_BLACK_FLASH',
  SORCERY_RESTORATION: 'SORCERY_RESTORATION',
  SIX_EYES_INSIGHT: 'SIX_EYES_INSIGHT',
} as const;
export type BlessingId = (typeof BLESSING)[keyof typeof BLESSING];

export interface PlayerState {
  readonly id: PlayerId;
  /** Mutable only so the training dummy can take on another fighter. */
  characterId: CharacterId;
  /** The match setting: this player's maximum HP before any permanent reduction. */
  readonly maxHp: number;
  /** Current HP, never above `maxHp` minus any permanent reduction. */
  hp: number;
  /**
   * Barrier points soaking damage before HP. Defaults to 0 and only ever grows to
   * half of the player's maximum HP. Piercing damage (Kento Nanami's 7:3 Ratio,
   * Soul Strike) ignores it entirely.
   */
  shield: number;
  cursedEnergy: number;
  activeEffects: StatusEffect[];
  /** Consecutive pair matches in the current turn streak. */
  comboStreak: number;
  pairsMatched: number;
  activeDomain: ActiveDomain | null;
  /** An open Simple Domain / Maximum Technique window, or null when none is armed. */
  activeSimpleDomain: SimpleDomainWindow | null;
  /** Engine time until which flips and abilities are locked out. */
  stunUntil: number;
  /** Executioner's Sword, or null when no trial granted one. */
  executioner: ExecutionerState | null;
  /** Latent Black Flash blessing: the next pair this player matches is a guaranteed Black Flash. */
  guaranteedBlackFlash: boolean;
  /** Idle Death Gamble slot state (see `PachinkoState`). */
  pachinko: PachinkoState;
}

export interface PlayerSetup {
  readonly id: PlayerId;
  readonly characterId: CharacterId;
}

/**
 * How a cleared board's Awakening Surge is settled.
 * MANUAL_CHOICE opens the chooser and pauses the clock until the clearer picks.
 * RANDOM_AUTO rolls one blessing at random and applies it at once, without pausing play.
 */
export const BOARD_CLEAR_REWARD = {
  MANUAL_CHOICE: 'MANUAL_CHOICE',
  RANDOM_AUTO: 'RANDOM_AUTO',
} as const;
export type BoardClearRewardMode = (typeof BOARD_CLEAR_REWARD)[keyof typeof BOARD_CLEAR_REWARD];

/**
 * The reward mode a match runs with. Unset means the default for its board layout:
 * simultaneous (DUAL) play runs instant random so the fight never stops, and the
 * turn-based modes keep the interactive chooser.
 */
export function boardClearRewardOf(config: Pick<MatchConfig, 'boardMode' | 'boardClearReward'>): BoardClearRewardMode {
  if (config.boardClearReward) return config.boardClearReward;
  return config.boardMode === BOARD_MODE.DUAL ? BOARD_CLEAR_REWARD.RANDOM_AUTO : BOARD_CLEAR_REWARD.MANUAL_CHOICE;
}

export interface MatchConfig {
  readonly matchId: string;
  readonly boardMode: BoardMode;
  readonly players: readonly [PlayerSetup, PlayerSetup];
  readonly boardSize: 16 | 36;
  readonly trapCount: number;
  readonly synergyPairCount: number;
  /** Starting maximum HP for every player. Defaults to `GAME_CONSTANTS.MAX_HP`. */
  readonly startingHp?: number;
  /** How an Awakening Surge is settled. Defaults by board layout, see `boardClearRewardOf`. */
  readonly boardClearReward?: BoardClearRewardMode;
  /**
   * Training ground: player 2 is an inanimate dummy with a huge immortal HP pool, the
   * turn never passes to it and no turn clock runs. Only the debug controls act on it.
   */
  readonly sandbox?: boolean;
}

// ---------------------------------------------------------------------------
// Setup choices: every field can be left to chance
// ---------------------------------------------------------------------------

/**
 * Dropdown sentinel meaning "roll this when the match starts". It is never a value the
 * engine sees: `resolveMatchConfig` turns every sentinel into a concrete choice first.
 */
export const RANDOM_CHOICE = 'RANDOM' as const;
export type RandomChoice = typeof RANDOM_CHOICE;

export const SETUP_OPPONENT = {
  PVE: 'PVE',
  PVP: 'PVP',
  ONLINE: 'ONLINE',
  SANDBOX: 'SANDBOX',
  /** Rolled into PVE or PVP: a roll can never open a room or a training ground by itself. */
  RANDOM: 'RANDOM',
} as const;
export type SetupOpponent = (typeof SETUP_OPPONENT)[keyof typeof SETUP_OPPONENT];

/** The opponent after resolution: never the `RANDOM` sentinel. */
export type ConcreteOpponent = Exclude<SetupOpponent, RandomChoice>;

export type SetupBoardLayout = BoardMode | RandomChoice;
export type SetupGridSize = 16 | 36 | RandomChoice;
export type SetupStartingHp = number | RandomChoice;
export type SetupBoardClearReward = BoardClearRewardMode | RandomChoice;
export type SetupCharacter = CharacterId | RandomChoice;
export type SetupCount = number | RandomChoice;

/**
 * The match setup exactly as the modal holds it, before anything is rolled.
 *
 * Field names are the player-facing ones (`boardLayout`, `gridSize`, `cursedTraps`,
 * `loreSynergies`) rather than the engine's terse config names, so the UI can hand its
 * whole form over without translating each control.
 */
export interface MatchSetup {
  readonly opponent: SetupOpponent;
  readonly boardLayout: SetupBoardLayout;
  readonly boardClearReward: SetupBoardClearReward;
  readonly gridSize: SetupGridSize;
  readonly startingHp: SetupStartingHp;
  readonly p1Character: SetupCharacter;
  readonly p2Character: SetupCharacter;
  readonly cursedTraps: SetupCount;
  readonly loreSynergies: SetupCount;
}

/** A setup with every field concrete, plus the config the engine consumes. */
export interface ResolvedMatchSetup {
  readonly setup: MatchSetup;
  readonly config: MatchConfig;
}

export function isRandomChoice(value: unknown): value is RandomChoice {
  return value === RANDOM_CHOICE;
}

// ---------------------------------------------------------------------------
// Ability effect language shared by skills, ultimates and lore synergies
// ---------------------------------------------------------------------------

export type EffectTarget = 'SELF' | 'OPPONENT';
/** Which grid an effect touches: the caster's own, or the one the opponent plays on. */
export type EffectBoard = 'OWN' | 'OPPONENT';
/** Which cards a scouting effect reveals. */
export type ScoutPool = 'HIDDEN' | 'PAIR' | 'ALL';

/** Visual cue the presentation layer plays when an effect resolves. */
export type VfxCue =
  | 'SKILL'
  | 'CLEAVE'
  | 'DOMAIN'
  | 'SIMPLE_DOMAIN'
  | 'CLAW'
  | 'RATIO'
  | 'CLASH'
  | 'SIX_EYES'
  | 'STRIKE';

export const DAMAGE_CAUSE = {
  MATCH: 'MATCH',
  SYNERGY: 'SYNERGY',
  SKILL: 'SKILL',
  ULTIMATE: 'ULTIMATE',
  OVER_TIME: 'OVER_TIME',
  SHOCKWAVE: 'SHOCKWAVE',
  RECOIL: 'RECOIL',
  CARD_EFFECT: 'CARD_EFFECT',
} as const;
export type DamageCause = (typeof DAMAGE_CAUSE)[keyof typeof DAMAGE_CAUSE];

export interface StatusSpec {
  readonly status: StatusKind;
  readonly value: number;
  readonly turns: number | null;
}

export type AbilityEffect =
  | { readonly kind: 'STATUS'; readonly target: EffectTarget; readonly spec: StatusSpec }
  | {
      readonly kind: 'DAMAGE';
      readonly target: EffectTarget;
      /** Flat damage; ignored when `maxHpFraction` is set. */
      readonly amount: number;
      readonly piercing: boolean;
      /** Scale the hit off the target's current maximum HP instead of `amount`. */
      readonly maxHpFraction?: number;
      /** Scale the hit off the target's CURRENT HP instead of `amount` (minimum 1). */
      readonly currentHpFraction?: number;
    }
  /** Permanently removes a share of the target's maximum HP. */
  | { readonly kind: 'MAX_HP_CUT'; readonly target: EffectTarget; readonly fraction: number }
  | { readonly kind: 'HEAL'; readonly amount: number }
  | { readonly kind: 'CE_GAIN'; readonly amount: number }
  | { readonly kind: 'CE_SIPHON'; readonly amount: number }
  | { readonly kind: 'CE_DRAIN'; readonly target: EffectTarget; readonly amount: number }
  | { readonly kind: 'BOARD_SWAP'; readonly board: EffectBoard; readonly count: number }
  | {
      readonly kind: 'PLANT_MODIFIER';
      readonly board: EffectBoard;
      readonly modifier: CardEffectKind;
      readonly count: number;
      readonly turnsRemaining: number | null;
    }
  | {
      readonly kind: 'SCOUT';
      readonly board: EffectBoard;
      readonly pool: ScoutPool;
      readonly count: number;
      readonly revealMs: number;
      readonly cue: VfxCue;
    }
  | { readonly kind: 'DETONATE_CARD'; readonly board: EffectBoard; readonly damage: number; readonly revealMs: number }
  | { readonly kind: 'AUTO_MATCH_PAIRS'; readonly board: EffectBoard; readonly count: number }
  | { readonly kind: 'DOMAIN_COUNTER'; readonly turns: number }
  /** Opens a Deadly Sentencing trial of `rounds` rounds on the victim. */
  | { readonly kind: 'COURTROOM_TRIAL'; readonly rounds: number }
  /** Opens the Idle Death Gamble slot for `spins` free re-spins. */
  | { readonly kind: 'PACHINKO_OPEN'; readonly spins: number };

export interface AbilityDefinition {
  readonly id: SkillId | UltimateId;
  readonly name: string;
  readonly characterId: CharacterId;
  readonly cost: number;
  /** Shown on the ability button and in the log. */
  readonly description: string;
  readonly effects: readonly AbilityEffect[];
}

export interface SkillDefinition extends AbilityDefinition {
  readonly id: SkillId;
}

export interface UltimateDefinition extends AbilityDefinition {
  readonly id: UltimateId;
  readonly type: UltimateType;
  /** Set for DOMAIN ultimates only. */
  readonly domainId: DomainId | null;
}
