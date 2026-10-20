import {
  CARD_STATE,
  matchKeyOf,
  randomUnit,
  type BoardId,
  type CardId,
  type PublicCardView,
  type PublicMatchView,
  type RandomSource,
} from '../engine/index.js';

/** Confidence lost per turn change. Entries below MEMORY_FORGET_BELOW are dropped. */
export const MEMORY_DECAY_PER_TURN = 0.85;
export const MEMORY_FORGET_BELOW = 0.2;
/** Minimum confidence before the bot acts on a remembered card. */
export const MEMORY_TRUST_AT = 0.5;

export interface MemoryEntry {
  readonly position: number;
  /**
   * What the card pairs with, as the engine defines it: a repeated fighter on a large
   * grid is interchangeable with its lookalike, so the bot banks those as one pair.
   */
  readonly matchKey: string;
  confidence: number;
  readonly turnSeen: number;
}

/**
 * What the bot remembers about face-down cards. It only learns from cards the
 * public view shows face-up, so identities are never read from hidden state, and
 * transfigured (corrupted) cards stay unreadable because the view masks them.
 */
export class CardMemory {
  private readonly entries = new Map<CardId, MemoryEntry>();
  /** Cards already rolled for retention during the current turn. */
  private readonly sightings = new Set<CardId>();
  private sightingsTurn = -1;

  constructor(
    private readonly retention: number,
    private readonly rng: RandomSource,
  ) {}

  /**
   * Call on every poll. Each face-up card gets one retention roll per turn; cards are
   * read from `boardId` when given, or from every grid the view exposes otherwise.
   * Bots pass the grid they play on so they never learn the opponent's layout.
   */
  observe(view: PublicMatchView, boardId?: BoardId): void {
    if (view.cycles !== this.sightingsTurn) {
      if (this.sightingsTurn !== -1) this.decay();
      this.sightings.clear();
      this.sightingsTurn = view.cycles;
    }

    const boards = boardId === undefined ? view.boards : view.boards.filter((board) => board.boardId === boardId);
    for (const board of boards) {
      for (const card of board.cards) {
        if (card.state === CARD_STATE.MATCHED) {
          this.entries.delete(card.id);
          continue;
        }
        if (card.state !== CARD_STATE.REVEALED) continue;
        const matchKey = matchKeyOf(card);
        if (matchKey === null) continue;
        this.observeFaceUp(card.id, card.position, matchKey, view.cycles);
      }
    }
  }

  private observeFaceUp(cardId: CardId, position: number, matchKey: string, turnNumber: number): void {
    if (this.entries.has(cardId)) {
      // Seeing a remembered card again always refreshes it.
      this.entries.set(cardId, { position, matchKey, confidence: 1, turnSeen: turnNumber });
      return;
    }
    if (this.sightings.has(cardId)) return;
    this.sightings.add(cardId);

    if (randomUnit(this.rng) < this.retention) {
      this.entries.set(cardId, { position, matchKey, confidence: 1, turnSeen: turnNumber });
    }
  }

  private decay(): void {
    for (const [cardId, entry] of this.entries) {
      entry.confidence *= MEMORY_DECAY_PER_TURN;
      if (entry.confidence < MEMORY_FORGET_BELOW) this.entries.delete(cardId);
    }
  }

  /** Remembered cards grouped by match key, restricted to the given grid's face-down cards. */
  private trustedHiddenByPair(board: readonly PublicCardView[]): Map<string, CardId[]> {
    const hidden = new Set(board.filter((card) => card.state === CARD_STATE.HIDDEN).map((card) => card.id));
    const groups = new Map<string, CardId[]>();
    for (const [cardId, entry] of this.entries) {
      if (entry.confidence < MEMORY_TRUST_AT || !hidden.has(cardId)) continue;
      const group = groups.get(entry.matchKey) ?? [];
      group.push(cardId);
      groups.set(entry.matchKey, group);
    }
    return groups;
  }

  /** Face-down pairs the bot knows completely, on the grid it is playing. */
  knownPairs(board: readonly PublicCardView[]): Array<readonly [CardId, CardId]> {
    const pairs: Array<readonly [CardId, CardId]> = [];
    for (const group of this.trustedHiddenByPair(board).values()) {
      const [first, second] = group;
      if (first !== undefined && second !== undefined) pairs.push([first, second]);
    }
    return pairs;
  }

  /** A remembered face-down partner for `matchKey`, other than `exclude`. */
  partnerOf(matchKey: string, board: readonly PublicCardView[], exclude: CardId): CardId | null {
    const group = this.trustedHiddenByPair(board).get(matchKey) ?? [];
    return group.find((cardId) => cardId !== exclude) ?? null;
  }

  isKnown(cardId: CardId): boolean {
    const entry = this.entries.get(cardId);
    return entry !== undefined && entry.confidence >= MEMORY_TRUST_AT;
  }

  /** Number of remembered entries (for diagnostics and tests). */
  size(): number {
    return this.entries.size;
  }

  get(cardId: CardId): MemoryEntry | undefined {
    return this.entries.get(cardId);
  }
}
