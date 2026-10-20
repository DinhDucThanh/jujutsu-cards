/**
 * Floating combat text: the numbers and badges that pop off a fighter or a card the moment
 * something happens to it.
 *
 * The overlay is one fixed layer over the whole viewport with `pointer-events: none`, so a
 * badge can be placed anywhere without the arena's own layout moving a pixel: the grid, the
 * panels and the turn strip all keep their geometry while a hit is being read. Badges carry
 * a *kind*, the stylesheet decides what each kind looks like, and this module owns nothing
 * else — the numbers always come from the engine's own events.
 */

export const FLOATING_TEXT_KINDS = [
  /** Ordinary damage: white, small, gone quickly. */
  'DAMAGE',
  /** True damage that went through a barrier: gold, and it says so. */
  'PIERCE',
  /** Kokusen: big, crimson, shaking. */
  'BLACK_FLASH',
  /** A hit that never reached HP: frosted silver. */
  'BLOCK',
  /** Barrier drained by a hit. */
  'BARRIER',
  /** Healing or a fresh barrier: emerald, rising. */
  'HEAL',
] as const;
export type FloatingTextKind = (typeof FLOATING_TEXT_KINDS)[number];

/** Matches `floatCombatText` in the stylesheet. */
export const FLOATING_TEXT_LIFETIME_MS = 1_000;
/** Vertical offset between two badges sharing an anchor, so a pair of hits stays readable. */
const STACK_OFFSET_PX = 26;
/** Above this many live badges the oldest is retired early: a flurry must not carpet the board. */
const MAX_LIVE_BADGES = 24;

export interface FloatingCombatTextOptions {
  /** The overlay element; it must be positioned by the stylesheet, not by this module. */
  readonly layer: HTMLElement;
  readonly lifetimeMs?: number;
}

export interface FloatingCombatText {
  /** Pops a badge over an element's centre. Ignored for a missing or hidden element. */
  showOver(anchor: Element | null, text: string, kind: FloatingTextKind): void;
  /** Pops a badge at a viewport point. */
  showAt(x: number, y: number, text: string, kind: FloatingTextKind): void;
  /** Drops every badge on screen, for leaving a match. */
  reset(): void;
}

interface LiveBadge {
  readonly element: HTMLElement;
  /** Assigned right after the badge is spawned; the timeout is what retires it. */
  timer: number;
  readonly anchor: Element | null;
}

export function createFloatingCombatText(options: FloatingCombatTextOptions): FloatingCombatText {
  const { layer } = options;
  const lifetime = options.lifetimeMs ?? FLOATING_TEXT_LIFETIME_MS;
  const live: LiveBadge[] = [];
  /** Badges still sharing an anchor, so the second hit of a pair does not cover the first. */
  const stacked = new Map<Element, number>();

  const release = (badge: LiveBadge): void => {
    window.clearTimeout(badge.timer);
    badge.element.remove();
    const index = live.indexOf(badge);
    if (index >= 0) live.splice(index, 1);
    if (badge.anchor) {
      const left = (stacked.get(badge.anchor) ?? 1) - 1;
      if (left <= 0) stacked.delete(badge.anchor);
      else stacked.set(badge.anchor, left);
    }
  };

  const spawn = (x: number, y: number, text: string, kind: FloatingTextKind, anchor: Element | null): void => {
    const badge = document.createElement('span');
    badge.className = `fct fct-${kind.toLowerCase().replace(/_/g, '-')} fct-bounce`;
    badge.textContent = text;
    badge.style.left = `${Math.round(x)}px`;
    badge.style.top = `${Math.round(y)}px`;
    const overflow = live.length - MAX_LIVE_BADGES + 1;
    if (overflow > 0) for (const oldest of live.slice(0, overflow)) release(oldest);
    layer.append(badge);
    const entry: LiveBadge = { element: badge, timer: 0, anchor };
    entry.timer = window.setTimeout(() => release(entry), lifetime);
    live.push(entry);
  };

  return {
    showOver(anchor, text, kind) {
      // A hidden panel (a second grid's side, a collapsed list) has no readable position.
      if (!(anchor instanceof HTMLElement) || !anchor.isConnected) return;
      const box = anchor.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      const depth = stacked.get(anchor) ?? 0;
      stacked.set(anchor, depth + 1);
      const y = box.top + Math.min(box.height * 0.35, 96) + depth * STACK_OFFSET_PX;
      spawn(box.left + box.width / 2, y, text, kind, anchor);
    },
    showAt(x, y, text, kind) {
      spawn(x, y, text, kind, null);
    },
    reset() {
      for (const badge of [...live]) release(badge);
      stacked.clear();
      layer.replaceChildren();
    },
  };
}
