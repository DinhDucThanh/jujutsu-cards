import { CHARACTER_IDS, SYNERGIES, TRAPS } from './catalog.js';
import { fisherYatesShuffle, type RandomSource } from './random.js';
import {
  CARD_STATE,
  CARD_TYPE,
  type BoardId,
  type Card,
  type CardSubjectId,
  type CardType,
  type CharacterId,
  type PairId,
  type TrapId,
} from './types.js';

export const SUPPORTED_BOARD_SIZES = [8, 16, 36] as const;
export type BoardSize = (typeof SUPPORTED_BOARD_SIZES)[number];

/** Card identity as dealt, before instantiation. Positions are array indices. */
export interface CardSpec {
  readonly pairId: PairId;
  readonly type: CardType;
  readonly characterId: CardSubjectId;
  readonly trapId: TrapId | null;
}

export interface BoardTemplateOptions {
  readonly size: BoardSize;
  readonly trapCount: number;
  readonly synergyPairCount: number;
}

/**
 * Produces a shuffled layout. Every standard/synergy pair contributes exactly
 * two specs sharing a pairId; every trap contributes one unique spec.
 *
 * This deals *one* layout: it is the shared grid of SHARED mode, and it is what an explicit
 * layout is validated against. A dual match does not mirror it — each grid is dealt on its
 * own by `generateIndependentBoard` in `board-generator.ts`.
 */
export function createBoardTemplate(options: BoardTemplateOptions, rng: RandomSource): CardSpec[] {
  const { size, trapCount, synergyPairCount } = options;

  if (!(SUPPORTED_BOARD_SIZES as readonly number[]).includes(size)) {
    throw new RangeError(`Unsupported board size ${size}`);
  }
  if (!Number.isInteger(trapCount) || trapCount < 0) {
    throw new RangeError(`trapCount must be a non-negative integer, got ${trapCount}`);
  }
  const playable = size - trapCount;
  if (playable < 2 || playable % 2 !== 0) {
    throw new RangeError(`Board of ${size} with ${trapCount} traps leaves ${playable} cards; need an even count >= 2`);
  }
  const pairCount = playable / 2;
  const synergyDefs = Object.values(SYNERGIES);
  if (!Number.isInteger(synergyPairCount) || synergyPairCount < 0 || synergyPairCount > Math.min(pairCount, synergyDefs.length)) {
    throw new RangeError(`synergyPairCount must be in [0, ${Math.min(pairCount, synergyDefs.length)}]`);
  }
  if (trapCount > 0 && Object.keys(TRAPS).length === 0) {
    throw new RangeError('Traps requested but none are defined');
  }

  const specs: CardSpec[] = [];

  const synergies = fisherYatesShuffle(synergyDefs, rng).slice(0, synergyPairCount);
  for (const synergy of synergies) {
    for (const subject of synergy.subjects) {
      specs.push({ pairId: `syn:${synergy.id}`, type: CARD_TYPE.SYNERGY, characterId: subject, trapId: null });
    }
  }

  // Every pair takes the next fighter in the shuffled roster, and the roster is walked
  // again when it runs out: a 36 card grid needs 18 pairs from 10 fighters, so the deal
  // *must* repeat characters, and the pair id carries the instance index (`std:gojo:1`).
  // Repeated faces are interchangeable by design — matching is by fighter, see
  // `matchKeyOf` — so the index is bookkeeping, never a rule the player has to know.
  const standardCount = pairCount - synergyPairCount;
  const pool: readonly CharacterId[] = fisherYatesShuffle(CHARACTER_IDS, rng);
  for (let i = 0; i < standardCount; i++) {
    const characterId = pool[i % pool.length] as CharacterId;
    const pairId = `std:${characterId}:${Math.floor(i / pool.length)}`;
    specs.push({ pairId, type: CARD_TYPE.STANDARD, characterId, trapId: null });
    specs.push({ pairId, type: CARD_TYPE.STANDARD, characterId, trapId: null });
  }

  const trapDefs = Object.values(TRAPS);
  for (let i = 0; i < trapCount; i++) {
    const trap = trapDefs[i % trapDefs.length];
    if (!trap) throw new Error('unreachable: trap definitions checked above');
    specs.push({ pairId: `trap:${trap.id}:${i}`, type: CARD_TYPE.TRAP, characterId: trap.subject, trapId: trap.id });
  }

  return fisherYatesShuffle(specs, rng);
}

/** Creates fresh, hidden Card objects for one board. */
export function instantiateBoard(template: readonly CardSpec[], boardId: BoardId): Card[] {
  return template.map((spec, index) => ({
    id: `${boardId}:${index}`,
    pairId: spec.pairId,
    characterId: spec.characterId,
    type: spec.type,
    trapId: spec.trapId,
    state: CARD_STATE.HIDDEN,
    revealedBy: null,
    effectModifiers: [],
  }));
}

/**
 * Validates an explicit layout (tests, replays, custom boards): correct card count,
 * each standard/synergy pair dealt exactly twice, each trap once, and the expected trap total.
 */
export function assertBoardLayout(template: readonly CardSpec[], size: number, trapCount: number): void {
  if (template.length !== size) {
    throw new Error(`Layout has ${template.length} cards; expected ${size}`);
  }
  const counts = new Map<PairId, number>();
  for (const spec of template) counts.set(spec.pairId, (counts.get(spec.pairId) ?? 0) + 1);

  let traps = 0;
  for (const spec of template) {
    const expected = spec.type === CARD_TYPE.TRAP ? 1 : 2;
    if (spec.type === CARD_TYPE.TRAP) traps += 1;
    if (counts.get(spec.pairId) !== expected) {
      throw new Error(`Pair ${spec.pairId} must appear exactly ${expected} time(s) in the layout`);
    }
  }
  if (traps !== trapCount) throw new Error(`Layout has ${traps} traps; expected ${trapCount}`);
}

/** A board is cleared when every non-trap card is matched. Unflipped traps do not block. */
export function isBoardCleared(cards: readonly Card[]): boolean {
  return cards.every((card) => card.type === CARD_TYPE.TRAP || card.state === CARD_STATE.MATCHED);
}
