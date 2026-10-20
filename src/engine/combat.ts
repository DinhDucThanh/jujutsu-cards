import { GAME_CONSTANTS } from './constants.js';
import { hasStatus, statusValue } from './status.js';
import { CARD_TYPE, STATUS_KIND, type CardType, type PlayerState, type StatusEffect } from './types.js';

export interface MatchEffects {
  readonly damage: number;
  readonly healing: number;
  /** Barrier points granted by the match itself (Black Flash). */
  readonly shieldGain: number;
  readonly ceGain: number;
  readonly blackFlash: boolean;
  readonly critical: boolean;
  /** Matches ignore enemy shields while this is set (Yuji's Soul Strike). */
  readonly piercing: boolean;
}

/**
 * Black Flash: the match that completes a streak of consecutive matches within one turn.
 * `priorStreak` is the number of matches already scored in the current turn streak.
 */
export function isBlackFlash(
  priorStreak: number,
  threshold: number = GAME_CONSTANTS.BLACK_FLASH_STREAK_LENGTH,
): boolean {
  return priorStreak + 1 >= threshold;
}

export function clampCursedEnergy(value: number): number {
  return Math.min(GAME_CONSTANTS.MAX_CURSED_ENERGY, Math.max(0, value));
}

/** Maximum HP for a player: the configured pool minus any permanent cap reduction. */
export function maxHpOf(player: PlayerState): number {
  const reduction = statusValue(player.activeEffects, STATUS_KIND.MAX_HP_REDUCTION);
  return Math.max(GAME_CONSTANTS.MIN_MAX_HP, player.maxHp - reduction);
}

/** Barrier ceiling: half of the player's current maximum HP. */
export function shieldCapOf(player: PlayerState): number {
  return Math.floor(maxHpOf(player) * GAME_CONSTANTS.SHIELD_FRACTION_OF_MAX_HP);
}

/**
 * Adds barrier points, clamped to the ceiling. Returns the amount actually added, so
 * callers can report a grant of 0 when the barrier is already full.
 */
export function grantShield(player: PlayerState, amount: number): number {
  const before = player.shield;
  player.shield = Math.min(shieldCapOf(player), before + Math.max(0, amount));
  return player.shield - before;
}

export function calculateMatchEffects(input: {
  readonly cardType: CardType;
  readonly blackFlash: boolean;
  readonly attackerStatuses: readonly StatusEffect[];
  readonly domainActive: boolean;
}): MatchEffects {
  if (input.cardType === CARD_TYPE.TRAP) {
    throw new Error('Trap cards do not produce pair-match effects');
  }

  const typeMultiplier = input.cardType === CARD_TYPE.SYNERGY ? GAME_CONSTANTS.SYNERGY_DAMAGE_MULTIPLIER : 1;

  // Critical sources do not stack: Black Flash takes precedence over guaranteed crits.
  const strike = statusValue(input.attackerStatuses, STATUS_KIND.CRITICAL_STRIKE);
  let critMultiplier = 1;
  if (input.blackFlash) {
    critMultiplier = GAME_CONSTANTS.BLACK_FLASH_CRIT_MULTIPLIER;
  } else if (strike > 1) {
    critMultiplier = strike;
  }

  const domainMultiplier = input.domainActive ? GAME_CONSTANTS.DOMAIN_BOOST : 1;
  const damage = Math.round(GAME_CONSTANTS.BASE_MATCH_DAMAGE * typeMultiplier * critMultiplier * domainMultiplier);

  return {
    damage,
    healing: input.blackFlash ? GAME_CONSTANTS.BLACK_FLASH_HEAL : 0,
    shieldGain: input.blackFlash ? GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN : 0,
    ceGain: GAME_CONSTANTS.MATCH_CE_GAIN + (input.blackFlash ? GAME_CONSTANTS.BLACK_FLASH_CE_GAIN : 0),
    blackFlash: input.blackFlash,
    critical: critMultiplier > 1,
    piercing: hasStatus(input.attackerStatuses, STATUS_KIND.PIERCING_ATTACKS),
  };
}

export interface DamageResult {
  /** HP actually removed. */
  readonly dealt: number;
  /** Damage soaked by shields or negated outright. */
  readonly absorbed: number;
  /** The same figure as `dealt`, named for callers that read the split explicitly. */
  readonly damageToHp: number;
  /** The same figure as `absorbed`, named for callers that read the split explicitly. */
  readonly damageToShield: number;
}

/** Damage options. `isPiercing` is the long-form spelling of `piercing`. */
export interface DamageOptions {
  readonly piercing?: boolean;
  readonly isPiercing?: boolean;
}

/**
 * Applies damage in order: absolute shields negate everything, then the barrier pool
 * soaks, then HP. IMMORTAL keeps HP at 1 instead of letting a positive HP total
 * drop to 0. `piercing` skips the barrier entirely (Nanami's armor-piercing strikes).
 */
export function applyDamage(target: PlayerState, amount: number, options: DamageOptions = {}): DamageResult {
  let remaining = Math.max(0, amount);
  const incoming = remaining;
  let absorbed = 0;
  const piercing = options.piercing === true || options.isPiercing === true;

  if (hasStatus(target.activeEffects, STATUS_KIND.ABSOLUTE_SHIELD)) {
    return { dealt: 0, absorbed: incoming, damageToHp: 0, damageToShield: incoming };
  }

  if (!piercing && target.shield > 0 && remaining > 0) {
    const soaked = Math.min(target.shield, remaining);
    target.shield -= soaked;
    remaining -= soaked;
    absorbed += soaked;
  }

  const hpBefore = target.hp;
  let hpAfter = Math.max(0, hpBefore - remaining);
  if (hpBefore > 0 && hpAfter === 0 && hasStatus(target.activeEffects, STATUS_KIND.IMMORTAL)) {
    hpAfter = 1;
  }
  target.hp = hpAfter;

  const dealt = hpBefore - hpAfter;
  return { dealt, absorbed, damageToHp: dealt, damageToShield: absorbed };
}

/** Heals without exceeding the target's own maximum HP. Returns the amount restored. */
export function heal(target: PlayerState, amount: number, maxHp: number = target.maxHp): number {
  const before = target.hp;
  target.hp = Math.min(maxHp, before + Math.max(0, amount));
  return target.hp - before;
}
