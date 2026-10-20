import { describe, expect, it, vi } from 'vitest';
import { SOUND_CUE } from '../../src/engine/index.js';
import { SFX_MAX_VOICES, SFX_STORAGE_KEY, createSfxEngine } from '../../src/utils/sfx.js';
import { FakeContext, asAudioContext, fakeStorage } from '../helpers/fake-audio.js';

describe('procedural SFX', () => {
  it('synthesizes every cue with started sources and positive envelopes', () => {
    for (const cue of Object.values(SOUND_CUE)) {
      const context = new FakeContext();
      const engine = createSfxEngine({ storage: null, createContext: () => asAudioContext(context) });

      engine.play(cue);

      const sources = [...context.oscillators, ...context.bufferSources];
      expect(sources.length, cue).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source.startedAt, `${cue} source started`).not.toBeNull();
        expect(source.stoppedAt, `${cue} source stopped`).not.toBeNull();
      }
      // Every exponential ramp already throws on a non-positive target, but pin the
      // intent too: cues are audible, never scheduled at zero gain. A cue may rise with a
      // linear attack (the card flip does), so both ramp kinds count toward the peak.
      const peaks = context.gains.flatMap((gain) =>
        gain.gain.events.filter((event) => event.kind === 'exp' || event.kind === 'lin'),
      );
      expect(peaks.length, cue).toBeGreaterThan(0);
      expect(Math.max(...peaks.map((event) => event.value))).toBeGreaterThan(0.01);
      engine.dispose();
    }
  });

  it('opens the audio context lazily, once, on the first cue', () => {
    const context = new FakeContext();
    const factory = vi.fn(() => asAudioContext(context));
    const engine = createSfxEngine({ storage: null, createContext: factory });

    expect(factory).not.toHaveBeenCalled();
    engine.play(SOUND_CUE.CARD_FLIP);
    engine.play(SOUND_CUE.CARD_MATCH);
    expect(factory).toHaveBeenCalledTimes(1);
    // The master bus feeds the shared pre-amp, which feeds the compressor on the speakers.
    expect(context.gains[0]?.connections).toEqual([context.gains[1]]);
    expect(context.gains[1]?.connections).toEqual([context.compressors[0]]);
    expect(context.compressors[0]?.connections).toEqual([context.destination]);
    engine.dispose();
  });

  it('gives the domain expansion an echo and the barrier a high metallic ring', () => {
    const domainContext = new FakeContext();
    const domain = createSfxEngine({ storage: null, createContext: () => asAudioContext(domainContext) });
    domain.play(SOUND_CUE.DOMAIN_EXPANSION);
    expect(domainContext.delays).toHaveLength(1);

    const barrierContext = new FakeContext();
    const barrier = createSfxEngine({ storage: null, createContext: () => asAudioContext(barrierContext) });
    barrier.play(SOUND_CUE.BARRIER_HIT);
    const highest = Math.max(...barrierContext.oscillators.map((oscillator) => oscillator.frequency.value));
    expect(highest).toBeGreaterThan(2000);
    domain.dispose();
    barrier.dispose();
  });

  it('caps polyphony at eight voices and steals the oldest', () => {
    const context = new FakeContext();
    const engine = createSfxEngine({ storage: null, createContext: () => asAudioContext(context) });
    for (let index = 0; index < SFX_MAX_VOICES + 3; index += 1) engine.play(SOUND_CUE.CARD_FLIP);

    // The master bus is built on the first cue, so it is only readable now.
    const master = context.gains[0];
    if (!master) throw new Error('no master bus');

    // Every live cue owns a bus into the master; only the last eight may still be plugged in.
    const sounding = context.gains.filter((gain) => gain !== master && gain.connections.includes(master));
    expect(sounding).toHaveLength(SFX_MAX_VOICES);
    // The three oldest were stolen: their buses are disconnected from the master.
    expect(context.gains.filter((gain) => gain !== master && gain.connections.length === 0)).toHaveLength(3);
    engine.dispose();
  });

  it('stays silent and never builds a context while muted', () => {
    const context = new FakeContext();
    const factory = vi.fn(() => asAudioContext(context));
    const engine = createSfxEngine({ storage: null, createContext: factory });

    engine.setMuted(true);
    engine.play(SOUND_CUE.BLACK_FLASH);
    expect(factory).not.toHaveBeenCalled();
    expect(context.oscillators).toHaveLength(0);
    engine.dispose();
  });

  it('remembers the mute preference and restores it on the next load', () => {
    const storage = fakeStorage();
    const first = createSfxEngine({ storage, createContext: () => null });
    expect(first.muted).toBe(false);
    expect(first.isMuted).toBe(false);

    expect(first.toggle()).toBe(true);
    expect(storage.read(SFX_STORAGE_KEY)).toBe('1');

    // `isMuted` is the same preference under its settings-model name.
    first.isMuted = false;
    expect(first.muted).toBe(false);
    expect(storage.read(SFX_STORAGE_KEY)).toBe('0');
    first.isMuted = true;
    expect(first.muted).toBe(true);
    first.dispose();

    const second = createSfxEngine({ storage, createContext: () => null });
    expect(second.muted).toBe(true);
    expect(second.toggle()).toBe(false);
    expect(storage.read(SFX_STORAGE_KEY)).toBe('0');
  });

  it('pre-bakes every cue and then replays a buffer instead of synthesizing it', async () => {
    const cueCount = Object.values(SOUND_CUE).length;
    const context = new FakeContext();
    let renders = 0;
    const engine = createSfxEngine({
      storage: null,
      createContext: () => asAudioContext(context),
      createOfflineContext: (sampleRate) => {
        const offline = Object.assign(new FakeContext(), {
          startRendering: () => {
            renders += 1;
            return Promise.resolve({ sampleRate, duration: 0.4 } as unknown as AudioBuffer);
          },
        });
        return offline as unknown as OfflineAudioContext;
      },
    });

    engine.prewarm();
    await vi.waitFor(() => expect(engine.bakedCueCount).toBe(cueCount));
    expect(renders).toBe(cueCount);

    const oscillatorsBefore = context.oscillators.length;
    engine.play(SOUND_CUE.BLACK_FLASH);
    // Nothing was synthesized on the live graph: the cue was a cached buffer.
    expect(context.oscillators).toHaveLength(oscillatorsBefore);
    const source = context.bufferSources.at(-1);
    expect(source?.buffer).not.toBeNull();
    expect(source?.startedAt).not.toBeNull();
    expect(source?.stoppedAt).not.toBeNull();

    engine.dispose();
    expect(engine.bakedCueCount).toBe(0);
  });

  it('unlocks the audio bus on the first touch and then stops listening', () => {
    const context = new FakeContext();
    context.state = 'suspended';
    const target = new EventTarget();
    const engine = createSfxEngine({ storage: null, createContext: () => asAudioContext(context) });
    const resume = vi.spyOn(context, 'resume');

    engine.armGestureUnlock(target);
    expect(context.bufferSources).toHaveLength(0);

    target.dispatchEvent(new Event('touchstart'));
    const silence = context.bufferSources.at(-1);
    expect(silence?.buffer).not.toBeNull();
    expect(silence?.startedAt).not.toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);

    // Listeners are gone after the first gesture, so later touches do nothing more.
    target.dispatchEvent(new Event('touchend'));
    target.dispatchEvent(new Event('click'));
    expect(context.bufferSources).toHaveLength(1);

    engine.dispose();
  });

  it('is a no-op when the platform has no usable AudioContext', () => {
    const engine = createSfxEngine({ storage: null, createContext: () => null });
    expect(() => engine.play(SOUND_CUE.SKILL_CAST)).not.toThrow();
    expect(() => engine.unlock()).not.toThrow();
    engine.dispose();
  });
});
