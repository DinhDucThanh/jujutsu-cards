import type { CardEffectKind } from './types.js';

/** Reserved board keys: the shared grid, plus one grid per player in DUAL mode. */
export const SHARED_BOARD_ID = 'SHARED';

/** Bounds for the configurable starting HP pool on the setup screen. */
export const HP_LIMITS = {
  MIN: 50,
  MAX: 1000,
  DEFAULT: 100,
  /** Value the custom input starts at once it is revealed. */
  CUSTOM_DEFAULT: 250,
} as const;

/**
 * Every gameplay transition that the player has to *watch* before it is undone.
 * One table, so pacing is tuned in one place instead of being sprinkled as magic
 * numbers through the engine, the UI and the VFX layer.
 */
export const GAME_PACING = {
  /** 3D rotation of a card between back and front. Mirrored by `.card .inner` in CSS. */
  CARD_FLIP_ANIMATION_MS: 500,
  /** Mismatched cards stay face-up this long so players can memorize them. */
  MISMATCH_REVEAL_DURATION_MS: 1_800,
  /** The full-field reveal (Gojo's Six Eyes): exactly 3.0s on screen. */
  SKILL_CARD_REVEAL_DURATION_MS: 3_000,
  /**
   * A peek, not a survey: Megumi's Nue, Todo's 120% Potential and the Divine Dog pact open
   * two cards for 2.0s. Short enough to keep a turn moving, long enough to read the pair.
   */
  CARD_PEEK_REVEAL_DURATION_MS: 2_000,
  /** A planted card blowing up (Hairpin): long enough to read, shorter than a scout. */
  CARD_DETONATION_REVEAL_MS: 1_500,

  /** Screen-impact overlays: Divine Dog claws, 7:3 cut, Black Flash. */
  VFX_BANNER_DURATION_MS: 2_000,
  /** Domain Expansion takeover and its title banner. */
  DOMAIN_ACTIVATION_CINEMATIC_MS: 2_500,
  /** Reshuffle banner while a cleared grid is re-dealt. */
  BOARD_RESPAWN_ANIMATION_MS: 1_500,
  /** Damage numbers floating off a player panel. */
  DAMAGE_FLOAT_MS: 1_200,
  /** Toast for a rejected action, and the deal-in flash of a fresh grid. */
  TOAST_MS: 1_800,
  BOARD_DEAL_MS: 700,
  /** Deadly Sentencing: the trial's four cards stay face-up this long before the shuffle. */
  COURTROOM_REVEAL_DURATION_MS: 4_000,
  /** One physical swap of the trial cards while they are face-down. */
  COURTROOM_SWAP_DURATION_MS: 700,
  /**
   * Longest any single trial step may wait on a human (the escape answer, the prosecutor's
   * target, the victim's pick) before the engine resolves it. Keeps a stalled player from
   * freezing the match. A timed-out pick counts as a GUILTY guess.
   */
  COURTROOM_PHASE_TIMEOUT_MS: 8_000,
  /** Sandbox dummy victim: how long it takes to answer a trial step. */
  COURTROOM_DUMMY_DELAY_MS: 1_200,
  /**
   * After a pick the verdict stays on screen this long, with the picked card and the true
   * target face-up, before the trial deals the next round or closes.
   */
  COURTROOM_VERDICT_INSPECTION_MS: 2_000,
} as const;

export const GAME_CONSTANTS = {
  /** Starting maximum HP when the match does not override it. */
  MAX_HP: HP_LIMITS.DEFAULT,
  /** A permanent maximum-HP cut can never leave a fighter below this pool. */
  MIN_MAX_HP: 10,
  MAX_CURSED_ENERGY: 100,
  DOMAIN_CE_COST: 100,
  SKILL_CE_COST: 50,

  /** Sukuna's Cleave: share of the target's CURRENT HP dealt as damage. */
  CLEAVE_CURRENT_HP_FRACTION: 0.25,

  /** Yuji's Divergent Fist: flat true damage that bypasses barriers. */
  DIVERGENT_FIST_TRUE_DAMAGE: 25,
  /** Yuji's Soul Divergent Strike (Soul Strike active): share of the target's current HP. */
  SOUL_STRIKE_CURRENT_HP_FRACTION: 0.15,
  /** Yuji's Soul Divergent Strike: HP restored to Yuji. */
  SOUL_STRIKE_HEAL: 15,

  /** Hakari's Gamble Turn: CE cost of the skill. */
  GAMBLE_TURN_CE_COST: 40,
  /** Gamble Turn: damage multiplier on a successful match. */
  GAMBLE_DAMAGE_MULTIPLIER: 2,
  /** Gamble Turn: CE restored on a successful match. */
  GAMBLE_REFUND_CE: 40,
  /** Gamble Turn: share of max HP taken as self-inflicted backlash on a mismatch. */
  GAMBLE_BACKLASH_MAX_HP_FRACTION: 0.15,

  /** Idle Death Gamble: free re-spins per Domain. */
  PACHINKO_SPINS: 3,
  /** Idle Death Gamble: highest reel symbol (reels show 1..PACHINKO_REELS). */
  PACHINKO_REELS: 7,
  /** Idle Death Gamble: pity added to the forced-jackpot chance per bankrupt Domain. */
  PACHINKO_PITY_STEP: 0.2,
  /** Idle Death Gamble: share of max HP lost when all re-spins whiff. */
  PACHINKO_BANKRUPT_MAX_HP_FRACTION: 0.3,
  /** Idle Death Gamble: damage multiplier granted by a golden or supreme jackpot. */
  PACHINKO_GOLDEN_DAMAGE_MULTIPLIER: 1.5,
  /** Idle Death Gamble: immortal turns granted by a regular jackpot (odd triples). */
  PACHINKO_REGULAR_JACKPOT_TURNS: 2,
  /** Idle Death Gamble: immortal turns granted by a golden or supreme jackpot. */
  PACHINKO_GOLDEN_JACKPOT_TURNS: 3,
  /** Mahito's Self-Embodiment of Perfection: share of maximum HP removed for good. */
  SOUL_CUT_MAX_HP_FRACTION: 0.25,
  /** Jogo's seal absorption: cursed energy restored by consuming one seal. */
  SEAL_ABSORPTION_CE: 20,

  BASE_MATCH_DAMAGE: 10,
  SYNERGY_DAMAGE_MULTIPLIER: 1.5,
  MATCH_CE_GAIN: 15,
  MISMATCH_CE_PENALTY: 3,

  /** Cards opened per attempt before it is judged (Chimera Shadow Garden raises this). */
  BASE_FLIP_LIMIT: 2,

  /**
   * Turn budget for the active player, escalated as the match goes on so late turns
   * cannot stall: 25s while both sides are still planning, 20s for the middle stretch,
   * 15s once the match is past turn 20. See `calculateTurnDuration`.
   */
  TURN_TIME_EARLY_MS: 25_000,
  TURN_TIME_MID_MS: 20_000,
  TURN_TIME_LATE_MS: 15_000,
  /** First turn of the 20s stage, and of the 15s stage. */
  TURN_TIME_MID_FROM_TURN: 11,
  TURN_TIME_LATE_FROM_TURN: 21,
  /** Matched cards stay face-up this long before the turn continues. */
  MATCH_RESOLVE_MS: 800,
  /** Mismatched cards stay face-up for this long so both players can memorize them. */
  MISMATCH_REVEAL_MS: GAME_PACING.MISMATCH_REVEAL_DURATION_MS,

  /** Barrier a Simple Domain / Maximum Technique raises, as a share of the caster's max HP. */
  SHIELD_FRACTION_OF_MAX_HP: 0.5,
  /** Barrier granted by a Simple Domain / Maximum Technique ultimate. */
  SHIELD_GRANT: 25,

  /** Matches needed in one turn streak before the Black Flash triggers (the 2nd match). */
  BLACK_FLASH_STREAK_LENGTH: 2,
  BLACK_FLASH_CRIT_MULTIPLIER: 2.5,
  BLACK_FLASH_HEAL: 10,
  /** Barrier Kokusen raises on top of the heal, soaked before HP. */
  BLACK_FLASH_SHIELD_GAIN: 20,
  BLACK_FLASH_CE_GAIN: 25,
  /** Kento Nanami's 7:3 Ratio critical multiplier. */
  CRITICAL_STRIKE_MULTIPLIER: 2.5,

  DOMAIN_BOOST: 1.5,
  DOMAIN_DURATION_TURNS: 3,
  /** How long a Simple Domain / Maximum Technique neutralizes an enemy domain. */
  DOMAIN_COUNTER_TURNS: 2,

  /** Unlimited Void: the victim's next turn is skipped and the turn after is rushed. */
  SKIP_TURN_MS: 6_000,
  SHORT_TURN_TIME_MS: 5_000,

  /**
   * Sandbox only: the Cursed Training Dummy's HP pool. It is also IMMORTAL, so a
   * training session can never end by knocking it out.
   */
  SANDBOX_DUMMY_HP: 1_000,

  /** Deadly Sentencing: rounds per trial, cards on the board, and swaps per shuffle. */
  COURTROOM_ROUNDS: 4,
  COURTROOM_SLOTS: 4,
  COURTROOM_SWAPS: 5,
  /** Sandbox dummy victim: chance that its pick lands on the target slot. */
  COURTROOM_DUMMY_ACCURACY: 0.5,
  /** Cursed energy the victim pays to escape a Deadly Sentencing with a Simple Domain. */
  COURTROOM_ESCAPE_COST: 100,
  /** Turns a Confiscated Cursed Tool stays sealed, aged by the victim's own turns. */
  CONFISCATED_TURNS: 3,
  /** CE a victim loses when touching a Confiscated Cursed Tool (recoil damage when at 0 CE). */
  CONFISCATED_BACKLASH_CE: 10,
  CONFISCATED_BACKLASH_DAMAGE: 10,
  /** Barrier and free flip Higuruma gains by reclaiming a Confiscated Cursed Tool. */
  CONFISCATED_RECLAIM_BARRIER: 15,
  /** Awakening Surge: how long the clearer has to choose a blessing before option 2 is forced. */
  AWAKENING_DECISION_MS: 6000,
  /** Awakening Surge: the pause a Training Dummy or AI clearer takes before it picks a blessing. */
  AWAKENING_AI_DELAY_MS: 1000,
  /** Awakening Surge: how long the Six Eyes Insight preview of two pairs stays face-up. */
  SIX_EYES_REVEAL_MS: 2000,
  AWAKENING_RESTORE_BARRIER: 50,
  AWAKENING_RESTORE_CE: 30,
  /** Executioner's Sword true damage: the base plus this much per trial mistake (25/35/45/55). */
  EXECUTIONER_BASE_DAMAGE: 15,
  EXECUTIONER_DAMAGE_PER_MISTAKE: 10,
  /** The sword lasts this many of its owner's turns after the one that granted it. */
  EXECUTIONER_TURNS: 3,
} as const;

/** Trigger rules for modifiers planted on cards. Damage lands on whoever flips the card. */
export const CARD_EFFECT_RULES: Readonly<Record<CardEffectKind, { damage: number; stunMs: number; ceDrain: number }>> = {
  NAILED: { damage: 15, stunMs: 2_000, ceDrain: 0 },
  LAVA: { damage: 15, stunMs: 0, ceDrain: 10 },
  FLESH: { damage: 0, stunMs: 0, ceDrain: 0 },
  LOCKED: { damage: 0, stunMs: 0, ceDrain: 0 },
};
