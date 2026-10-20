// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSoundToggle } from '../../src/web/sound-toggle.js';

function fakeSound(initialMuted = false) {
  let state = initialMuted;
  return {
    get muted(): boolean {
      return state;
    },
    toggle: (): boolean => {
      state = !state;
      return state;
    },
    unlock: vi.fn(),
  };
}

let teardown: (() => void) | null = null;

function setup(muted = false) {
  // Every mount installs a document-level keydown listener; without unmounting the
  // previous test's toggle it would answer the same shortcut first.
  teardown?.();
  document.body.innerHTML = '<input id="room-code" /><button id="sound-toggle"></button>';
  const button = document.querySelector('#sound-toggle') as HTMLButtonElement;
  const sound = fakeSound(muted);
  const cleanup = mountSoundToggle(button, sound);
  teardown = cleanup;
  return { button, sound, cleanup };
}

function press(key: string, target: EventTarget = document.body): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
}

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = '';
});

describe('sound toggle', () => {
  it('starts unmuted and describes itself for assistive tech', () => {
    const { button } = setup();
    expect(button.classList.contains('muted')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Mute sound (M)');
  });

  it('mutes on click without waking the audio context', () => {
    const { button, sound } = setup();
    button.click();
    expect(sound.muted).toBe(true);
    expect(button.classList.contains('muted')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe('Unmute sound (M)');
    expect(sound.unlock).not.toHaveBeenCalled();
  });

  it('unmutes on the next click and resumes audio from that gesture', () => {
    const { button, sound } = setup(true);
    expect(button.classList.contains('muted')).toBe(true);
    button.click();
    expect(sound.muted).toBe(false);
    expect(sound.unlock).toHaveBeenCalledTimes(1);
  });

  it('toggles with M, but not while typing in the setup form', () => {
    const { sound } = setup();
    const roomCode = document.querySelector('#room-code') as HTMLInputElement;

    press('m', roomCode);
    expect(sound.muted).toBe(false);

    press('m');
    expect(sound.muted).toBe(true);

    press('M');
    expect(sound.muted).toBe(false);
  });

  it('ignores modified shortcuts so browser and OS bindings keep working', () => {
    const { sound } = setup();
    const event = new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(sound.muted).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('detaches every listener on cleanup', () => {
    const { button, sound, cleanup } = setup();
    cleanup();
    button.click();
    press('m');
    expect(sound.muted).toBe(false);
  });
});
