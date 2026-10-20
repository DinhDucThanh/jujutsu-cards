/**
 * The shared seal-stamp effect: every ability that locks a card ends with the same talisman
 * slamming onto it.
 *
 * The engine names the cards (`CARD_MODIFIED` with a LOCKED modifier) and the grids own the
 * DOM; this module owns the choreography between them. Stamps wait while a full-screen
 * overlay covers the board, so a courtroom's verdicts land on the grid the moment it gets
 * it back, while a domain that seals cards mid-turn lands straight away. One effect, one
 * sound, every ability.
 */
import { stampTalismanSeals } from './talisman-seal.js';

/** Quiet beat before the first stamp, so the grid is on screen when it lands. */
const DEFAULT_DELAY_MS = 160;

export interface SealStampVfxOptions {
  /** Every grid a sealed card can live in. Read lazily: the session comes and goes. */
  readonly roots: () => Iterable<HTMLElement>;
  /** False while something covers the grid, so the stamps wait for it to go. */
  readonly boardVisible: () => boolean;
  /** Called as each talisman lands; the caller supplies the sound. */
  readonly onStamp?: () => void;
  readonly delayMs?: number;
  readonly staggerMs?: number;
}

export interface SealStampVfx {
  /** Remembers cards the engine just sealed. Duplicates are ignored. */
  queue(cardIds: readonly string[]): void;
  /** Starts whatever is pending if the grid can be seen. Called once per frame. */
  flush(): void;
  /** Cancels a running sequence and forgets anything queued, for leaving a match. */
  reset(): void;
}

/**
 * Builds the effect. `flush` is driven by the render loop rather than a timer of its own, so
 * a stamp never lands on a frame where the board is still covered and never needs a second
 * clock to stay in step with the game.
 */
export function createSealStampVfx(options: SealStampVfxOptions): SealStampVfx {
  let pending: string[] = [];
  // Non-null while a sequence is running: new seals wait for it rather than overlapping.
  let cancel: (() => void) | null = null;

  const queue = (cardIds: readonly string[]): void => {
    for (const id of cardIds) {
      if (!pending.includes(id)) pending.push(id);
    }
  };

  const flush = (): void => {
    if (cancel !== null || pending.length === 0 || !options.boardVisible()) return;
    const ids = pending;
    const found = new Map<string, HTMLElement>();
    for (const root of options.roots()) {
      for (const button of root.querySelectorAll<HTMLElement>('button.card')) {
        const id = button.dataset.cardId;
        if (id !== undefined && ids.includes(id)) found.set(id, button);
      }
    }
    // The stamps follow the order the engine sealed them in, not the grid's DOM order.
    const targets = ids.flatMap((id) => {
      const card = found.get(id);
      return card === undefined ? [] : [card];
    });
    pending = [];
    if (targets.length === 0) return;
    cancel = stampTalismanSeals(targets, {
      delayMs: options.delayMs ?? DEFAULT_DELAY_MS,
      ...(options.staggerMs === undefined ? {} : { staggerMs: options.staggerMs }),
      ...(options.onStamp === undefined ? {} : { onStamp: () => options.onStamp?.() }),
      onDone: () => {
        cancel = null;
      },
    });
  };

  return {
    queue,
    flush,
    reset(): void {
      cancel?.();
      cancel = null;
      pending = [];
    },
  };
}
