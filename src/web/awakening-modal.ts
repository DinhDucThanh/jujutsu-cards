/**
 * The Awakening Surge chooser: the clearer of a fully matched board picks one of three
 * blessings before the fresh grid is dealt.
 *
 * The engine owns the clock and the fallback. This module only draws the pending choice,
 * counts down to the forced Sorcery Restoration, and sends the pick back.
 */
import { BLESSING, GAME_CONSTANTS, type BlessingId, type PlayerId, type PublicAwakeningView } from '../engine/index.js';

/** Ignores repeat clicks for a moment, so a double tap cannot send the same pick twice. */
const ANSWER_LOCK_MS = 500;

interface BlessingCard {
  readonly id: BlessingId;
  readonly title: string;
  readonly kanji: string;
  readonly effect: string;
  readonly accent: 'gold' | 'crimson' | 'cyan';
}

const BLESSING_CARDS: readonly BlessingCard[] = [
  {
    id: BLESSING.LATENT_BLACK_FLASH,
    title: 'Latent Black Flash',
    kanji: '黒閃',
    effect: 'Your next matched pair on the fresh grid is guaranteed a Black Flash.',
    accent: 'crimson',
  },
  {
    id: BLESSING.SORCERY_RESTORATION,
    title: 'Sorcery Restoration',
    kanji: '回復',
    effect: `+${GAME_CONSTANTS.AWAKENING_RESTORE_BARRIER} Barrier and +${GAME_CONSTANTS.AWAKENING_RESTORE_CE} CE, instantly.`,
    accent: 'gold',
  },
  {
    id: BLESSING.SIX_EYES_INSIGHT,
    title: 'Six Eyes Insight',
    kanji: '六眼',
    effect: `Two matched pairs on the new grid glow cyan and show for ${GAME_CONSTANTS.SIX_EYES_REVEAL_MS / 1000}s.`,
    accent: 'cyan',
  },
];

export interface AwakeningModalOptions {
  readonly root: HTMLElement;
  readonly labelOf: (id: PlayerId) => string;
  /** Receives the blessing the clearer picked. */
  readonly onChoose: (blessing: BlessingId) => void;
}

export interface AwakeningModal {
  /**
   * Draws the pending choice for this frame. `null` closes the modal.
   * `clearerIsHuman` says whether this screen may send the pick.
   */
  render(view: PublicAwakeningView | null, clearerIsHuman: boolean, now: number): void;
  /** Hides the chooser at once, for leaving a match. */
  reset(): void;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** The display name of a blessing, for the log. */
export function blessingTitle(id: BlessingId): string {
  return BLESSING_CARDS.find((card) => card.id === id)?.title ?? id;
}

/** The one-line description of a blessing, shown under its name in the HUD banner. */
export function blessingEffect(id: BlessingId): string {
  return BLESSING_CARDS.find((card) => card.id === id)?.effect ?? '';
}

/** How long a rolled blessing stays on the HUD banner. */
export const AWAKENING_TOAST_MS = 3500;

/**
 * Shows a rolled blessing in the HUD slot under the clearer's panel, then removes it.
 * The slot is absolutely positioned, so the banner never shifts the panel's layout.
 * A newer banner replaces the older one in the same slot.
 */
export function showAwakeningToast(slot: HTMLElement, blessing: BlessingId): void {
  const toast = make('div', 'awakening-toast');
  toast.setAttribute('role', 'status');
  toast.append(
    make('div', 'awakening-toast-title', `⚡ AWAKENING SURGE: ${blessingTitle(blessing)}`),
    make('div', 'awakening-toast-effect', blessingEffect(blessing)),
  );
  slot.replaceChildren(toast);
  window.setTimeout(() => {
    if (toast.isConnected) toast.remove();
  }, AWAKENING_TOAST_MS);
}

/** Whole seconds left before the blessing is forced, never negative. */
export function secondsLeft(decideBy: number, now: number): number {
  return Math.max(0, Math.ceil((decideBy - now) / 1000));
}

export function createAwakeningModal(options: AwakeningModalOptions): AwakeningModal {
  const { root, labelOf, onChoose } = options;

  root.classList.add('awakening');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Awakening Surge');
  root.replaceChildren();

  const panel = make('div', 'awakening-panel');
  const title = make('div', 'awakening-title', 'AWAKENING SURGE — CHOOSE YOUR BLESSING');
  const subtitle = make('div', 'awakening-subtitle', '覚醒');
  const countdown = make('div', 'awakening-countdown');
  const track = make('div', 'awakening-track');
  panel.append(title, subtitle, track, countdown);
  root.append(panel);

  let shownKey: string | null = null;
  let buttons: HTMLButtonElement[] = [];
  let lockedUntil = 0;
  let current: PublicAwakeningView | null = null;
  let clearerIsHuman = false;

  function build(view: PublicAwakeningView): void {
    track.replaceChildren();
    buttons = BLESSING_CARDS.map((card) => {
      const button = make('button', `awakening-card accent-${card.accent}`);
      button.type = 'button';
      button.dataset.blessing = card.id;
      button.append(
        make('span', 'awakening-kanji', card.kanji),
        make('span', 'awakening-name', card.title),
        make('span', 'awakening-effect', card.effect),
      );
      button.addEventListener('click', () => {
        if (!current || !clearerIsHuman || button.disabled) return;
        const now = performance.now();
        if (now < lockedUntil) return;
        lockedUntil = now + ANSWER_LOCK_MS;
        onChoose(card.id);
      });
      track.append(button);
      return button;
    });
  }

  return {
    render(view, humanClearer, now) {
      current = view;
      clearerIsHuman = humanClearer;
      if (view === null) {
        root.classList.remove('show');
        shownKey = null;
        return;
      }

      const key = `${view.boardId}:${view.decideBy}`;
      if (key !== shownKey) {
        build(view);
        shownKey = key;
      }
      root.classList.add('show');

      const seconds = secondsLeft(view.decideBy, now);
      countdown.textContent = humanClearer
        ? `Choose within ${seconds}s or Sorcery Restoration is granted.`
        : `${labelOf(view.playerId)} is choosing a blessing (${seconds}s)…`;

      for (const button of buttons) {
        button.disabled = !humanClearer;
        button.classList.toggle('pickable', humanClearer);
      }
    },
    reset() {
      current = null;
      shownKey = null;
      root.classList.remove('show');
    },
  };
}
