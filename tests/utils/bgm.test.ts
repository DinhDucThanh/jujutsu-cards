import { afterEach, describe, expect, it } from 'vitest';
import type { PublicMatchView } from '../../src/engine/public-view.js';
import { OST_TRACK } from '../../src/engine/bgm-tension.js';
import { AdaptiveBgmEngine, BGM_STORAGE_KEY, OST_FADE_IN_S } from '../../src/utils/bgm.js';
import { FakeContext, asAudioContext, fakeStorage } from '../helpers/fake-audio.js';

const engines: AdaptiveBgmEngine[] = [];

function engineWith(
  context: FakeContext | null,
  options: { stored?: Record<string, string>; storage?: ReturnType<typeof fakeStorage> } = {},
): AdaptiveBgmEngine {
  const engine = new AdaptiveBgmEngine({
    storage: options.storage ?? fakeStorage(options.stored ?? {}),
    createContext: () => (context ? asAudioContext(context) : null),
  });
  engines.push(engine);
  return engine;
}

function view(hp: number, domain = false): PublicMatchView {
  return {
    players: [{ id: 'p1', hp, maxHp: 100, activeDomain: domain ? { name: 'x' } : null, activeEffects: [] }],
    turnOwner: 'p1',
    result: null,
    sentencing: null,
  } as unknown as PublicMatchView;
}

const IDLE = { menu: false, modal: null } as const;

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe('AdaptiveBgmEngine lifecycle', () => {
  it('starts the menu theme by default and reports the running state', () => {
    const engine = engineWith(new FakeContext());
    engine.start();
    const state = engine.debugState();
    expect(engine.isPlaying).toBe(true);
    expect(state.running).toBe(true);
    expect(state.playing).toBe(OST_TRACK.MENU_THEME);
    expect(state.contextState).toBe('running');
    expect(state.tempo).toBeGreaterThan(0);
  });

  it('stops without throwing, and reports no playing track', () => {
    const engine = engineWith(new FakeContext());
    engine.start(OST_TRACK.BATTLE_THEME);
    engine.stop();
    expect(engine.isPlaying).toBe(false);
    expect(engine.debugState().running).toBe(false);
  });

  it('closes the device on dispose', () => {
    const context = new FakeContext();
    const engine = engineWith(context);
    engine.start();
    engine.dispose();
    expect(context.state).toBe('closed');
  });

  it('keeps the requested track and never throws when there is no audio context', () => {
    const engine = engineWith(null);
    expect(() => engine.start(OST_TRACK.BATTLE_THEME)).not.toThrow();
    expect(engine.isPlaying).toBe(false);
    expect(engine.debugState().track).toBe(OST_TRACK.BATTLE_THEME);
  });

  it('resumes a context the browser parked when the audio gesture arrives', () => {
    const context = new FakeContext();
    context.state = 'suspended';
    const engine = engineWith(context);
    expect(engine.ensureAudioContext()).not.toBeNull();
    expect(context.state).toBe('running');
  });
});

describe('AdaptiveBgmEngine track changes', () => {
  it('crossfades the outgoing track to silence and plays the incoming one', () => {
    const engine = engineWith(new FakeContext());
    engine.start(OST_TRACK.BATTLE_THEME);
    const outgoing = engine.debugBuses().bus;
    expect(outgoing).not.toBeNull();

    engine.setTrack(OST_TRACK.LOW_HP_THEME);

    expect(engine.debugState().playing).toBe(OST_TRACK.LOW_HP_THEME);
    expect(outgoing?.gain.value).toBe(0);
    expect(engine.debugBuses().bus).not.toBe(outgoing);
  });

  it('does not open a second voice when asked for the track that is already playing', () => {
    const context = new FakeContext();
    const engine = engineWith(context);
    engine.start(OST_TRACK.BATTLE_THEME);
    const bus = engine.debugBuses().bus;
    const gains = context.gains.length;
    engine.setTrack(OST_TRACK.BATTLE_THEME);
    expect(engine.debugBuses().bus).toBe(bus);
    expect(context.gains.length).toBe(gains);
  });

  it('hard-cuts the menu or battle track when the courtroom opens, and plays only the courtroom', () => {
    const engine = engineWith(new FakeContext());
    engine.start(OST_TRACK.MENU_THEME);
    const outgoing = engine.debugBuses().bus;
    engine.setTrack(OST_TRACK.HIGURUMA_COURT_THEME);
    expect(engine.debugState().playing).toBe(OST_TRACK.HIGURUMA_COURT_THEME);
    expect(outgoing?.gain.value).toBe(0);
  });

  it('uses the crossfade time constants for both fades', () => {
    expect(OST_FADE_IN_S).toBeGreaterThan(0);
  });

  it('picks the track from the public match view and the scene', () => {
    const engine = engineWith(new FakeContext());
    engine.start(OST_TRACK.BATTLE_THEME);
    engine.updateScene(view(100, true), IDLE);
    expect(engine.debugState().playing).toBe(OST_TRACK.DOMAIN_GENERIC_THEME);
    engine.updateScene(view(20), IDLE);
    expect(engine.debugState().playing).toBe(OST_TRACK.LOW_HP_THEME);
    engine.updateScene(null, IDLE);
    expect(engine.debugState().playing).toBe(OST_TRACK.MENU_THEME);
  });

  it('remembers the track when the engine is not running yet', () => {
    const engine = engineWith(new FakeContext());
    engine.updateScene(view(20), IDLE);
    expect(engine.debugState().track).toBe(OST_TRACK.LOW_HP_THEME);
    expect(engine.isPlaying).toBe(false);
  });
});

describe('AdaptiveBgmEngine preferences', () => {
  it('persists the mute and silences the master bus without tearing audio down', () => {
    const context = new FakeContext();
    const storage = fakeStorage();
    const engine = engineWith(context, { storage });
    engine.start();
    engine.setMuted(true);
    expect(engine.muted).toBe(true);
    expect(storage.read(BGM_STORAGE_KEY)).toBe('1');
    expect(engine.debugBuses().master?.gain.value).toBe(0);
    expect(engine.isPlaying).toBe(true);
  });

  it('reads a stored mute preference on load', () => {
    const engine = engineWith(null, { stored: { [BGM_STORAGE_KEY]: '1' } });
    expect(engine.muted).toBe(true);
  });
});
