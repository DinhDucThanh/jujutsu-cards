import { CARD_STATE, CARD_TYPE, type Card, type CardSubjectId, type CardType, type PairId } from './types.js';

export type PairRejectReason = 'SAME_CARD' | 'NOT_REVEALED' | 'PAIR_MISMATCH';

export type PairVerdict =
  | { readonly isMatch: true; readonly pairId: PairId; readonly cardType: CardType }
  | { readonly isMatch: false; readonly reason: PairRejectReason };

/** Everything needed to identify what a card pairs with. Cards and public views both fit. */
export interface MatchKeySource {
  readonly type: CardType | null;
  readonly pairId: PairId | null;
  readonly characterId: CardSubjectId | null;
}

/**
 * What a card pairs with.
 *
 * Standard character cards are keyed by the *fighter they show*, not by the pair instance
 * they were dealt from. A 4x4 grid fits one pair per fighter, but a 6x6 grid needs up to
 * 18 pairs out of a 10 fighter roster, so the deal repeats characters: two pairs can both
 * show Nobara Kugisaki. Keying on the pair index there would tell a player who correctly
 * remembered two Nobara cards that their flip was wrong, which is unplayable. Any two
 * standard cards showing the same fighter are therefore interchangeable.
 *
 * Synergy pairs keep their own `syn:` key, so a synergy Satoru Gojo never matches (and
 * never is matched by) the plain Satoru Gojo pair, and every trap keeps its unique key.
 *
 * Returns null for a face-down public card, whose identity is not published.
 */
export function matchKeyOf(card: MatchKeySource): string | null {
  if (card.pairId === null) return null;
  if (card.type === CARD_TYPE.STANDARD && card.characterId !== null) return `std:${card.characterId}`;
  return card.pairId;
}

/**
 * Verifies two flipped cards. Both must be face up, distinct, and share a match key.
 * Identity never leaves the server, so clients cannot forge matches.
 */
export function verifyPair(first: Card, second: Card): PairVerdict {
  if (first.id === second.id) return { isMatch: false, reason: 'SAME_CARD' };
  if (first.state !== CARD_STATE.REVEALED || second.state !== CARD_STATE.REVEALED) {
    return { isMatch: false, reason: 'NOT_REVEALED' };
  }
  if (matchKeyOf(first) !== matchKeyOf(second)) return { isMatch: false, reason: 'PAIR_MISMATCH' };
  return { isMatch: true, pairId: first.pairId, cardType: first.type };
}
