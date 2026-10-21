import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicMatchView } from '../../src/engine/public-view.js';
import { OST_TRACK } from '../../src/engine/bgm-tension.js';
import { AdaptiveBgmEngine, BGM_STORAGE_KEY, LOW_HP_TENSION, OST_FADE_IN_S, OST_PROFILES } from '../../src/utils/bgm.js';
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

describe('low-HP tension layer', () => {
  /** The pitches of every oscillator the fake context has built, in creation order. */
  function pitches(context: FakeContext): number[] {
    return context.oscillators.map((oscillator) => oscillator.frequency.value);
  }

  it('replaces the siren sweep with a sub-bass heartbeat and a dark drone', () => {
    const profile = OST_PROFILES.LOW_HP_THEME;
    expect(profile.heartbeat).toBe(true);
    // No other track carries the layer: a heartbeat belongs to a fighter near death.
    const others = Object.entries(OST_PROFILES).filter(
      ([track, candidate]) => track !== OST_TRACK.LOW_HP_THEME && candidate.heartbeat,
    );
    expect(others).toEqual([]);

    const context = new FakeContext();
    const engine = engineWith(context);
    engine.start(OST_TRACK.LOW_HP_THEME);

    const frequencies = pitches(context);
    // The drone and its slow drift are the layer's only persistent voices.
    expect(frequencies).toContain(LOW_HP_TENSION.droneHz);
    expect(frequencies).toContain(LOW_HP_TENSION.droneDriftRate);
    // The lub and its dub land on the first beat, and neither is anywhere near the
    // 400-900Hz band the ambulance sweep lived in.
    expect(frequencies).toContain(LOW_HP_TENSION.lubHz);
    expect(frequencies).toContain(LOW_HP_TENSION.dubHz);

    // The cue this replaced swept a triangle from 600Hz to 1kHz once a bar. No oscillator
    // may climb into that band any more: that sweep is the ambulance siren.
    expect(context.oscillators.some((osc) => osc.frequency.value === 600)).toBe(false);
    const sweptIntoTheMidrange = context.oscillators.some((osc) =>
      osc.frequency.events.some((event) => event.kind === 'lin' && event.value >= 600),
    );
    expect(sweptIntoTheMidrange).toBe(false);
  });

  it('never opens a second layer while one is already sounding', () => {
    const context = new FakeContext();
    const engine = engineWith(context);
    engine.start(OST_TRACK.LOW_HP_THEME);
    const afterStart = context.oscillators.length;
    expect(engine.debugLowHp().active).toBe(true);

    // The render loop asks for the scene on every frame; the HP moving without crossing a
    // tier, and the same scene asked for again, must both cost nothing.
    for (let hp = 20; hp > 12; hp -= 1) engine.updateScene(view(hp), IDLE);
    for (let frame = 0; frame < 20; frame += 1) engine.updateScene(view(12), IDLE);

    expect(context.oscillators.length).toBe(afterStart);
    expect(engine.debugLowHp().active).toBe(true);
  });

  it('fades out, stops and releases every node when HP recovers', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    const engine = engineWith(context);
    engine.start(OST_TRACK.LOW_HP_THEME);
    const gain = engine.debugLowHp().gain;
    expect(gain).not.toBeNull();
    const drone = context.oscillators.find((osc) => osc.frequency.value === LOW_HP_TENSION.droneHz);
    expect(drone).toBeDefined();

    engine.setTrack(OST_TRACK.BATTLE_THEME);

    // The envelope is at silence and the sources are scheduled to stop exactly at the end
    // of the 400ms fade, on the audio clock rather than on a timer.
    expect(gain?.gain.value).toBe(0);
    expect(engine.debugLowHp().active).toBe(false);
    expect(drone?.stoppedAt).toBeCloseTo(LOW_HP_TENSION.fadeS, 5);

    vi.advanceTimersByTime(LOW_HP_TENSION.fadeS * 1000 + 200);
    // Every node the layer owned is out of the graph: nothing is left to accumulate across
    // a long fight that dips in and out of low HP.
    const connections = (node: unknown): unknown[] => (node as { connections: unknown[] }).connections;
    expect(connections(drone)).toEqual([]);
    expect(connections(gain)).toEqual([]);
  });

  it('leaves with the match when the engine stops', () => {
    const context = new FakeContext();
    const engine = engineWith(context);
    engine.start(OST_TRACK.LOW_HP_THEME);
    engine.stop();
    expect(engine.debugLowHp().active).toBe(false);
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
