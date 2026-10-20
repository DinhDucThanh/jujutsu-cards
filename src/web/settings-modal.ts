import { bgm } from '../utils/bgm.js';
import {
  applyAudioSettings,
  loadAudioSettings,
  saveAudioSettings,
  type AudioChannel,
  type AudioSettings,
} from '../utils/audio-settings.js';
import { playBlackFlash, playCardFlip, sfx } from '../utils/sfx.js';

export const GAMEPLAY_STORAGE_KEY = 'jjk_gameplay_settings';

export interface GameplaySettings {
  readonly screenShake: boolean;
  readonly floatingText: boolean;
  readonly domainZoom: boolean;
}

export const DEFAULT_GAMEPLAY_SETTINGS: GameplaySettings = { screenShake: true, floatingText: true, domainZoom: true };

/** Each gameplay switch maps to a root class that the stylesheet uses to switch the effect off. */
export function applyGameplayClasses(gameplay: GameplaySettings, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('no-screen-shake', !gameplay.screenShake);
  root.classList.toggle('no-floating-text', !gameplay.floatingText);
  root.classList.toggle('no-domain-zoom', !gameplay.domainZoom);
}

/** The exact credit line shown on the Developer Info card. */
export const DEVELOPER_CREDIT = 'Thành đẹp zai best Tamyn btw.';

type ChannelKey = keyof AudioSettings;

export function loadGameplaySettings(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): GameplaySettings {
  if (!storage) return DEFAULT_GAMEPLAY_SETTINGS;
  try {
    const parsed = JSON.parse(storage.getItem(GAMEPLAY_STORAGE_KEY) ?? 'null') as Partial<GameplaySettings> | null;
    return {
      screenShake: typeof parsed?.screenShake === 'boolean' ? parsed.screenShake : DEFAULT_GAMEPLAY_SETTINGS.screenShake,
      floatingText: typeof parsed?.floatingText === 'boolean' ? parsed.floatingText : DEFAULT_GAMEPLAY_SETTINGS.floatingText,
      domainZoom: typeof parsed?.domainZoom === 'boolean' ? parsed.domainZoom : DEFAULT_GAMEPLAY_SETTINGS.domainZoom,
    };
  } catch {
    return DEFAULT_GAMEPLAY_SETTINGS;
  }
}

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export interface SettingsModalOptions {
  readonly root: HTMLElement;
  readonly trigger: HTMLButtonElement;
}

export interface SettingsModal {
  open(): void;
  close(): void;
}

/** Wires the settings modal: the mixer writes through to the engines and to localStorage on every change. */
export function createSettingsModal(options: SettingsModalOptions): SettingsModal {
  const { root, trigger } = options;
  let settings = loadAudioSettings();
  let gameplay = loadGameplaySettings();
  applyGameplayClasses(gameplay);

  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
  const panel = root.querySelector<HTMLElement>('.settings-panel');
  const volumeInputs = [...root.querySelectorAll<HTMLInputElement>('[data-volume]')];
  const muteInputs = [...root.querySelectorAll<HTMLInputElement>('[data-mute]')];
  const prefInputs = [...root.querySelectorAll<HTMLInputElement>('[data-pref]')];

  function paint(): void {
    for (const input of volumeInputs) {
      const key = input.dataset.volume as ChannelKey;
      const percent = Math.round(settings[key].volume * 100);
      input.value = String(percent);
      // Drives the gold fill of the slider track in settings-modal.css.
      input.style.setProperty('--fill', `${percent}%`);
      const badge = root.querySelector<HTMLElement>(`[data-badge="${key}"]`);
      if (badge) badge.textContent = `${percent}%`;
    }
    for (const input of muteInputs) {
      input.checked = settings[input.dataset.mute as ChannelKey].muted;
    }
    for (const input of prefInputs) {
      input.checked = gameplay[input.dataset.pref as keyof GameplaySettings];
    }
  }

  function updateChannel(key: ChannelKey, patch: Partial<AudioChannel>): void {
    settings = { ...settings, [key]: { ...settings[key], ...patch } };
    saveAudioSettings(settings);
    applyAudioSettings(settings, { sfx, bgm });
    paint();
  }

  function showTab(name: string): void {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.classList.toggle('active', active);
    }
    for (const body of panels) body.hidden = body.dataset.panel !== name;
  }

  for (const input of volumeInputs) {
    input.addEventListener('input', () => {
      updateChannel(input.dataset.volume as ChannelKey, { volume: Number(input.value) / 100 });
    });
  }
  for (const input of muteInputs) {
    input.addEventListener('change', () => {
      updateChannel(input.dataset.mute as ChannelKey, { muted: input.checked });
    });
  }
  for (const input of prefInputs) {
    input.addEventListener('change', () => {
      gameplay = { ...gameplay, [input.dataset.pref as keyof GameplaySettings]: input.checked };
      applyGameplayClasses(gameplay);
      try {
        localStorage.setItem(GAMEPLAY_STORAGE_KEY, JSON.stringify(gameplay));
      } catch {
        // A blocked write only costs the preference on the next load.
      }
    });
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab ?? 'audio'));
  }

  // The test buttons play through the engine, so a fresh click unlocks audio first.
  root.querySelector<HTMLButtonElement>('[data-test="flip"]')?.addEventListener('click', () => {
    sfx.unlock();
    playCardFlip();
  });
  root.querySelector<HTMLButtonElement>('[data-test="black-flash"]')?.addEventListener('click', () => {
    sfx.unlock();
    playBlackFlash();
  });

  function close(): void {
    if (root.hidden) return;
    root.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function open(): void {
    settings = loadAudioSettings();
    paint();
    showTab('audio');
    root.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    panel?.focus();
  }

  trigger.addEventListener('click', open);
  for (const closer of root.querySelectorAll<HTMLElement>('[data-close]')) {
    closer.addEventListener('click', close);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) close();
  });

  paint();
  return { open, close };
}
