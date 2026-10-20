/**
 * The talisman slam itself: one card at a time, on a fixed beat.
 *
 * Every ability that seals cards ends with this stamp — the Judgeman's verdicts, Coffin of
 * the Iron Mountain, any domain that locks a grid. Landing them all on one frame reads as
 * a state change; landing them one after another reads as a sentence being carried out.
 * This module owns only that rhythm; `seal-stamp.ts` decides which cards and when.
 */

/** Matches `talisman-slam` in the stylesheet. */
export const TALISMAN_IMPACT_MS = 450;
/** Gap between two stamps, so each one lands on its own beat. */
export const TALISMAN_STAGGER_MS = 250;

export interface TalismanStampOptions {
  /** Quiet beat before the first stamp, so the board is visible when it lands. */
  readonly delayMs?: number;
  readonly staggerMs?: number;
  readonly impactMs?: number;
  /** Called as each stamp lands, so the slam can have its own sound. */
  readonly onStamp?: (index: number) => void;
  /** Called once the last stamp has finished, never after a cancel. */
  readonly onDone?: () => void;
}

/**
 * Stamps `targets` in order, one every `staggerMs`. Returns a function that cancels the
 * rest and clears the class from every target, for leaving a match mid-sequence.
 */
export function stampTalismanSeals(
  targets: readonly HTMLElement[],
  options: TalismanStampOptions = {},
): () => void {
  const delay = options.delayMs ?? 0;
  const stagger = options.staggerMs ?? TALISMAN_STAGGER_MS;
  const impact = options.impactMs ?? TALISMAN_IMPACT_MS;
  const timers: number[] = [];
  let cancelled = false;

  targets.forEach((target, index) => {
    timers.push(
      window.setTimeout(() => {
        if (cancelled) return;
        // Restart the keyframes even when this card was stamped in an earlier trial.
        target.classList.remove('talisman-stamp-impact');
        void target.offsetWidth;
        target.classList.add('talisman-stamp-impact');
        options.onStamp?.(index);
        timers.push(
          window.setTimeout(() => {
            if (cancelled) return;
            target.classList.remove('talisman-stamp-impact');
            // The sequence is free only once its last slam has fully landed.
            if (index === targets.length - 1) options.onDone?.();
          }, impact),
        );
      }, delay + index * stagger),
    );
  });

  return () => {
    cancelled = true;
    for (const timer of timers) window.clearTimeout(timer);
    timers.length = 0;
    for (const target of targets) target.classList.remove('talisman-stamp-impact');
  };
}
