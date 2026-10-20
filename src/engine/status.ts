import type { StatusEffect, StatusKind } from './types.js';

export function hasStatus(effects: readonly StatusEffect[], kind: StatusKind): boolean {
  return effects.some((effect) => effect.kind === kind);
}

export function statusValue(effects: readonly StatusEffect[], kind: StatusKind): number {
  return effects.reduce((sum, effect) => (effect.kind === kind ? sum + effect.value : sum), 0);
}

export function statusesOf(effects: readonly StatusEffect[], kind: StatusKind): StatusEffect[] {
  return effects.filter((effect) => effect.kind === kind);
}

/** Counts down turn-limited effects at the end of their owner's turn; drops those that run out. */
export function tickStatusTurn(effects: readonly StatusEffect[]): StatusEffect[] {
  return effects.flatMap((effect): StatusEffect[] => {
    if (effect.turnsRemaining === null) return [effect];
    const left = effect.turnsRemaining - 1;
    return left > 0 ? [{ ...effect, turnsRemaining: left }] : [];
  });
}

/** Removes every effect of a kind. */
export function removeStatus(effects: readonly StatusEffect[], kind: StatusKind): StatusEffect[] {
  return effects.filter((effect) => effect.kind !== kind);
}

/** Spends `amount` from a counted effect (like skipped turns), dropping it when exhausted. */
export function consumeStatus(effects: readonly StatusEffect[], kind: StatusKind, amount = 1): StatusEffect[] {
  return effects.flatMap((effect): StatusEffect[] => {
    if (effect.kind !== kind) return [effect];
    const left = effect.value - amount;
    return left > 0 ? [{ ...effect, value: left }] : [];
  });
}
