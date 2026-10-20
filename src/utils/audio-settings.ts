/** localStorage key for the audio mixer: master, BGM/OST and SFX volume plus each mute. */
export const AUDIO_SETTINGS_KEY = 'jjk_audio_settings';

export interface AudioChannel {
  /** 0 to 1. */
  readonly volume: number;
  readonly muted: boolean;
}

export interface AudioSettings {
  readonly master: AudioChannel;
  readonly bgm: AudioChannel;
  readonly sfx: AudioChannel;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: { volume: 1, muted: false },
  bgm: { volume: 0.8, muted: false },
  sfx: { volume: 1, muted: false },
};

export interface AudioSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The sound engines this store drives. Each only needs a level and a mute. */
export interface AudioTargets {
  readonly sfx: { setVolume(volume: number): void; setMuted(muted: boolean): void };
  readonly bgm: { setVolume(volume: number): void; setMuted(muted: boolean): void };
}

function defaultStorage(): AudioSettingsStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

function readChannel(raw: unknown, fallback: AudioChannel): AudioChannel {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const channel = raw as { volume?: unknown; muted?: unknown };
  return {
    volume: clampVolume(channel.volume, fallback.volume),
    muted: typeof channel.muted === 'boolean' ? channel.muted : fallback.muted,
  };
}

/** Reads the saved mixer. A missing, blocked or corrupt entry falls back to the defaults. */
export function loadAudioSettings(storage: AudioSettingsStorage | null = defaultStorage()): AudioSettings {
  if (!storage) return DEFAULT_AUDIO_SETTINGS;
  let parsed: unknown = null;
  try {
    const raw = storage.getItem(AUDIO_SETTINGS_KEY);
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_AUDIO_SETTINGS;
  const record = parsed as Record<string, unknown>;
  return {
    master: readChannel(record.master, DEFAULT_AUDIO_SETTINGS.master),
    bgm: readChannel(record.bgm, DEFAULT_AUDIO_SETTINGS.bgm),
    sfx: readChannel(record.sfx, DEFAULT_AUDIO_SETTINGS.sfx),
  };
}

/** Saves the mixer. A blocked write only costs the choice on the next load. */
export function saveAudioSettings(
  settings: AudioSettings,
  storage: AudioSettingsStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Nothing to do: the mixer still applies for this session.
  }
}

/**
 * Pushes the mixer into the engines. The master level scales both channels, so the effective
 * channel level is the master times the channel's own volume, and a mute on either side silences it.
 */
export function applyAudioSettings(settings: AudioSettings, targets: AudioTargets): void {
  const sfxLevel = settings.master.volume * settings.sfx.volume;
  const bgmLevel = settings.master.volume * settings.bgm.volume;
  targets.sfx.setVolume(sfxLevel);
  targets.sfx.setMuted(settings.master.muted || settings.sfx.muted);
  targets.bgm.setVolume(bgmLevel);
  targets.bgm.setMuted(settings.master.muted || settings.bgm.muted);
}
