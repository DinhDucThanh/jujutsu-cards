import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_SETTINGS_KEY,
  DEFAULT_AUDIO_SETTINGS,
  applyAudioSettings,
  loadAudioSettings,
  saveAudioSettings,
  type AudioSettingsStorage,
} from '../../src/utils/audio-settings.js';

function memoryStorage(initial: Record<string, string> = {}): AudioSettingsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe('audio settings store', () => {
  it('falls back to the defaults when nothing is saved or the entry is corrupt', () => {
    expect(loadAudioSettings(memoryStorage())).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(loadAudioSettings(memoryStorage({ [AUDIO_SETTINGS_KEY]: '{not json' }))).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(loadAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('clamps volumes into 0..1 and keeps valid fields', () => {
    const storage = memoryStorage({
      [AUDIO_SETTINGS_KEY]: JSON.stringify({
        master: { volume: 3, muted: true },
        bgm: { volume: -1, muted: 'yes' },
        sfx: { volume: 0.25, muted: false },
      }),
    });
    expect(loadAudioSettings(storage)).toEqual({
      master: { volume: 1, muted: true },
      bgm: { volume: 0, muted: DEFAULT_AUDIO_SETTINGS.bgm.muted },
      sfx: { volume: 0.25, muted: false },
    });
  });

  it('round-trips through save and load', () => {
    const storage = memoryStorage();
    const settings = {
      master: { volume: 0.5, muted: false },
      bgm: { volume: 0.3, muted: true },
      sfx: { volume: 0.9, muted: false },
    };
    saveAudioSettings(settings, storage);
    expect(loadAudioSettings(storage)).toEqual(settings);
  });

  it('scales each channel by the master volume and applies mutes from either side', () => {
    const sfx = { setVolume: vi.fn(), setMuted: vi.fn() };
    const bgm = { setVolume: vi.fn(), setMuted: vi.fn() };
    applyAudioSettings(
      {
        master: { volume: 0.5, muted: false },
        bgm: { volume: 0.8, muted: true },
        sfx: { volume: 1, muted: false },
      },
      { sfx, bgm },
    );
    expect(sfx.setVolume).toHaveBeenCalledWith(0.5);
    expect(sfx.setMuted).toHaveBeenCalledWith(false);
    expect(bgm.setVolume).toHaveBeenCalledWith(0.4);
    expect(bgm.setMuted).toHaveBeenCalledWith(true);
  });

  it('silences both channels when the master is muted', () => {
    const sfx = { setVolume: vi.fn(), setMuted: vi.fn() };
    const bgm = { setVolume: vi.fn(), setMuted: vi.fn() };
    applyAudioSettings({ ...DEFAULT_AUDIO_SETTINGS, master: { volume: 1, muted: true } }, { sfx, bgm });
    expect(sfx.setMuted).toHaveBeenCalledWith(true);
    expect(bgm.setMuted).toHaveBeenCalledWith(true);
  });
});
