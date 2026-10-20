// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLESSING } from '../../src/engine/index.js';
import { AWAKENING_TOAST_MS, blessingTitle, showAwakeningToast } from '../../src/web/awakening-modal.js';

describe('Awakening Surge HUD banner', () => {
  let slot: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    slot = document.createElement('div');
    document.body.append(slot);
  });

  afterEach(() => {
    vi.useRealTimers();
    slot.remove();
  });

  it('shows the rolled blessing and removes it after 3.5 seconds', () => {
    showAwakeningToast(slot, BLESSING.SIX_EYES_INSIGHT);

    const toast = slot.querySelector('.awakening-toast');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain(blessingTitle(BLESSING.SIX_EYES_INSIGHT));
    expect(AWAKENING_TOAST_MS).toBe(3500);

    vi.advanceTimersByTime(AWAKENING_TOAST_MS - 1);
    expect(slot.querySelector('.awakening-toast')).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(slot.querySelector('.awakening-toast')).toBeNull();
  });

  it('replaces an older banner in the same slot instead of stacking', () => {
    showAwakeningToast(slot, BLESSING.LATENT_BLACK_FLASH);
    showAwakeningToast(slot, BLESSING.SORCERY_RESTORATION);

    expect(slot.querySelectorAll('.awakening-toast')).toHaveLength(1);
    expect(slot.textContent).toContain(blessingTitle(BLESSING.SORCERY_RESTORATION));
  });
});
