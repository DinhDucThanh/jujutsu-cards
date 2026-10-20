import { assertBoardLayout, createBoardTemplate, instantiateBoard, type BoardSize } from './board.js';
import type { RandomSource } from './random.js';
import type { BoardId, Card } from './types.js';

/**
 * Independent per-board deals for DUAL play.
 *
 * `board.ts` deals one template, which is mirrored to the grids so both players race on the
 * same arrangement. That is correct for a shared grid, and it was correct while the only
 * dual-board mode was the training ground — but in a real dual match a mirrored deal lets a
 * player read the opponent's grid off their own, trap positions included. Here every board
 * spends its own entropy on the roster sample and on the shuffle.
 *
 * Card identity stays `${boardId}:${position}` and position stays the array index, because
 * that pair is the contract the DOM (`data-card-id`), the network protocol and the public
 * view already speak. A separate `gridIndex` field would be a second source of truth for a
 * value the array already carries.
 */

export interface IndependentBoardOptions {
  /** Lore synergy pairs to include. The match owns this number, so both boards agree on it. */
  readonly synergyPairCount?: number;
  /** Entropy source. The engine passes its own; standalone calls fall back to `Math.random`. */
  readonly rng?: RandomSource;
}

export interface IndependentBoardsOptions extends IndependentBoardOptions {
  readonly size: BoardSize;
  readonly trapCount: number;
}

export interface AvoidingDealOptions extends IndependentBoardsOptions {
  /** Boards the new deal should differ from: in arrangement, and in mix when it can. */
  readonly avoid?: readonly (readonly Card[])[];
}

/** Fallback entropy for calling the generator outside the engine (scripts, tests, tools). */
function createEntropyRandom(): RandomSource {
  return {
    nextUint32(): number {
      return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
    },
  };
}

/**
 * Deals one board from its own entropy: a fresh roster sample and a fresh Fisher-Yates
 * shuffle. Two calls always produce different arrangements, and with a pool larger than the
 * board they also sample a different set of pairs, so the grids do not even share a mix.
 */
export function generateIndependentBoard(
  boardSize: BoardSize,
  trapsCount: number,
  boardOwnerPrefix: BoardId,
  options: IndependentBoardOptions = {},
): Card[] {
  const rng = options.rng ?? createEntropyRandom();
  const template = createBoardTemplate(
    { size: boardSize, trapCount: trapsCount, synergyPairCount: options.synergyPairCount ?? 0 },
    rng,
  );
  // The generator is the one place a corrupt deal could reach players, so it validates its
  // own output instead of trusting every caller to do it.
  assertBoardLayout(template, boardSize, trapsCount);
  return instantiateBoard(template, boardOwnerPrefix);
}

/** The exact layout: which pair sits at which position, in deal order. */
export function layoutSignature(cards: readonly Card[]): string {
  return cards.map((card) => card.pairId).join('|');
}

/** The mix of a deal: which pairs the board contains, ignoring where they landed. */
export function mixSignature(cards: readonly Card[]): string {
  return [...new Set(cards.map((card) => card.pairId))].sort().join('|');
}

/**
 * How often a board is re-dealt to break a collision with a board already in play.
 *
 * A repeated arrangement is vanishingly unlikely, but a repeated *mix* is not: a 4x4 grid
 * draws eight of ten fighters, so one deal in 45 draws the same eight. Six attempts push
 * that below one in ten billion; the last deal is kept whatever it is, because a 6x6 grid
 * must use every fighter and can legitimately repeat a mix.
 */
const MAX_DEAL_ATTEMPTS = 6;

/**
 * Deals one board, steered away from the boards it is replacing or sharing the match with.
 * `avoid` is empty for the only grid of a shared-board match, which makes this exactly the
 * same deal `generateIndependentBoard` returns.
 */
export function generateBoardAvoiding(boardId: BoardId, options: AvoidingDealOptions): Card[] {
  // One source across the attempts: each retry consumes more of it, so a retry diverges
  // from the deal it is replacing instead of repeating it.
  const rng = options.rng ?? createEntropyRandom();
  const avoided = options.avoid ?? [];
  const arrangements = new Set(avoided.map(layoutSignature));
  const mixes = new Set(avoided.map(mixSignature));

  let distinctArrangement: Card[] | null = null;
  let distinctMix: Card[] | null = null;
  let last: Card[] | null = null;

  for (let attempt = 0; attempt < MAX_DEAL_ATTEMPTS && distinctMix === null; attempt += 1) {
    const cards = generateIndependentBoard(options.size, options.trapCount, boardId, {
      synergyPairCount: options.synergyPairCount ?? 0,
      rng,
    });
    last = cards;
    if (arrangements.has(layoutSignature(cards))) continue;
    distinctArrangement ??= cards;
    if (!mixes.has(mixSignature(cards))) distinctMix = cards;
  }

  const dealt = distinctMix ?? distinctArrangement ?? last;
  if (dealt === null) throw new Error('unreachable: the deal loop always runs at least once');
  return dealt;
}

/**
 * Deals every board of a match, each from its own entropy, none repeating another's
 * arrangement — or another's mix, whenever the roster is large enough for that to differ.
 */
export function generateIndependentBoards(
  boardIds: readonly BoardId[],
  options: IndependentBoardsOptions,
): Map<BoardId, Card[]> {
  const boards = new Map<BoardId, Card[]>();
  const dealt: Card[][] = [];

  for (const boardId of boardIds) {
    const cards = generateBoardAvoiding(boardId, { ...options, avoid: dealt });
    dealt.push(cards);
    boards.set(boardId, cards);
  }

  return boards;
}
