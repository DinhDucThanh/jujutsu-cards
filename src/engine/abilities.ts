import { matchKeyOf } from './matcher.js';
import { fisherYatesShuffle, type RandomSource } from './random.js';
import { CARD_STATE, type Card } from './types.js';

export type Position = number;

/** Grid positions of every face-down card. */
export function hiddenPositions(cards: readonly Card[]): Position[] {
  return cards.flatMap((card, index) => (card.state === CARD_STATE.HIDDEN ? [index] : []));
}

/** Up to `count` random face-down positions, without repeats. */
export function pickHiddenPositions(cards: readonly Card[], count: number, rng: RandomSource): Position[] {
  return fisherYatesShuffle(hiddenPositions(cards), rng).slice(0, Math.max(0, count));
}

/**
 * Face-down cards grouped by match key: only real pairs (two or more cards).
 *
 * Grouping by pair key rather than by pair id matters on a 6x6 grid, where the roster
 * repeats: scouting and auto-clearing must be able to name a pair of identical fighters
 * dealt from two different pair instances, and must never leave a card unpaired because
 * its twin sits in a group the map treats as a different pair.
 */
function hiddenPairs(cards: readonly Card[]): Map<string, Position[]> {
  const groups = new Map<string, Position[]>();
  cards.forEach((card, index) => {
    if (card.state !== CARD_STATE.HIDDEN) return;
    const key = matchKeyOf(card);
    if (key === null) return;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key);
  }
  return groups;
}

/** One random face-down pair, as grid positions. Null when no pair is left face down. */
export function pickPairPositions(cards: readonly Card[], rng: RandomSource): [Position, Position] | null {
  const groups = [...hiddenPairs(cards).values()];
  if (groups.length === 0) return null;
  const chosen = fisherYatesShuffle(groups, rng)[0];
  if (!chosen || chosen.length < 2) return null;
  const [first, second] = fisherYatesShuffle(chosen, rng);
  return first === undefined || second === undefined ? null : [first, second];
}

/** Up to `count` distinct random face-down pairs. Used by auto-clearing domains. */
export function pickPairPositionsList(cards: readonly Card[], count: number, rng: RandomSource): Array<[Position, Position]> {
  const groups = fisherYatesShuffle([...hiddenPairs(cards).values()], rng);
  const out: Array<[Position, Position]> = [];
  for (const group of groups.slice(0, Math.max(0, count))) {
    const [first, second] = fisherYatesShuffle(group, rng);
    if (first !== undefined && second !== undefined) out.push([first, second]);
  }
  return out;
}

/** Swaps two grid positions in place (Boogie Woogie). */
export function swapPositions<T>(items: T[], a: Position, b: Position): boolean {
  const first = items[a];
  const second = items[b];
  if (first === undefined || second === undefined || a === b) return false;
  items[a] = second;
  items[b] = first;
  return true;
}
