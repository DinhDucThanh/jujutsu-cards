import { SOUND_CUE, type SoundCue } from '../engine/sound-cues.js';

/**
 * Procedural sound effects.
 *
 * Every effect is synthesized on demand from oscillators, a noise buffer, gain envelopes
 * and biquad filters, so the game ships with sound and no audio files. The engine never
 * imports this module: it names a cue (`SoundCue`) and the UI decides whether to play it.
 *
 * The AudioContext is created lazily on the first cue, because browsers refuse to start
 * audio outside a user gesture. A context that fails to construct (jsdom, a locked-down
 * embed) simply makes `play` a no-op — sound must never be able to break a turn.
 */

import { createMasterOutput } from './audio-master.js';

export const SFX_STORAGE_KEY = 'jujutsu-cards.sfx.muted';

const MASTER_LEVEL = 1.2;
/** Noise bed length; every noise-based cue is shorter than this. */
const NOISE_SECONDS = 0.6;

/**
 * Every cue is rendered once, up front, into a buffer of this length. It is the longest
 * cue in this file (the Domain Expansion drone plus its echo tail) with a little slack,
 * so a baked cue can never be cut short.
 */
const BAKE_SECONDS = 2.6;

/**
 * Hard cap on voices sounding at once. A turn can fire a dozen cues in one batch (a
 * scouting reveal, a match, a synergy and its damage); past this many the oldest voice is
 * stolen, which keeps the audio thread fed instead of letting the graph pile up and
 * underrun the buffer.
 */
export const SFX_MAX_VOICES = 8;

export interface SfxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SfxEngineOptions {
  /** Defaults to `localStorage` when it is reachable, so the mute choice survives reloads. */
  readonly storage?: SfxStorage | null;
  /** Defaults to the platform AudioContext; injectable so tests can run without Web Audio. */
  readonly createContext?: () => AudioContext | null;
  /**
   * Defaults to the platform OfflineAudioContext. Returning null (jsdom, a locked-down
   * embed) simply means cues are synthesized live, exactly as before pre-baking.
   */
  readonly createOfflineContext?: (sampleRate: number, length: number) => OfflineAudioContext | null;
}

/** One cue currently sounding, on either path. Stealing it frees its slot immediately. */
interface Voice {
  /** Context time this voice is done and its slot can be reused. */
  readonly endsAt: number;
  stop(): void;
}

function defaultStorage(): SfxStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can be blocked by the embedder; a missing preference is not an error.
    return null;
  }
}

function defaultContextFactory(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function defaultOfflineFactory(): ((sampleRate: number, length: number) => OfflineAudioContext | null) | null {
  if (typeof window === 'undefined') return null;
  const scope = window as typeof window & {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Ctor = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (!Ctor) return null;
  return (sampleRate, length) => {
    try {
      return new Ctor(1, length, sampleRate);
    } catch {
      return null;
    }
  };
}

/** Disconnects a finished source so a long match cannot accumulate a node graph. */
function releaseOnEnd(source: AudioScheduledSourceNode): void {
  source.onended = () => {
    try {
      source.disconnect();
    } catch {
      // Already detached; nothing to do.
    }
  };
}

/**
 * Scales a batch of baked cues so the loudest sample across the batch sits at the ceiling.
 * One shared gain keeps the cues' relative levels intact: a hover tick stays quieter than a
 * flip, while the whole set uses the available headroom instead of sounding timid.
 */
const BAKE_PEAK_CEILING = 0.93;

function normalizeBatch(batch: Map<SoundCue, AudioBuffer>): void {
  let batchPeak = 0;
  for (const buffer of batch.values()) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      for (const sample of buffer.getChannelData(channel)) {
        const magnitude = Math.abs(sample);
        if (magnitude > batchPeak) batchPeak = magnitude;
      }
    }
  }
  if (batchPeak <= 0) return;
  const scale = BAKE_PEAK_CEILING / batchPeak;
  for (const buffer of batch.values()) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      data.forEach((sample, i) => {
        data[i] = sample * scale;
      });
    }
  }
}

/** Soft-clipping curve for the Black Flash clap. */
function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < samples; i += 1) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}

/** Bell strikes of the regular jackpot chime: six notes up a major scale, in Hz. */
const BELL_STRIKES_REGULAR = [1046.5, 1174.66, 1318.5, 1568, 1760, 2093];
/** Golden (7-7-7): the same scale over two octaves, twelve strikes. */
const BELL_STRIKES_GOLDEN = [
  1046.5, 1174.66, 1318.5, 1568, 1760, 2093, 2349.32, 2637, 3136, 3520, 4186, 4698.64,
];
/** Inharmonic bell partials, in Hz at the 2093Hz reference; scaled to each strike's pitch. */
const BELL_PARTIALS: readonly { readonly hz: number; readonly peak: number }[] = [
  { hz: 2093, peak: 0.3 },
  { hz: 2637, peak: 0.2 },
  { hz: 3136, peak: 0.14 },
  { hz: 4186, peak: 0.08 },
];
const BELL_REFERENCE_HZ = 2093;
const BELL_SPACING_S = 0.065;
const BELL_DECAY_S = 0.18;

export class SfxEngine {
  private readonly storage: SfxStorage | null;
  private readonly factory: () => AudioContext | null;
  private readonly offlineFactory: ((sampleRate: number, length: number) => OfflineAudioContext | null) | null;
  private context: AudioContext | null = null;
  /** True while the one-time iOS gesture unlocker is still waiting for a touch. */
  private gestureArmed = false;
  private master: GainNode | null = null;
  private noiseBed: AudioBuffer | null = null;
  /** Cues pre-rendered at launch, keyed by cue, so a hit is a buffer replay, not a synth. */
  private readonly baked = new Map<SoundCue, AudioBuffer>();
  /** True while a bake pass is running, so a second call cannot double the work. */
  private baking = false;
  /** Voices currently sounding, oldest first; the polyphony limit steals from the front. */
  private readonly voices: Voice[] = [];
  private mutedState: boolean;
  /** The sfx channel's own level, 0 to 1, on top of the master level. */
  private volumeState = 1;
  /** Cues that already threw once, so a broken voice cannot spam the console. */
  private readonly warned = new Set<SoundCue>();

  constructor(options: SfxEngineOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.factory = options.createContext ?? defaultContextFactory;
    this.offlineFactory = options.createOfflineContext ?? defaultOfflineFactory();
    this.mutedState = this.readStoredMute();
  }

  get muted(): boolean {
    return this.mutedState;
  }

  /** Same preference under the name the audio settings are modelled with. */
  get isMuted(): boolean {
    return this.mutedState;
  }

  set isMuted(muted: boolean) {
    this.setMuted(muted);
  }

  /** Persists the preference and silences the master bus without tearing audio down. */
  setMuted(muted: boolean): void {
    this.mutedState = muted;
    try {
      this.storage?.setItem(SFX_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // A blocked write only costs the preference on the next load.
    }
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL * this.volumeState, this.context.currentTime, 0.015);
    }
    // Nothing is baked while muted; unmuting is the moment the cache becomes worth its CPU.
    if (!muted) this.prewarm();
  }

  /** Sets the sfx channel level (0 to 1). The settings store owns persistence. */
  setVolume(volume: number): void {
    this.volumeState = Math.min(Math.max(volume, 0), 1);
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        this.mutedState ? 0 : MASTER_LEVEL * this.volumeState,
        this.context.currentTime,
        0.015,
      );
    }
  }

  /** Flips mute and returns the new state. */
  toggle(): boolean {
    this.setMuted(!this.mutedState);
    return this.mutedState;
  }

  /** Resumes a suspended context, e.g. from a click handler. */
  unlock(): void {
    const context = this.ensureContext();
    if (context && context.state === 'suspended') void context.resume().catch(() => {});
    this.prewarm();
  }

  /**
   * iOS Safari keeps the audio bus muted until a real touch. This arms a one-time listener
   * on the target: the first touchstart, touchend or click resumes the context, plays a
   * single silent sample to unlock the bus, then removes its listeners. Safe to call again
   * once it has fired; it does nothing when no window exists.
   */
  armGestureUnlock(target: EventTarget | null = typeof window === 'undefined' ? null : window): void {
    if (!target || this.gestureArmed) return;
    this.gestureArmed = true;
    const events = ['touchstart', 'touchend', 'click'] as const;
    const unlockOnGesture = (): void => {
      for (const type of events) target.removeEventListener(type, unlockOnGesture);
      this.gestureArmed = false;
      const context = this.ensureContext();
      if (!context) return;
      const silence = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      source.buffer = silence;
      source.connect(context.destination);
      source.start(0);
      if (context.state === 'suspended') void context.resume().catch(() => {});
      this.prewarm();
    };
    for (const type of events) target.addEventListener(type, unlockOnGesture, { passive: true });
  }

  /**
   * Renders every cue into a cached buffer, once, ahead of the first turn.
   *
   * Live synthesis allocates an oscillator graph per cue, on the main thread, at exactly
   * the moment a frame is being drawn. Baking that work into an `OfflineAudioContext` at
   * launch (or on the first gesture, or on unmute) turns every later hit into a buffer
   * replay, so a busy board can never stall a sound. Safe to call repeatedly: it bakes
   * only what is missing, and does nothing while muted or when the platform has no
   * offline context.
   */
  prewarm(): void {
    if (this.mutedState || this.baking || !this.offlineFactory) return;
    const context = this.ensureContext();
    if (!context) return;
    this.baking = true;
    void this.bakeAll(context.sampleRate).finally(() => {
      this.baking = false;
    });
  }

  play(cue: SoundCue, intensity = 1): void {
    if (this.mutedState) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    if (context.state === 'suspended') {
      // Scheduling into a paused clock would dump every queued sound at once on resume.
      void context.resume().catch(() => {});
      return;
    }
    const level = Math.min(Math.max(intensity, 0), 1);
    const at = context.currentTime + 0.005;
    this.makeRoom();
    try {
      const baked = this.baked.get(cue);
      if (baked && baked.sampleRate === context.sampleRate) {
        this.playBaked(context, baked, at, level);
        return;
      }
      this.playLive(context, cue, at, level);
    } catch (error) {
      // One unsupported node type must not interrupt a match, but a silently broken voice
      // is undebuggable: report each failing cue once and then stay quiet.
      if (!this.warned.has(cue)) {
        this.warned.add(cue);
        console.warn(`[sfx] ${cue} could not be synthesized`, error);
      }
    }
  }

  /** Stops the audio graph (tests and teardown). The engine is unusable afterwards. */
  dispose(): void {
    const context = this.context;
    this.context = null;
    this.master = null;
    this.noiseBed = null;
    this.baked.clear();
    this.voices.length = 0;
    this.warned.clear();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }

  /** True once every cue has a buffer, for diagnostics and tests. */
  get bakedCueCount(): number {
    return this.baked.size;
  }

  private readStoredMute(): boolean {
    try {
      return this.storage?.getItem(SFX_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const context = this.factory();
    if (!context) return null;
    const master = context.createGain();
    master.gain.value = this.mutedState ? 0 : MASTER_LEVEL * this.volumeState;
    master.connect(createMasterOutput(context));
    this.context = context;
    this.master = master;
    // A cache baked before the device rate was known can be at another rate, which would
    // play it at the wrong speed. Drop those voices and bake them again on this device.
    for (const [cue, buffer] of this.baked) {
      if (buffer.sampleRate !== context.sampleRate) this.baked.delete(cue);
    }
    return context;
  }

  private async bakeAll(sampleRate: number): Promise<void> {
    const batch = new Map<SoundCue, AudioBuffer>();
    for (const cue of Object.values(SOUND_CUE)) {
      if (this.baked.has(cue)) continue;
      const buffer = await this.bake(cue, sampleRate);
      if (buffer) batch.set(cue, buffer);
    }
    normalizeBatch(batch);
    for (const [cue, buffer] of batch) this.baked.set(cue, buffer);
  }

  /**
   * Renders one cue offline. The cue builders only touch the node factories and
   * `currentTime`, all of which `OfflineAudioContext` implements, so the same code path
   * produces the baked buffer and the live voice — a baked cue can never drift from the
   * one played before pre-baking finished.
   */
  private async bake(cue: SoundCue, sampleRate: number): Promise<AudioBuffer | null> {
    const length = Math.max(1, Math.ceil(sampleRate * BAKE_SECONDS));
    const offline = this.offlineFactory?.(sampleRate, length) ?? null;
    if (!offline) return null;
    try {
      const bus = offline.createGain();
      bus.gain.value = 1;
      bus.connect(offline.destination);
      const context = offline as unknown as AudioContext;
      this.render(context, bus, cue, 0, 1);
      return await offline.startRendering();
    } catch {
      // A platform that cannot render this cue offline keeps the live path for it.
      return null;
    }
  }

  /**
   * The casino jackpot chime: a cascade of metallic bell strikes, each with a shower of coin
   * clatter. A regular jackpot rings six strikes (about 0.5s); golden (7-7-7) rings twelve over
   * two octaves with a sparkling tail (about 1.2s). Synthesized live: jackpots are rare, so it
   * is not worth a baked buffer.
   */
  playJackpotBellFanfare(isGolden: boolean): void {
    if (this.mutedState) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    if (context.state === 'suspended') {
      void context.resume().catch(() => {});
      return;
    }
    const at = context.currentTime + 0.005;
    this.makeRoom();
    const bus = context.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);

    const strikes = isGolden ? BELL_STRIKES_GOLDEN : BELL_STRIKES_REGULAR;
    strikes.forEach((hz, index) => {
      const strikeAt = at + index * BELL_SPACING_S;
      const ratio = hz / BELL_REFERENCE_HZ;
      for (const partial of BELL_PARTIALS) {
        this.sweep(context, bus, {
          type: 'sine',
          from: partial.hz * ratio,
          at: strikeAt,
          duration: BELL_DECAY_S,
          peak: partial.peak,
          attack: 0.002,
        });
      }
      this.burst(context, bus, {
        at: strikeAt,
        duration: 0.03,
        peak: 0.12,
        attack: 0.001,
        filter: { type: 'highpass', frequency: 8000 },
      });
    });

    let length = (strikes.length - 1) * BELL_SPACING_S + BELL_DECAY_S;
    if (isGolden) {
      // The coin fountain keeps falling after the last golden strike.
      this.burst(context, bus, {
        at: at + 0.3,
        duration: 0.8,
        peak: 0.07,
        attack: 0.05,
        filter: { type: 'highpass', frequency: 8000 },
      });
      length = 1.2;
    }
    this.voices.push({
      endsAt: at + length,
      stop: () => {
        try {
          bus.disconnect();
        } catch {
          // Already detached.
        }
      },
    });
  }

  /** Drops finished voices, then steals the oldest until there is room for one more. */
  private makeRoom(): void {
    const now = this.context?.currentTime ?? 0;
    for (let index = this.voices.length - 1; index >= 0; index -= 1) {
      const voice = this.voices[index];
      if (voice && voice.endsAt <= now) this.voices.splice(index, 1);
    }
    while (this.voices.length >= SFX_MAX_VOICES) this.voices.shift()?.stop();
  }

  /** Zero-latency path: the whole cue is one buffer, scaled by `intensity`. */
  private playBaked(context: AudioContext, buffer: AudioBuffer, at: number, intensity: number): void {
    if (!this.master) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.setValueAtTime(intensity, at);
    source.connect(gain);
    gain.connect(this.master);
    source.start(at);
    source.stop(at + buffer.duration);
    releaseOnEnd(source);
    this.voices.push({
      endsAt: at + buffer.duration,
      stop: () => {
        // Stopping the source is the whole voice: the gain it feeds is its own node.
        try {
          source.stop();
        } catch {
          // Already stopped; nothing to do.
        }
        try {
          gain.disconnect();
        } catch {
          // Already detached.
        }
      },
    });
  }

  /**
   * Synthesis fallback for a cue that is not baked yet (or a platform without an offline
   * context). The cue gets its own bus, so stealing it is a single disconnect even though
   * it is built from a dozen oscillators.
   */
  private playLive(context: AudioContext, cue: SoundCue, at: number, intensity: number): void {
    if (!this.master) return;
    const bus = context.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);
    this.render(context, bus, cue, at, intensity);
    this.voices.push({
      endsAt: at + BAKE_SECONDS,
      stop: () => {
        try {
          bus.disconnect();
        } catch {
          // Already detached.
        }
      },
    });
  }

  private noise(context: AudioContext): AudioBuffer {
    if (this.noiseBed) return this.noiseBed;
    const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SECONDS));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this.noiseBed = buffer;
    return buffer;
  }

  /**
   * A gain node with a click-free envelope: near-silence, up to `peak`, then back down.
   * Exponential ramps are used because linear ones sound like a switch being thrown.
   */
  private envelope(context: AudioContext, at: number, duration: number, peak: number, attack = 0.008): GainNode {
    const rise = Math.min(Math.max(attack, 0.001), duration * 0.6);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + rise);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    return gain;
  }

  /** One oscillator sweeping from `from` to `to`, shaped by `envelope`. */
  private sweep(
    context: AudioContext,
    out: AudioNode,
    options: {
      readonly type: OscillatorType;
      readonly from: number;
      readonly to?: number;
      readonly at: number;
      readonly duration: number;
      readonly peak: number;
      readonly attack?: number;
      readonly filter?: { readonly type: BiquadFilterType; readonly frequency: number; readonly q?: number };
    },
  ): OscillatorNode {
    const osc = context.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(Math.max(options.from, 1), options.at);
    if (options.to !== undefined && options.to !== options.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(options.to, 1), options.at + options.duration);
    }
    const gain = this.envelope(context, options.at, options.duration, options.peak, options.attack);

    let tail: AudioNode = osc;
    if (options.filter) {
      const filter = context.createBiquadFilter();
      filter.type = options.filter.type;
      filter.frequency.value = options.filter.frequency;
      if (options.filter.q !== undefined) filter.Q.value = options.filter.q;
      tail.connect(filter);
      tail = filter;
    }
    tail.connect(gain);
    gain.connect(out);
    osc.start(options.at);
    osc.stop(options.at + options.duration + 0.02);
    releaseOnEnd(osc);
    return osc;
  }

  /** A short burst of filtered noise: paper, sparks, claps and thuds. */
  private burst(
    context: AudioContext,
    out: AudioNode,
    options: {
      readonly at: number;
      readonly duration: number;
      readonly peak: number;
      readonly attack?: number;
      readonly filter: { readonly type: BiquadFilterType; readonly frequency: number; readonly q?: number };
      readonly sweepTo?: number;
      readonly curve?: Float32Array<ArrayBuffer>;
    },
  ): void {
    const source = context.createBufferSource();
    source.buffer = this.noise(context);
    const filter = context.createBiquadFilter();
    filter.type = options.filter.type;
    filter.frequency.setValueAtTime(options.filter.frequency, options.at);
    if (options.sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(options.sweepTo, 20), options.at + options.duration);
    }
    if (options.filter.q !== undefined) filter.Q.value = options.filter.q;
    const gain = this.envelope(context, options.at, options.duration, options.peak, options.attack);

    let tail: AudioNode = source;
    if (options.curve) {
      const shaper = context.createWaveShaper();
      shaper.curve = options.curve;
      shaper.oversample = '2x';
      tail.connect(shaper);
      tail = shaper;
    }
    tail.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    source.start(options.at);
    source.stop(options.at + options.duration + 0.02);
    releaseOnEnd(source);
  }

  private render(context: AudioContext, out: GainNode, cue: SoundCue, at: number, intensity: number): void {
    switch (cue) {
      case SOUND_CUE.CARD_FLIP:
        this.cardFlip(context, out, at);
        return;
      case SOUND_CUE.CARD_MATCH:
        this.cardMatch(context, out, at);
        return;
      case SOUND_CUE.MISMATCH:
        this.mismatch(context, out, at);
        return;
      case SOUND_CUE.BLACK_FLASH:
        this.blackFlash(context, out, at, intensity);
        return;
      case SOUND_CUE.BROTHERHOOD_SYNC:
        this.brotherhoodSync(context, out, at, intensity);
        return;
      case SOUND_CUE.BARRIER_HIT:
        this.barrierHit(context, out, at);
        return;
      case SOUND_CUE.SKILL_CAST:
        this.skillCast(context, out, at);
        return;
      case SOUND_CUE.CLEAVE:
        this.cleave(context, out, at);
        return;
      case SOUND_CUE.DOMAIN_EXPANSION:
        this.domainExpansion(context, out, at);
        return;
      case SOUND_CUE.TRAP_DETONATE:
        this.trapDetonate(context, out, at);
        return;
      case SOUND_CUE.COURTROOM_ENTER:
        this.courtroomEnter(context, out, at);
        return;
      case SOUND_CUE.GAVEL_STRIKE:
        this.gavelStrike(context, out, at);
        return;
      case SOUND_CUE.JUDGEMAN_BELL:
        this.judgemanBell(context, out, at);
        return;
      case SOUND_CUE.EXECUTIONER_SLASH:
        this.executionerSlash(context, out, at);
        return;
      case SOUND_CUE.AWAKENING_SURGE:
        this.awakeningSurge(context, out, at);
        return;
      case SOUND_CUE.BLESSING_CHOSEN:
        this.blessingChosen(context, out, at);
        return;
      case SOUND_CUE.TALISMAN_SEAL:
        this.talismanSealStamp(context, out, at);
        return;
      case SOUND_CUE.SEAL_ABSORBED:
        this.sealAbsorbed(context, out, at);
        return;
      case SOUND_CUE.DICE_ROLL:
        this.diceRoll(context, out, at);
        return;
      case SOUND_CUE.REEL_STOP:
        this.reelStop(context, out, at);
        return;
      case SOUND_CUE.CARD_HOVER:
        this.cardHover(context, out, at);
        return;
      case SOUND_CUE.EMBER_INSECT:
        this.emberInsect(context, out, at);
        return;
      case SOUND_CUE.CURSED_NAIL:
        this.cursedNail(context, out, at);
        return;
      case SOUND_CUE.SEALED_TALISMAN:
        this.sealedTalisman(context, out, at);
        return;
      case SOUND_CUE.TRANSFIGURED_FLESH:
        this.transfiguredFlesh(context, out, at);
        return;
      case SOUND_CUE.DIVERGENT_FIST:
        this.divergentFist(context, out, at);
        return;
      case SOUND_CUE.GAMBLE_START:
        this.gambleStart(context, out, at);
        return;
      case SOUND_CUE.PACHINKO_LEVER:
        this.pachinkoLever(context, out, at);
        return;
      case SOUND_CUE.MECHANICAL_LEVER_PULL:
        this.mechanicalLeverPull(context, out, at);
        return;
      case SOUND_CUE.PACHINKO_REEL_SPIN:
        this.pachinkoReelSpin(context, out, at);
        return;
      case SOUND_CUE.PACHINKO_REEL_STOP:
        this.pachinkoReelStop(context, out, at);
        return;
      case SOUND_CUE.JACKPOT_REGULAR:
        this.jackpotRegular(context, out, at);
        return;
      case SOUND_CUE.JACKPOT_GOLDEN:
        this.jackpotGolden(context, out, at);
        return;
      case SOUND_CUE.BANKRUPT_WHIFF:
        this.bankruptWhiff(context, out, at);
        return;
      default:
        return;
    }
  }

  /**
   * A warm, velvety paper flutter: brown noise (a Brownian walk, so it has no harsh white
   * treble) through a high-pass, a 650Hz body peak, and a strict low-pass that glides
   * downward as the card settles. The envelope is soft and quiet, with no slap or hiss.
   */
  private cardFlip(context: AudioContext, out: AudioNode, at: number): void {
    const duration = 0.17;
    const bufferSize = Math.floor(context.sampleRate * duration);
    const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
    const data = buffer.getChannelData(0);

    // Brown noise: integrate white noise with a leak, which removes the high-frequency hiss.
    let lastVal = 0;
    for (let i = 0; i < bufferSize; i += 1) {
      const white = Math.random() * 2 - 1;
      lastVal = (lastVal + 0.025 * white) / 1.025;
      data[i] = lastVal * 4;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;

    // Sub-bass "thud" is removed; the warm body is kept.
    const highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.setValueAtTime(180, at);

    // Cardstock body warmth around 650Hz.
    const peaking = context.createBiquadFilter();
    peaking.type = 'peaking';
    peaking.frequency.setValueAtTime(650, at);
    peaking.Q.setValueAtTime(1.5, at);
    peaking.gain.setValueAtTime(4, at);

    // Strict low-pass: the treble stays out, and the cutoff glides down as the card settles.
    const lowPass = context.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.setValueAtTime(1_300, at);
    lowPass.frequency.exponentialRampToValueAtTime(650, at + duration);

    // A soft 18ms ease-in, then a velvety exponential decay. Exponential ramps keep the
    // gain positive throughout, as the envelope helpers do elsewhere.
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(0.22, at + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    source.connect(highPass);
    highPass.connect(peaking);
    peaking.connect(lowPass);
    lowPass.connect(gain);
    gain.connect(out);
    source.start(at);
    source.stop(at + duration + 0.01);
    releaseOnEnd(source);
  }

  /**
   * A slot reel's pawl dropping into a notch: one short, hard band-passed click with a
   * quick downward sweep, so it reads as metal rather than a tone.
   */
  private reelStop(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.035,
      peak: 0.4,
      attack: 0.002,
      filter: { type: 'bandpass', frequency: 1_900, q: 2.2 },
      sweepTo: 1_100,
    });
  }

  /**
   * A handful of dice: four dry rattles accelerating as they tumble, then the small
   * wooden knock of the last one settling. Used by the setup screen's chaos roll.
   */
  private diceRoll(context: AudioContext, out: AudioNode, at: number): void {
    const rattles = [
      { delay: 0, hz: 1_180, peak: 0.24 },
      { delay: 0.075, hz: 980, peak: 0.2 },
      { delay: 0.14, hz: 1_360, peak: 0.18 },
      { delay: 0.2, hz: 820, peak: 0.15 },
    ];
    for (const rattle of rattles) {
      this.burst(context, out, {
        at: at + rattle.delay,
        duration: 0.05,
        peak: rattle.peak,
        attack: 0.002,
        filter: { type: 'bandpass', frequency: rattle.hz, q: 1.6 },
        sweepTo: rattle.hz * 0.62,
      });
    }
    this.sweep(context, out, {
      type: 'triangle',
      from: 210,
      to: 92,
      at: at + 0.26,
      duration: 0.11,
      peak: 0.2,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 760 },
    });
  }

  /** Bright ascending two-tone chime, with a quiet octave shimmer. */
  /** A rising three-note chord: the board is cleared and the blessing is due. */
  private awakeningSurge(context: AudioContext, out: AudioNode, at: number): void {
    const notes = [
      { hz: 523.25, at, duration: 0.42, peak: 0.09 },
      { hz: 783.99, at: at + 0.1, duration: 0.42, peak: 0.1 },
      { hz: 1046.5, at: at + 0.2, duration: 0.6, peak: 0.12 },
    ];
    for (const note of notes) {
      const gain = this.envelope(context, note.at, note.duration, note.peak, 0.02);
      gain.connect(out);
      const tone = context.createOscillator();
      tone.type = 'sine';
      tone.frequency.value = note.hz;
      tone.connect(gain);
      tone.start(note.at);
      tone.stop(note.at + note.duration + 0.02);
      releaseOnEnd(tone);
    }
  }

  /**
   * The talisman landing on a condemned card: a wooden slap with a hard panel crack, then a
   * low resonant ring that outlasts it. One per stamped card, so it must read on its own.
   */
  private talismanSealStamp(context: AudioContext, out: AudioNode, at: number): void {
    // The slap: a wide band of noise over a wooden body.
    this.burst(context, out, {
      at,
      duration: 0.045,
      peak: 0.26,
      attack: 0.001,
      filter: { type: 'bandpass', frequency: 1_100, q: 0.7 },
      sweepTo: 320,
    });
    this.sweep(context, out, {
      type: 'triangle',
      from: 260,
      to: 96,
      at,
      duration: 0.13,
      peak: 0.24,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 900 },
    });
    // The sub-bass ring the seal leaves behind.
    this.sweep(context, out, {
      type: 'sine',
      from: 68,
      to: 41,
      at: at + 0.01,
      duration: 0.62,
      peak: 0.3,
      attack: 0.012,
      filter: { type: 'lowpass', frequency: 220 },
    });
  }

  /** A short, settled two-note chime: the blessing has been taken. */
  private blessingChosen(context: AudioContext, out: AudioNode, at: number): void {
    const notes = [
      { hz: 1174.66, at, duration: 0.2, peak: 0.1 },
      { hz: 1567.98, at: at + 0.07, duration: 0.32, peak: 0.1 },
    ];
    for (const note of notes) {
      const gain = this.envelope(context, note.at, note.duration, note.peak, 0.005);
      gain.connect(out);
      const tone = context.createOscillator();
      tone.type = 'triangle';
      tone.frequency.value = note.hz;
      tone.connect(gain);
      tone.start(note.at);
      tone.stop(note.at + note.duration + 0.02);
      releaseOnEnd(tone);
    }
  }

  private cardMatch(context: AudioContext, out: AudioNode, at: number): void {
    const notes = [
      { hz: 880, at, duration: 0.26, peak: 0.1 },
      { hz: 1318.5, at: at + 0.085, duration: 0.38, peak: 0.12 },
    ];
    for (const note of notes) {
      const gain = this.envelope(context, note.at, note.duration, note.peak, 0.006);
      gain.connect(out);

      const tone = context.createOscillator();
      tone.type = 'sine';
      tone.frequency.value = note.hz;
      tone.connect(gain);
      tone.start(note.at);
      tone.stop(note.at + note.duration + 0.02);
      releaseOnEnd(tone);

      const shimmer = context.createOscillator();
      shimmer.type = 'triangle';
      shimmer.frequency.value = note.hz * 2.01;
      const shimmerGain = context.createGain();
      shimmerGain.gain.value = 0.16;
      shimmer.connect(shimmerGain);
      shimmerGain.connect(gain);
      shimmer.start(note.at);
      shimmer.stop(note.at + note.duration + 0.02);
      releaseOnEnd(shimmer);
    }
  }

  /** Muted low-frequency thud: the sound of a pair that was not there. */
  private mismatch(context: AudioContext, out: AudioNode, at: number): void {
    this.sweep(context, out, {
      type: 'sine',
      from: 150,
      to: 58,
      at,
      duration: 0.22,
      peak: 0.2,
      attack: 0.004,
      filter: { type: 'lowpass', frequency: 420 },
    });
    this.burst(context, out, {
      at,
      duration: 0.09,
      peak: 0.05,
      filter: { type: 'lowpass', frequency: 320 },
    });
  }

  /**
   * The Black Flash: a spatial implosion, a lightning crackle and an iron ring that trails it.
   * `intensity` (0-1) scales the whole voice.
   */
  private blackFlash(context: AudioContext, out: AudioNode, at: number, intensity: number): void {
    const level = Math.min(Math.max(intensity, 0), 1);

    // Layer A: the implosion. A sine dropping 160Hz to 28Hz, soft-clipped for physical bite.
    const body = context.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(160, at);
    body.frequency.exponentialRampToValueAtTime(28, at + 0.22);
    const clip = context.createWaveShaper();
    clip.curve = distortionCurve(2.5);
    clip.oversample = '2x';
    const bodyGain = this.envelope(context, at, 0.26, 0.9 * level, 0.003);
    body.connect(clip);
    clip.connect(bodyGain);
    bodyGain.connect(out);
    body.start(at);
    body.stop(at + 0.28);
    releaseOnEnd(body);

    // Layer B: the arc. Bandpassed noise (2.4kHz, Q 3.5) chopped by random gain steps every 8ms.
    const crackle = context.createBufferSource();
    crackle.buffer = this.noise(context);
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400;
    band.Q.value = 3.5;
    const chopper = context.createGain();
    for (let t = 0; t < 0.18; t += 0.008) {
      chopper.gain.setValueAtTime(0.25 + Math.random() * 0.75, at + t);
    }
    const crackleGain = this.envelope(context, at, 0.18, 0.75 * level, 0.001);
    crackle.connect(band);
    band.connect(chopper);
    chopper.connect(crackleGain);
    crackleGain.connect(out);
    crackle.start(at);
    crackle.stop(at + 0.2);
    releaseOnEnd(crackle);

    // Layer C: the iron ring, a high tone that rings out after the thunder.
    this.sweep(context, out, { type: 'sine', from: 840, at: at + 0.02, duration: 0.4, peak: 0.09 * level, attack: 0.004 });
  }

  /**
   * Brotherhood Sync: two rapid claps (the two fighters meeting), then the Black Flash thunder
   * snapping in right after.
   */
  private brotherhoodSync(context: AudioContext, out: AudioNode, at: number, intensity: number): void {
    const level = Math.min(Math.max(intensity, 0), 1);
    for (const [offset, peak] of [
      [0, 0.3],
      [0.045, 0.22],
    ] as const) {
      this.burst(context, out, {
        at: at + offset,
        duration: 0.03,
        peak: peak * level,
        attack: 0.001,
        filter: { type: 'bandpass', frequency: 1600, q: 1.2 },
      });
    }
    this.blackFlash(context, out, at + 0.09, intensity);
  }

  /** Low wooden knock followed by a rising tribunal tone: the court is in session. */
  private courtroomEnter(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.12,
      peak: 0.22,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 500 },
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 220,
      to: 330,
      at: at + 0.18,
      duration: 0.5,
      peak: 0.09,
      attack: 0.06,
      filter: { type: 'lowpass', frequency: 1400 },
    });
  }

  /**
   * The judge's gavel: two band-passed transients (an 800Hz crack and a 320Hz body) with a
   * 5ms attack, over a 55Hz sine drop that rings out for 900ms.
   */
  private gavelStrike(context: AudioContext, out: AudioNode, at: number): void {
    for (const frequency of [800, 320]) {
      const source = context.createBufferSource();
      source.buffer = this.noise(context);
      const band = context.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = frequency;
      band.Q.value = 1.4;
      const strike = this.envelope(context, at, 0.04, 0.3, 0.005);
      source.connect(band);
      band.connect(strike);
      strike.connect(out);
      source.start(at);
      source.stop(at + 0.05);
      releaseOnEnd(source);
    }
    this.sweep(context, out, {
      type: 'sine',
      from: 55,
      to: 55,
      at,
      duration: 0.9,
      peak: 0.5,
      attack: 0.005,
    });
  }

  /** A clear temple bell: a struck fundamental with a quieter, higher partial that rings on. */
  private judgemanBell(context: AudioContext, out: AudioNode, at: number): void {
    this.sweep(context, out, {
      type: 'sine',
      from: 660,
      to: 660,
      at,
      duration: 1.4,
      peak: 0.2,
      attack: 0.004,
      filter: { type: 'lowpass', frequency: 4000 },
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 1760,
      to: 1760,
      at,
      duration: 0.9,
      peak: 0.06,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 6000 },
    });
  }

  /** Whistling blade sweep that ends on a thin metallic ring. */
  private executionerSlash(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.28,
      peak: 0.12,
      attack: 0.02,
      filter: { type: 'bandpass', frequency: 1200, q: 1.4 },
      sweepTo: 4000,
    });
    this.sweep(context, out, {
      type: 'sawtooth',
      from: 900,
      to: 180,
      at,
      duration: 0.3,
      peak: 0.06,
      attack: 0.01,
      filter: { type: 'lowpass', frequency: 2200 },
    });
    const ring = this.envelope(context, at + 0.28, 0.45, 0.05, 0.003);
    ring.connect(out);
    const tone = context.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = 2637;
    tone.connect(ring);
    tone.start(at + 0.28);
    tone.stop(at + 0.75);
    releaseOnEnd(tone);
  }

  /** Crystal ring: a stack of high partials over a short noise sparkle. */
  private barrierHit(context: AudioContext, out: AudioNode, at: number): void {
    const partials = [2093, 2793, 3520, 4699];
    partials.forEach((hz, index) => {
      const duration = 0.5 - index * 0.07;
      const gain = this.envelope(context, at, duration, 0.055, 0.002);
      gain.connect(out);
      const ring = context.createOscillator();
      ring.type = 'sine';
      ring.frequency.value = hz * (1 + index * 0.002);
      const band = context.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = hz;
      band.Q.value = 4;
      ring.connect(band);
      band.connect(gain);
      ring.start(at);
      ring.stop(at + duration + 0.02);
      releaseOnEnd(ring);
    });
    this.burst(context, out, {
      at,
      duration: 0.08,
      peak: 0.06,
      attack: 0.001,
      filter: { type: 'highpass', frequency: 4200 },
    });
  }

  /**
   * Cleave: a heavy katana bite. A band-swept air split opens into a broad metal ring,
   * while a distorted low saw supplies the weight of the cut landing.
   */
  private cleave(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.17,
      peak: 0.4,
      attack: 0.002,
      filter: { type: 'bandpass', frequency: 680, q: 0.9 },
      sweepTo: 5_200,
    });
    this.burst(context, out, {
      at: at + 0.01,
      duration: 0.32,
      peak: 0.2,
      attack: 0.001,
      filter: { type: 'highpass', frequency: 2_600 },
      sweepTo: 4_600,
    });
    this.sweep(context, out, {
      type: 'sawtooth',
      from: 240,
      to: 52,
      at,
      duration: 0.34,
      peak: 0.34,
      attack: 0.001,
      filter: { type: 'lowpass', frequency: 1_100, q: 1.4 },
    });
    this.sweep(context, out, {
      type: 'triangle',
      from: 2_400,
      to: 720,
      at: at + 0.02,
      duration: 0.22,
      peak: 0.12,
      attack: 0.001,
      filter: { type: 'bandpass', frequency: 3_100, q: 3.2 },
    });
  }

  /**
   * Jogo consumes a seal: a roaring filtered-noise ignition that falls away into a low
   * volcanic sweep, so it reads as fire eating the talisman rather than an explosion.
   */
  private sealAbsorbed(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.42,
      peak: 0.4,
      attack: 0.004,
      filter: { type: 'lowpass', frequency: 1_600, q: 0.7 },
      sweepTo: 170,
    });
    this.burst(context, out, {
      at: at + 0.015,
      duration: 0.24,
      peak: 0.22,
      attack: 0.003,
      filter: { type: 'bandpass', frequency: 620, q: 0.9 },
      sweepTo: 2_400,
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 120,
      to: 36,
      at,
      duration: 0.38,
      peak: 0.32,
      attack: 0.004,
      filter: { type: 'lowpass', frequency: 240 },
    });
  }

  /** Cursed-energy sweep: a saw through a moving band-pass, plus an electric crackle. */
  private skillCast(context: AudioContext, out: AudioNode, at: number): void {
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, at);
    osc.frequency.exponentialRampToValueAtTime(1400, at + 0.18);
    osc.frequency.exponentialRampToValueAtTime(340, at + 0.46);

    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 6;
    band.frequency.setValueAtTime(320, at);
    band.frequency.exponentialRampToValueAtTime(2600, at + 0.18);
    band.frequency.exponentialRampToValueAtTime(520, at + 0.46);

    const gain = this.envelope(context, at, 0.5, 0.1, 0.02);
    osc.connect(band);
    band.connect(gain);
    gain.connect(out);
    osc.start(at);
    osc.stop(at + 0.52);
    releaseOnEnd(osc);

    this.sweep(context, out, {
      type: 'square',
      from: 96,
      to: 72,
      at,
      duration: 0.42,
      peak: 0.03,
      attack: 0.01,
      filter: { type: 'highpass', frequency: 780 },
    });
  }

  /** Ominous drone that opens into an echoing spatial resonance. */
  private domainExpansion(context: AudioContext, out: AudioNode, at: number): void {
    const bus = context.createGain();
    bus.gain.value = 1;
    bus.connect(out);

    // Long feedback echo: the room the domain has just replaced.
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.26;
    const feedback = context.createGain();
    feedback.gain.value = 0.42;
    const wet = context.createGain();
    wet.gain.value = 0.3;
    bus.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(out);

    const droneGain = this.envelope(context, at, 1.9, 0.17, 0.22);
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.Q.value = 3;
    lowpass.frequency.setValueAtTime(180, at);
    lowpass.frequency.exponentialRampToValueAtTime(900, at + 0.9);
    lowpass.frequency.exponentialRampToValueAtTime(240, at + 1.9);
    lowpass.connect(droneGain);
    droneGain.connect(bus);

    for (const hz of [55, 55.6]) {
      const osc = context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(hz, at);
      osc.frequency.linearRampToValueAtTime(hz * 1.06, at + 1.6);
      const trim = context.createGain();
      trim.gain.value = 0.5;
      osc.connect(trim);
      trim.connect(lowpass);
      osc.start(at);
      osc.stop(at + 1.95);
      releaseOnEnd(osc);
    }

    this.sweep(context, bus, {
      type: 'sine',
      from: 34,
      to: 28,
      at,
      duration: 2,
      peak: 0.16,
      attack: 0.3,
    });
  }

  /** Spark and nail snap: a sharp transient over a small low thump. */
  private trapDetonate(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.055,
      peak: 0.28,
      attack: 0.001,
      filter: { type: 'highpass', frequency: 2400 },
    });
    this.sweep(context, out, {
      type: 'triangle',
      from: 2100,
      to: 1500,
      at,
      duration: 0.07,
      peak: 0.07,
      attack: 0.001,
      filter: { type: 'bandpass', frequency: 2400, q: 6 },
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 100,
      to: 44,
      at,
      duration: 0.18,
      peak: 0.22,
      attack: 0.003,
      filter: { type: 'lowpass', frequency: 260 },
    });
  }

  /** A quiet paper tick under the pointer. Kept far below a flip so hovering never nags. */
  private cardHover(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.02,
      peak: 0.05,
      attack: 0.001,
      filter: { type: 'highpass', frequency: 5000 },
    });
  }

  /* ---- Trap cues: every one is written to end well inside the two-second trap budget. ---- */

  /** Ember insect: a fast 450Hz flutter that dissolves into a gritty low magma burst. */
  private emberInsect(context: AudioContext, out: AudioNode, at: number): void {
    this.sweep(context, out, {
      type: 'sawtooth',
      from: 450,
      to: 380,
      at,
      duration: 0.3,
      peak: 0.07,
      attack: 0.01,
      filter: { type: 'bandpass', frequency: 900, q: 1.2 },
    });
    this.sweep(context, out, {
      type: 'square',
      from: 80,
      to: 60,
      at: at + 0.3,
      duration: 0.7,
      peak: 0.22,
      attack: 0.01,
      filter: { type: 'lowpass', frequency: 500, q: 2 },
    });
    this.burst(context, out, {
      at: at + 0.3,
      duration: 0.35,
      peak: 0.15,
      attack: 0.005,
      filter: { type: 'lowpass', frequency: 900 },
      sweepTo: 180,
    });
  }

  /** Cursed nail: an inharmonic iron impact, then a resonant ring that rings out. */
  private cursedNail(context: AudioContext, out: AudioNode, at: number): void {
    // Sub-bass thump under the impact, so the nail lands with weight.
    this.sweep(context, out, {
      type: 'sine',
      from: 90,
      to: 45,
      at,
      duration: 0.18,
      peak: 0.3,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 300 },
    });
    for (const frequency of [2100, 3400, 5200]) {
      this.sweep(context, out, {
        type: 'sine',
        from: frequency,
        at,
        duration: 0.12,
        peak: 0.12,
        attack: 0.001,
        filter: { type: 'highpass', frequency: 1500 },
      });
    }
    this.burst(context, out, {
      at,
      duration: 0.9,
      peak: 0.05,
      attack: 0.05,
      filter: { type: 'bandpass', frequency: 1800, q: 8 },
    });
  }

  /** Sealed talisman: a paper rustle, then a heavy sub-bass cursed pulse dropping 90Hz to 30Hz. */
  private sealedTalisman(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.2,
      peak: 0.12,
      attack: 0.03,
      filter: { type: 'bandpass', frequency: 3000, q: 0.7 },
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 90,
      to: 30,
      at: at + 0.2,
      duration: 0.9,
      peak: 0.35,
      attack: 0.01,
      filter: { type: 'lowpass', frequency: 200 },
    });
  }

  /** Transfigured flesh: a 300Hz saw whose pitch wobbles at 28Hz, with a wet squelch on top. */
  private transfiguredFlesh(context: AudioContext, out: AudioNode, at: number): void {
    const carrier = context.createOscillator();
    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(300, at);
    const lfo = context.createOscillator();
    lfo.frequency.value = 28;
    const depth = context.createGain();
    depth.gain.value = 60;
    lfo.connect(depth);
    depth.connect(carrier.frequency);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = this.envelope(context, at, 0.8, 0.16, 0.02);
    carrier.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    carrier.start(at);
    lfo.start(at);
    carrier.stop(at + 0.82);
    lfo.stop(at + 0.82);
    releaseOnEnd(carrier);
    releaseOnEnd(lfo);
    this.burst(context, out, {
      at: at + 0.1,
      duration: 0.25,
      peak: 0.2,
      attack: 0.01,
      filter: { type: 'bandpass', frequency: 500, q: 1.5 },
      sweepTo: 180,
    });
  }

  /** Divergent Fist: a blunt 120Hz punch, then the delayed 55Hz cursed boom 100ms later. */
  private divergentFist(context: AudioContext, out: AudioNode, at: number): void {
    this.sweep(context, out, {
      type: 'sine',
      from: 120,
      to: 60,
      at,
      duration: 0.12,
      peak: 0.52,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 600 },
    });
    this.burst(context, out, {
      at,
      duration: 0.06,
      peak: 0.2,
      attack: 0.001,
      filter: { type: 'lowpass', frequency: 900 },
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 55,
      to: 40,
      at: at + 0.1,
      duration: 0.45,
      peak: 0.6,
      attack: 0.005,
      filter: { type: 'lowpass', frequency: 200 },
    });
  }

  /** Idle Death Gamble opening: a dice rattle that accelerates, then a high metallic tick. */
  private gambleStart(context: AudioContext, out: AudioNode, at: number): void {
    for (let i = 0; i < 6; i += 1) {
      this.burst(context, out, {
        at: at + i * (0.05 - i * 0.005),
        duration: 0.02,
        peak: 0.25,
        attack: 0.001,
        filter: { type: 'bandpass', frequency: 2500, q: 4 },
      });
    }
    this.sweep(context, out, {
      type: 'triangle',
      from: 3200,
      to: 2800,
      at: at + 0.3,
      duration: 0.2,
      peak: 0.1,
      attack: 0.001,
      filter: { type: 'highpass', frequency: 1800 },
    });
  }

  /** Pachinko lever: a heavy arcade clack on the way down, a second clack as it returns. */
  private pachinkoLever(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.04,
      peak: 0.5,
      attack: 0.002,
      filter: { type: 'bandpass', frequency: 1400, q: 2 },
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 180,
      to: 90,
      at,
      duration: 0.1,
      peak: 0.25,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 600 },
    });
    this.burst(context, out, {
      at: at + 0.08,
      duration: 0.08,
      peak: 0.35,
      attack: 0.002,
      filter: { type: 'bandpass', frequency: 900, q: 2 },
      sweepTo: 500,
    });
  }

  /** Side lever: two short bright metal ticks, the pawl catching the ratchet teeth. */
  private mechanicalLeverPull(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.02,
      peak: 0.4,
      attack: 0.001,
      filter: { type: 'bandpass', frequency: 2600, q: 3 },
    });
    this.burst(context, out, {
      at: at + 0.035,
      duration: 0.03,
      peak: 0.3,
      attack: 0.001,
      filter: { type: 'bandpass', frequency: 1900, q: 3 },
      sweepTo: 1200,
    });
  }

  /** Reels turning: twenty ratchet clicks over 0.9s, bunched in a rhythmic gear pattern. */
  private pachinkoReelSpin(context: AudioContext, out: AudioNode, at: number): void {
    for (let i = 0; i < 20; i += 1) {
      this.burst(context, out, {
        at: at + i * 0.045,
        duration: 0.012,
        peak: 0.12,
        attack: 0.001,
        filter: { type: 'highpass', frequency: 2000 + (i % 3) * 400 },
      });
    }
  }

  /** A reel locking: a low THUNK with a short metallic spring ringing on top. */
  private pachinkoReelStop(context: AudioContext, out: AudioNode, at: number): void {
    this.sweep(context, out, {
      type: 'sine',
      from: 110,
      to: 55,
      at,
      duration: 0.14,
      peak: 0.45,
      attack: 0.002,
      filter: { type: 'lowpass', frequency: 300 },
    });
    this.burst(context, out, {
      at,
      duration: 0.03,
      peak: 0.3,
      attack: 0.002,
      filter: { type: 'bandpass', frequency: 1900, q: 2 },
    });
    this.sweep(context, out, {
      type: 'sine',
      from: 1400,
      to: 1300,
      at: at + 0.01,
      duration: 0.25,
      peak: 0.05,
      attack: 0.002,
      filter: { type: 'highpass', frequency: 900 },
    });
  }

  /** Regular jackpot: a cascade of casino bells up a major arpeggio, with coins shimmering through it. */
  private jackpotRegular(context: AudioContext, out: AudioNode, at: number): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, i) => {
      this.sweep(context, out, {
        type: 'sine',
        from: frequency,
        at: at + i * 0.09,
        duration: 0.5,
        peak: 0.2,
        attack: 0.003,
      });
    });
    for (let i = 0; i < 8; i += 1) {
      this.burst(context, out, {
        at: at + 0.1 + i * 0.12,
        duration: 0.05,
        peak: 0.1,
        attack: 0.002,
        filter: { type: 'highpass', frequency: 6000 },
      });
    }
  }

  /** Golden or 7-7-7: a chord progression, a rising siren pulse and a coin fountain. */
  private jackpotGolden(context: AudioContext, out: AudioNode, at: number): void {
    const chords = [
      [261.63, 329.63, 392.0],
      [349.23, 440.0, 523.25],
      [392.0, 493.88, 587.33],
      [523.25, 659.25, 783.99],
    ];
    chords.forEach((chord, step) => {
      for (const frequency of chord) {
        this.sweep(context, out, {
          type: 'triangle',
          from: frequency,
          at: at + step * 0.35,
          duration: 0.4,
          peak: 0.1,
          attack: 0.01,
        });
      }
    });
    this.sweep(context, out, {
      type: 'sawtooth',
      from: 600,
      to: 1200,
      at,
      duration: 0.6,
      peak: 0.05,
      attack: 0.02,
      filter: { type: 'lowpass', frequency: 2000 },
    });
    this.sweep(context, out, {
      type: 'sawtooth',
      from: 1200,
      to: 600,
      at: at + 0.6,
      duration: 0.6,
      peak: 0.05,
      attack: 0.02,
      filter: { type: 'lowpass', frequency: 2000 },
    });
    for (let i = 0; i < 14; i += 1) {
      this.burst(context, out, {
        at: at + 0.2 + i * 0.1,
        duration: 0.05,
        peak: 0.1,
        attack: 0.002,
        filter: { type: 'highpass', frequency: 5000 },
      });
    }
  }

  /** Bankrupt: glass crunches apart, then a hollow buzzer sinks underneath it. */
  private bankruptWhiff(context: AudioContext, out: AudioNode, at: number): void {
    this.burst(context, out, {
      at,
      duration: 0.18,
      peak: 0.35,
      attack: 0.002,
      filter: { type: 'highpass', frequency: 3500, q: 0.7 },
    });
    this.burst(context, out, {
      at: at + 0.04,
      duration: 0.1,
      peak: 0.2,
      attack: 0.002,
      filter: { type: 'bandpass', frequency: 2600, q: 3 },
    });
    this.sweep(context, out, {
      type: 'sawtooth',
      from: 200,
      to: 120,
      at: at + 0.1,
      duration: 0.9,
      peak: 0.12,
      attack: 0.02,
      filter: { type: 'lowpass', frequency: 500 },
    });
  }
}

/** Process-wide engine; the mute preference it loads is the one the player chose last. */
export const sfx = new SfxEngine();

export function createSfxEngine(options: SfxEngineOptions = {}): SfxEngine {
  return new SfxEngine(options);
}

export function playSfx(cue: SoundCue): void {
  sfx.play(cue);
}

/** Jackpot bell fanfare: golden (7-7-7) rings the long version, others the short one. */
export function playJackpotBellFanfare(isGolden: boolean): void {
  sfx.playJackpotBellFanfare(isGolden);
}

export function playCardFlip(): void {
  sfx.play(SOUND_CUE.CARD_FLIP);
}

export function playCardMatch(): void {
  sfx.play(SOUND_CUE.CARD_MATCH);
}

export function playMismatch(): void {
  sfx.play(SOUND_CUE.MISMATCH);
}

/** The Black Flash thunder; `intensity` (0-1) scales its loudness. */
export function playBlackFlash(intensity = 1): void {
  sfx.play(SOUND_CUE.BLACK_FLASH, intensity);
}

export function playBarrierHit(): void {
  sfx.play(SOUND_CUE.BARRIER_HIT);
}

export function playSkillCast(): void {
  sfx.play(SOUND_CUE.SKILL_CAST);
}

export function playDomainExpansion(): void {
  sfx.play(SOUND_CUE.DOMAIN_EXPANSION);
}

export function playTrapDetonate(): void {
  sfx.play(SOUND_CUE.TRAP_DETONATE);
}

export function playCourtroomEnter(): void {
  sfx.play(SOUND_CUE.COURTROOM_ENTER);
}

export function playGavelStrike(): void {
  sfx.play(SOUND_CUE.GAVEL_STRIKE);
}

export function playExecutionerSlash(): void {
  sfx.play(SOUND_CUE.EXECUTIONER_SLASH);
}

/** One condemned card receiving the Judgeman's talisman. */
export function playTalismanSealStamp(): void {
  sfx.play(SOUND_CUE.TALISMAN_SEAL);
}

/** One slot reel locking onto its symbol. */
export function playReelStop(): void {
  sfx.play(SOUND_CUE.REEL_STOP);
}

export function playDiceRoll(): void {
  sfx.play(SOUND_CUE.DICE_ROLL);
}

/** Hovering a board card is deliberately silent; kept as a no-op so callers stay valid. */
export function playCardHover(): void {}

export function playEmberInsect(): void {
  sfx.play(SOUND_CUE.EMBER_INSECT);
}

export function playCursedNail(): void {
  sfx.play(SOUND_CUE.CURSED_NAIL);
}

export function playSealedTalisman(): void {
  sfx.play(SOUND_CUE.SEALED_TALISMAN);
}

export function playTransfiguredFlesh(): void {
  sfx.play(SOUND_CUE.TRANSFIGURED_FLESH);
}

/** Yuji's Divergent Fist: the punch and its delayed boom. */
export function playDivergentFist(): void {
  sfx.play(SOUND_CUE.DIVERGENT_FIST);
}

/** Hakari's Idle Death Gamble opening. */
export function playGambleStart(): void {
  sfx.play(SOUND_CUE.GAMBLE_START);
}

export function playPachinkoLever(): void {
  sfx.play(SOUND_CUE.PACHINKO_LEVER);
}

/** The side lever's crank: the two-tick mechanical ratchet. */
export function playMechanicalLeverPull(): void {
  sfx.play(SOUND_CUE.MECHANICAL_LEVER_PULL);
}

export function playPachinkoReelSpin(): void {
  sfx.play(SOUND_CUE.PACHINKO_REEL_SPIN);
}

export function playPachinkoReelStop(): void {
  sfx.play(SOUND_CUE.PACHINKO_REEL_STOP);
}

/** A won spin: the regular bell cascade, or the golden fanfare for golden and 7-7-7 jackpots. */
export function playJackpotFanfare(isGolden: boolean): void {
  sfx.play(isGolden ? SOUND_CUE.JACKPOT_GOLDEN : SOUND_CUE.JACKPOT_REGULAR);
}

export function playBankruptWhiff(): void {
  sfx.play(SOUND_CUE.BANKRUPT_WHIFF);
}

/** A matched pair: the ascending chime. */
export function playMatchSuccess(): void {
  sfx.play(SOUND_CUE.CARD_MATCH);
}

/** A failed pair: the low muffled drop. */
export function playMatchFail(): void {
  sfx.play(SOUND_CUE.MISMATCH);
}

/** Sukuna's Cleave: the razor slice. */
export function playSukunaCleave(): void {
  sfx.play(SOUND_CUE.CLEAVE);
}

/** Yuji's Divergent Fist: alias of `playDivergentFist`. */
export function playYujiDivergentFist(): void {
  sfx.play(SOUND_CUE.DIVERGENT_FIST);
}

/** Yuji's Black Flash: alias of `playBlackFlash`. */
export function playYujiBlackFlash(intensity = 1): void {
  sfx.play(SOUND_CUE.BLACK_FLASH, intensity);
}

/** Hakari's gamble opening: alias of `playGambleStart`. */
export function playHakariGambleStart(): void {
  sfx.play(SOUND_CUE.GAMBLE_START);
}
