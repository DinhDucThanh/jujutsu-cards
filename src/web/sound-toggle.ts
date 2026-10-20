import type { SfxEngine } from '../utils/sfx.js';

type ToggleEngine = Pick<SfxEngine, 'muted' | 'toggle' | 'unlock'>;

/** True for controls where an "M" key is a letter, not a shortcut. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Wires the top-bar speaker button to the sound engine.
 *
 * The icon is pure state (`aria-pressed` plus the `muted` class), so CSS decides which
 * glyph shows and screen readers get the same answer as the eye. M is bound as a shortcut
 * because muting mid-match should not need a mouse; it is ignored while typing in the
 * setup form's room code or HP inputs.
 */
export function mountSoundToggle(button: HTMLButtonElement, engine: ToggleEngine): () => void {
  const render = (): void => {
    const muted = engine.muted;
    button.classList.toggle('muted', muted);
    button.setAttribute('aria-pressed', String(muted));
    const label = muted ? 'Unmute sound (M)' : 'Mute sound (M)';
    button.setAttribute('aria-label', label);
    button.title = label;
  };

  const flip = (): void => {
    engine.toggle();
    // A click on this button is also the user gesture that may create the AudioContext.
    if (!engine.muted) engine.unlock();
    render();
  };

  const onClick = (): void => flip();

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat) return;
    if (event.key !== 'm' && event.key !== 'M') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    flip();
  };

  button.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);
  render();

  return () => {
    button.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKeyDown);
  };
}
