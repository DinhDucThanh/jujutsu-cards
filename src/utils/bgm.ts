import {
  OST_TRACK,
  bgmSceneKey,
  bgmTrackFor,
  type BgmSceneInput,
  type OstTrack,
} from '../engine/bgm-tension.js';
import type { PublicMatchView } from '../engine/public-view.js';
import { SFX_STORAGE_KEY, type SfxStorage } from './sfx.js';
import { createMasterOutput } from './audio-master.js';

/**
 * Procedural multi-track music, synthesized on the fly so the game ships no audio files.
 *
 * Every track is a 16-step loop per bar, built from four voice families:
 *
 *  - **Drums** — a sub-kick with a pitch drop and click, a 1.2kHz noise snare with a 200Hz
 *    body, and 16th-note high-passed hats with accent velocities. Some tracks add a gavel
 *    thump, mechanical reel clicks or a once-a-second woodblock tick.
 *  - **Bass** — a sawtooth through a low-pass whose envelope opens on each note.
 *  - **Pads** — detuned triangle and saw chords through a slow filter sweep and a stereo chorus.
 *  - **Leads** — arpeggios, brass stabs, chimes, bells, the courtroom clock and a drone.
 *
 * Every pitched voice except the sub-drone and the low-HP tension layer runs through a
 * sidechain duck: on each kick the pads and bass drop by -4dB for about 110ms, which gives
 * the pumping groove.
 *
 * Which track the match deserves is a rule in `bgm-tension.ts`. This module only turns that
 * answer into a scheduled sound. The outgoing track fades out over 350ms while the incoming
 * one fades in over 450ms, so a tier change never pops. Nothing schedules until the player
 * has gestured at the page, because browsers refuse audio before a gesture, and a missing
 * context turns every method into a no-op. Sound must never be able to break a turn.
 */

/** Matches the SFX engine: one mute preference for everything the game plays. */
export const BGM_STORAGE_KEY = SFX_STORAGE_KEY;
/** Time for the incoming track to fade in. */
export const OST_FADE_IN_S = 0.45;
/** Time for the outgoing track to fade out. */
export const OST_FADE_OUT_S = 0.35;
/** How fast the other tracks are cut when the courtroom opens: the hard isolation fade. */
const COURT_ISOLATE_FADE_S = 0.12;
/** The sidechain duck: -4dB, held for about 110ms. */
export const DUCK_GAIN = 10 ** (-4 / 20);
export const DUCK_RELEASE_S = 0.11;

/**
 * The low-HP tension layer: a muffled "lub-dub" heartbeat over a dark sub-drone.
 *
 * Every pitch here lives below 80Hz on purpose. The cue this replaces swept a triangle
 * between 600Hz and 1kHz once per bar, which the ear reads as an ambulance siren: a
 * midrange oscillator climbing and falling in pitch. Tension does not come from a higher
 * pitch or a faster sweep, it comes from a slow body rhythm and a low bed of sound.
 */
export const LOW_HP_TENSION = {
  /** The primary thump: 55Hz, decaying over 120ms. */
  lubHz: 55,
  lubS: 0.12,
  /** The secondary thump: 48Hz, longer and quieter, a beat behind the first. */
  dubHz: 48,
  dubS: 0.16,
  /** The gap between the two halves of one heartbeat. */
  dubDelayS: 0.11,
  /** One heartbeat per second, independent of the track's tempo: a resting pulse. */
  beatS: 1,
  /** The sub-drone's centre pitch in Hz. */
  droneHz: 72,
  /** How far either side of the centre the drone drifts, so it breathes instead of humming. */
  droneDriftHz: 7.5,
  /** Drift rate in Hz: one slow breath every fourteen seconds or so. */
  droneDriftRate: 0.07,
  /** Low-pass cutoff over the drone, which keeps it felt rather than heard. */
  droneCutoffHz: 200,
  /** The drone's own level. Quiet enough to sit under the music and the heartbeat. */
  droneGain: 0.15,
  /** The layer's fade in and out. Leaving is never a cut. */
  fadeS: 0.4,
} as const;

/** The mix of one track. Patterns are 16 steps long, one bar per loop. */
export interface OstProfile {
  readonly tempo: number;
  readonly level: number;
  /** Pad or lead chord per bar. */
  readonly chords: readonly (readonly number[])[];
  /** Bass root per bar, in Hz. A zero root means the bass is silent. */
  readonly bassRoots: readonly number[];
  readonly kick: readonly number[];
  readonly snare: readonly number[];
  readonly hat: readonly number[];
  readonly bass: readonly number[];
  readonly stab: readonly number[];
  /** Arpeggio frequency per step; 0 is a rest. */
  readonly arp: readonly number[];
  readonly arpWave: OscillatorType;
  /** Pad chord level, 0 for no pad. */
  readonly pad: number;
  /** Seconds for the pad to swell in. Absent means the usual 0.12s. */
  readonly padAttack?: number;
  readonly chime: boolean;
  readonly bell: boolean;
  readonly clock: boolean;
  readonly crackle: boolean;
  /**
   * Adds the low-HP tension layer: a muffled lub-dub heartbeat over a dark sub-drone. It is
   * synthesized by {@link LOW_HP_TENSION}, not by the 16-step grid, because a pulse that
   * runs at its own tempo reads as a body under stress rather than as another drum.
   */
  readonly heartbeat: boolean;
  readonly drone: boolean;
  /** Waveform of the drone. Absent means a sine. */
  readonly droneWave?: OscillatorType;
  /** Fixed drone pitch in Hz. Absent means the drone follows the bar root at half pitch. */
  readonly droneHz?: number;
  /** Rate in Hz of a low-pass sweep on the drone. Absent means no sweep. */
  readonly droneSweep?: number;
  /** Continuous tape hiss under the whole track. */
  readonly hiss?: boolean;
  /** Clock tick on a fixed interval, whatever the tempo: the courtroom clock. */
  readonly tick?: boolean;
  /** Seconds between clock ticks. Absent means one per second. */
  readonly tickS?: number;
  /** Organ chord for the drone, lowest note first. The root is a sawtooth, the rest triangles. */
  readonly droneChord?: readonly number[];
  /** Centre of the chord drone's low-pass sweep in Hz. Absent means 350. */
  readonly droneCutoffHz?: number;
  /** How far the chord drone's sweep swings either side of its centre, in Hz. Absent means 70. */
  readonly droneSweepDepth?: number;
  /** Gavel thump per step, 0 is a rest. */
  readonly gavel?: readonly number[];
  /** Mechanical reel click per step, 0 is a rest. */
  readonly reel?: readonly number[];
  /** Adds a square-wave grit under each kick, so the downbeat sounds distorted. */
  readonly distortKick?: boolean;
}

/** 16-step grid: `x` is a full hit, `o` a ghost, anything else a rest. */
function grid(text: string): readonly number[] {
  return Array.from(text.padEnd(16, '.').slice(0, 16), (c) => (c === 'x' ? 1 : c === 'o' ? 0.4 : 0));
}

/** `count` notes rising by semitones from `hz`: a chromatic run for building tension. */
function chromatic(hz: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => hz * 2 ** (i / 12));
}

const SILENT = grid('');

export const OST_PROFILES: Readonly<Record<OstTrack, OstProfile>> = {
  /** Dark occult ambience: Dm, Bb, Gm, A pads with long swells, tape hiss, sine chimes and a sub-bass pulse. */
  MENU_THEME: {
    tempo: 92,
    level: 0.3,
    chords: [
      [146.83, 174.61, 220],
      [233.08, 293.66, 349.23],
      [196, 233.08, 293.66],
      [220, 277.18, 329.63],
    ],
    bassRoots: [73.42, 116.54, 98, 110],
    kick: grid('x.........o.....'),
    snare: SILENT,
    hat: SILENT,
    bass: grid('x.......o.......'),
    stab: SILENT,
    arp: SILENT,
    arpWave: 'sine',
    pad: 0.55,
    padAttack: 1.2,
    chime: true,
    bell: false,
    clock: false,
    crackle: true,
    heartbeat: false,
    drone: true,
    hiss: true,
  },
  /** Sorcery clash: a 4-on-the-floor kick, rolling hats and a dark sawtooth arpeggio. */
  BATTLE_THEME: {
    tempo: 128,
    level: 0.36,
    chords: [
      [164.81, 196, 246.94],
      [130.81, 164.81, 196],
      [196, 246.94, 293.66],
      [146.83, 185, 220],
    ],
    bassRoots: [82.41, 65.41, 98, 73.42],
    kick: grid('x...x...x...x...'),
    snare: grid('....x.......x...'),
    hat: grid('oxoxoxoxoxoxoxox'),
    bass: grid('x.x.x.x.x.x.x.x.'),
    stab: SILENT,
    arp: [329.63, 0, 392, 0, 493.88, 0, 392, 0, 329.63, 0, 392, 0, 493.88, 0, 587.33, 0],
    arpWave: 'sawtooth',
    pad: 0.3,
    chime: false,
    bell: false,
    clock: false,
    crackle: false,
    heartbeat: false,
    drone: false,
  },
  /** Survival pulse: a muffled heartbeat, a dark sub-drone and dissonant clusters. */
  LOW_HP_THEME: {
    tempo: 134,
    level: 0.42,
    chords: [
      [174.61, 207.65, 261.63],
      [138.59, 164.81, 207.65],
      [155.56, 185, 233.08],
      [123.47, 146.83, 174.61],
    ],
    bassRoots: [87.31, 69.3, 77.78, 61.74],
    // The heartbeat layer owns the pulse, so the kick only marks the bar.
    kick: grid('x.......x.......'),
    snare: grid('....x.......x...'),
    hat: grid('..o...o...o...o.'),
    bass: grid('x.......o.......'),
    stab: grid('x.......x.......'),
    arp: SILENT,
    arpWave: 'triangle',
    pad: 0.22,
    chime: false,
    bell: false,
    clock: false,
    crackle: false,
    heartbeat: true,
    drone: false,
  },
  /** Oppressive domain barrier: a 40Hz sawtooth sub-drone swept by a 0.5Hz filter, a distorted kick and tritone stabs. */
  DOMAIN_GENERIC_THEME: {
    tempo: 136,
    level: 0.4,
    chords: [
      [130.81, 185, 220],
      [103.83, 146.83, 174.61],
      [116.54, 164.81, 207.65],
      [98, 138.59, 164.81],
    ],
    bassRoots: [65.41, 51.91, 58.27, 49],
    kick: grid('x...x...x...x...'),
    snare: grid('..x..x..x..x..x.'),
    hat: grid('o..o..o..o..o..o'),
    bass: grid('x.......x.......'),
    stab: grid('..x.....x.......'),
    arp: [261.63, 0, 0, 277.18, 0, 0, 311.13, 0, 0, 0, 293.66, 0, 277.18, 0, 0, 0],
    arpWave: 'triangle',
    pad: 0.3,
    chime: false,
    bell: false,
    clock: false,
    crackle: false,
    heartbeat: false,
    drone: true,
    droneWave: 'sawtooth',
    droneHz: 40,
    droneSweep: 0.5,
    distortKick: true,
  },
  /**
   * Solemn sentencing at 74 BPM: a cold pocket-watch tick every beat over a low church-organ
   * drone (D2, A2, F3). The gavel strikes come from the sound cues, not from this track.
   */
  HIGURUMA_COURT_THEME: {
    tempo: 74,
    level: 0.32,
    chords: [[73.4, 110, 174.6]],
    bassRoots: [0],
    kick: SILENT,
    snare: SILENT,
    hat: SILENT,
    bass: SILENT,
    stab: SILENT,
    arp: SILENT,
    arpWave: 'sine',
    pad: 0,
    chime: false,
    bell: false,
    clock: false,
    crackle: false,
    heartbeat: false,
    drone: true,
    droneChord: [73.4, 110, 174.6],
    droneSweep: 0.06,
    droneCutoffHz: 350,
    droneSweepDepth: 70,
    tick: true,
    tickS: 60 / 74,
  },
  /** Casino slot anticipation: clockwork reel clicks, a rising chromatic arpeggio and a slow pulse of kick. */
  HAKARI_SPIN_THEME: {
    tempo: 130,
    level: 0.38,
    chords: [
      [196, 233.08, 293.66],
      [207.65, 261.63, 311.13],
      [220, 277.18, 329.63],
      [233.08, 293.66, 349.23],
    ],
    bassRoots: [98, 103.83, 110, 116.54],
    kick: grid('x.......x.......'),
    snare: SILENT,
    hat: grid('o.o.o.o.o.o.o.o.'),
    bass: grid('x.x.x.x.x.x.x.x.'),
    stab: grid('..x...x...x...x.'),
    arp: chromatic(392, 16),
    arpWave: 'sawtooth',
    pad: 0.2,
    chime: false,
    bell: false,
    clock: false,
    crackle: false,
    heartbeat: false,
    drone: false,
    reel: grid('xxxxxxxxxxxxxxxx'),
  },
  /** Bouncy arcade win: a punchy 4-on-the-floor, offbeat hats, a slap bassline and casino bells. */
  JACKPOT_REGULAR_THEME: {
    tempo: 138,
    level: 0.4,
    chords: [
      [261.63, 329.63, 392],
      [220, 261.63, 329.63],
      [174.61, 220, 261.63],
      [196, 246.94, 293.66],
    ],
    bassRoots: [65.41, 55, 87.31, 98],
    kick: grid('x...x...x...x...'),
    snare: grid('....x.......x...'),
    hat: grid('..x.o.x...x.o.x.'),
    bass: grid('x.o.x.o.x.o.x..o'),
    stab: grid('..x.....x.......'),
    arp: [523.25, 0, 659.25, 0, 783.99, 0, 659.25, 0, 1046.5, 0, 783.99, 0, 659.25, 0, 523.25, 0],
    arpWave: 'triangle',
    pad: 0.2,
    chime: false,
    bell: true,
    clock: false,
    crackle: false,
    heartbeat: false,
    drone: false,
  },
  /** 7-7-7 Pachinko funk: blazing disco hats, an 8-bit chip lead, brass stabs and a euphoric fanfare. */
  JACKPOT_GOLDEN_THEME: {
    tempo: 145,
    level: 0.42,
    chords: [
      [261.63, 329.63, 392],
      [220, 277.18, 329.63],
      [174.61, 220, 261.63],
      [196, 246.94, 293.66],
    ],
    bassRoots: [65.41, 55, 43.65, 49],
    kick: grid('x...x...x...x...'),
    snare: grid('....x.......x...'),
    hat: grid('xoxoxoxoxoxoxoxo'),
    bass: grid('x.x.x.x.x.x.x.x.'),
    stab: grid('x.x...x.x.x...x.'),
    arp: [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25, 523.25, 659.25, 783.99, 1046.5, 1318.5, 1046.5, 783.99, 659.25, 523.25, 0],
    arpWave: 'square',
    pad: 0.25,
    chime: false,
    bell: true,
    clock: false,
    crackle: false,
    heartbeat: false,
    drone: false,
  },
};

const MASTER_LEVEL = 0.9;
/** How far ahead of the clock notes are placed, and how often the scheduler wakes. */
const LOOKAHEAD_S = 0.12;
const SCHEDULER_MS = 25;
const NOISE_SECONDS = 0.4;
const STEPS_PER_BAR = 16;
/** Pads sit a few cents apart so the two oscillators beat against each other. */
const PAD_DETUNE_CENTS = 7;
/** Seconds between courtroom woodblock ticks. */
const TICK_INTERVAL_S = 1;
/** Pad swell used when a profile does not set its own. */
const DEFAULT_PAD_ATTACK_S = 0.12;

export interface BgmEngineOptions {
  /** Defaults to `localStorage` when it is reachable, so the mute choice survives reloads. */
  readonly storage?: SfxStorage | null;
  /** Defaults to the platform AudioContext; injectable so tests can run without Web Audio. */
  readonly createContext?: () => AudioContext | null;
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

/** What the music is doing right now, for the debug hook and the tests. */
export interface BgmState {
  readonly running: boolean;
  /** The track the match asked for. */
  readonly track: OstTrack;
  /** The track actually sounding. During a crossfade this is the incoming one. */
  readonly playing: OstTrack | null;
  readonly tempo: number;
  readonly muted: boolean;
  readonly contextState: AudioContextState | null;
  /** True while the low-HP tension layer is sounding. */
  readonly lowHpActive: boolean;
}

/** One live track: its bus, its sidechain duck, and everything that must be stopped with it. */
interface TrackRuntime {
  readonly track: OstTrack;
  readonly profile: OstProfile;
  readonly bus: GainNode;
  readonly duck: GainNode;
  /** Where the pad voices land: the filter sweep and chorus sit in front of the duck. */
  readonly padIn: AudioNode;
  readonly sources: AudioScheduledSourceNode[];
  readonly droneOsc: OscillatorNode | null;
  /** Absolute sixteenth-step counter from the moment this track started. */
  step: number;
  nextStepAt: number;
  /** When the next courtroom woodblock tick falls. */
  nextTickAt: number;
}

/**
 * One live low-HP tension layer. It owns its own envelope and everything that has to be
 * stopped and released together, so no part of a heartbeat can outlive its cue.
 */
interface LowHpTensionRuntime {
  /** The layer's own 0-1 envelope, faded in and out over {@link LOW_HP_TENSION.fadeS}. */
  readonly gain: GainNode;
  /** The persistent sources: the drone and its slow drift LFO. */
  readonly sources: AudioScheduledSourceNode[];
  /** Every node the layer created, disconnected together when the fade is done. */
  readonly nodes: AudioNode[];
  /** Absolute audio time of the next heartbeat. */
  nextBeatAt: number;
}

/** Sets a gain to `target` over `seconds`, from wherever it is now. */
function rampGain(param: AudioParam, target: number, seconds: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + seconds);
}

/** A sustained-then-decaying tone. Self-stopping, so it needs no bookkeeping. */
function playTone(
  context: AudioContext,
  dest: AudioNode,
  type: OscillatorType,
  hz: number,
  time: number,
  duration: number,
  peak: number,
): void {
  const osc = context.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(hz, time);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), time + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(time);
  osc.stop(time + duration + 0.05);
}

/** A filtered noise burst. Self-stopping. */
function playNoise(
  context: AudioContext,
  noise: AudioBuffer,
  dest: AudioNode,
  filter: { readonly type: BiquadFilterType; readonly hz: number; readonly q: number },
  time: number,
  duration: number,
  peak: number,
): void {
  const source = context.createBufferSource();
  source.buffer = noise;
  const biquad = context.createBiquadFilter();
  biquad.type = filter.type;
  biquad.frequency.value = filter.hz;
  biquad.Q.value = filter.q;
  const gain = context.createGain();
  gain.gain.setValueAtTime(Math.max(peak, 0.0002), time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  source.connect(biquad);
  biquad.connect(gain);
  gain.connect(dest);
  source.start(time);
  source.stop(time + duration + 0.05);
}

/** The sub-kick: a sine dropping from 130Hz to 38Hz in 85ms, with a short click on top. */
function playKick(context: AudioContext, noise: AudioBuffer, dest: AudioNode, time: number, velocity: number): void {
  const osc = context.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(130, time);
  osc.frequency.exponentialRampToValueAtTime(38, time + 0.085);
  const gain = context.createGain();
  gain.gain.setValueAtTime(velocity * 0.9, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(time);
  osc.stop(time + 0.32);
  playNoise(context, noise, dest, { type: 'highpass', hz: 2500, q: 0.7 }, time, 0.012, velocity * 0.15);
}

/** Snare: noise through a 1.2kHz band-pass, layered with a 200Hz body tone. */
function playSnare(context: AudioContext, noise: AudioBuffer, dest: AudioNode, time: number, velocity: number): void {
  playNoise(context, noise, dest, { type: 'bandpass', hz: 1200, q: 1.2 }, time, 0.16, velocity * 0.5);
  playTone(context, dest, 'triangle', 200, time, 0.08, velocity * 0.3);
}

/** Hat: 7.5kHz high-pass noise, accented by velocity. */
function playHat(context: AudioContext, noise: AudioBuffer, dest: AudioNode, time: number, velocity: number): void {
  playNoise(context, noise, dest, { type: 'highpass', hz: 7500, q: 0.7 }, time, 0.04, velocity * 0.08);
}

/** Square-wave grit under a kick: a 110Hz buzz that dies in 50ms, so the downbeat sounds distorted. */
function playGrit(context: AudioContext, dest: AudioNode, time: number, velocity: number): void {
  playTone(context, dest, 'square', 110, time, 0.05, velocity * 0.08);
}

/**
 * One half of the heartbeat: a sub-bass sine that blooms in 12ms and decays exponentially.
 *
 * The node disconnects itself when it ends. A thump is one-shot, and a cue that plays once
 * a second for the rest of a match must not leave a stopped oscillator in the graph every
 * second — that is how a long low-HP fight slowly starves the audio thread.
 */
function playThump(
  context: AudioContext,
  dest: AudioNode,
  time: number,
  hz: number,
  durationS: number,
  peak: number,
): void {
  const osc = context.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(hz, time);
  const gain = context.createGain();
  // Exponential ramps cannot touch zero, so the envelope starts just above it.
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), time + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + durationS);
  osc.connect(gain);
  gain.connect(dest);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
  osc.start(time);
  osc.stop(time + durationS + 0.02);
}

/** Gavel: a low wooden thump with a short crack on top. */
function playGavel(context: AudioContext, noise: AudioBuffer, dest: AudioNode, time: number, velocity: number): void {
  playTone(context, dest, 'sine', 90, time, 0.2, velocity * 0.5);
  playNoise(context, noise, dest, { type: 'bandpass', hz: 700, q: 1.5 }, time, 0.05, velocity * 0.25);
}

/** Woodblock: a short, hollow triangle knock at 1.1kHz. */
/** Judgeman's pocket watch: a 15ms band-passed click at 2.4kHz, cold and wooden. */
function playClockTick(context: AudioContext, noise: AudioBuffer, dest: AudioNode, time: number): void {
  playNoise(context, noise, dest, { type: 'bandpass', hz: 2400, q: 8 }, time, 0.015, 0.18);
}

/** Reel click: a tight high-band tick, one per reel stop in the roll. */
function playReelClick(context: AudioContext, noise: AudioBuffer, dest: AudioNode, time: number, velocity: number): void {
  playNoise(context, noise, dest, { type: 'bandpass', hz: 3200, q: 9 }, time, 0.015, velocity * 0.12);
}

/** Bass note: a sawtooth whose low-pass opens on the note and closes over 120ms. */
function playBass(context: AudioContext, dest: AudioNode, time: number, hz: number, velocity: number): void {
  const osc = context.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(hz, time);
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 5;
  filter.frequency.setValueAtTime(900, time);
  filter.frequency.exponentialRampToValueAtTime(160, time + 0.12);
  const gain = context.createGain();
  gain.gain.setValueAtTime(velocity * 0.4, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  osc.start(time);
  osc.stop(time + 0.2);
}

/** A short brass stab: each chord tone a sawtooth through a 1.6kHz low-pass, decaying in 140ms. */
function playStab(context: AudioContext, dest: AudioNode, time: number, chord: readonly number[], velocity: number): void {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1600;
  const gain = context.createGain();
  gain.gain.setValueAtTime(velocity * 0.12, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
  filter.connect(gain);
  gain.connect(dest);
  for (const hz of chord) {
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(hz, time);
    osc.connect(filter);
    osc.start(time);
    osc.stop(time + 0.2);
  }
}

/** A detuned pad chord: triangle and saw per note, swelling in over `attack` and released at the bar's end. */
function playPad(
  context: AudioContext,
  dest: AudioNode,
  time: number,
  chord: readonly number[],
  barS: number,
  level: number,
  attack: number,
): void {
  const perVoice = level / (chord.length * 2);
  for (const hz of chord) {
    for (const [type, detune] of [
      ['triangle', -PAD_DETUNE_CENTS],
      ['sawtooth', PAD_DETUNE_CENTS],
    ] as const) {
      const osc = context.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(hz, time);
      osc.detune.setValueAtTime(detune, time);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(Math.max(perVoice, 0.0002), time + attack);
      gain.gain.setValueAtTime(perVoice * 0.9, time + barS * 0.9);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + barS + 0.05);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(time);
      osc.stop(time + barS + 0.1);
    }
  }
}

export class AdaptiveBgmEngine {
  private readonly storage: SfxStorage | null;
  private readonly factory: () => AudioContext | null;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private mutedState: boolean;
  /** The OST channel's own level, 0 to 1, on top of the master level. */
  private volumeState = 1;

  /** The track the match asked for; applied as soon as the engine is running. */
  private track: OstTrack = OST_TRACK.MENU_THEME;
  private current: TrackRuntime | null = null;
  private scheduler: ReturnType<typeof globalThis.setInterval> | null = null;
  private running = false;
  /** The last scene the tier rule was asked about, so a still frame costs one compare. */
  private sceneKey: string | null = null;
  /** The one low-HP tension layer, or null when nobody is fighting for their life. */
  private lowHpTension: LowHpTensionRuntime | null = null;
  /** Singleton guard: exactly one tension loop may exist at any time. */
  private isLowHpActive = false;

  constructor(options: BgmEngineOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.factory = options.createContext ?? defaultContextFactory;
    this.mutedState = this.readStoredMute();
  }

  get muted(): boolean {
    return this.mutedState;
  }

  set isMuted(muted: boolean) {
    this.setMuted(muted);
  }

  get isPlaying(): boolean {
    return this.running;
  }

  /** The live context state, or null before the first audio gesture. */
  get contextState(): AudioContextState | null {
    return this.context?.state ?? null;
  }

  /** Persists the preference and silences the whole bus without tearing audio down. */
  setMuted(muted: boolean): void {
    this.mutedState = muted;
    try {
      this.storage?.setItem(BGM_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // A blocked write only costs the preference on the next load.
    }
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.targetLevel(), this.context.currentTime, 0.05);
    }
  }

  /** Sets the OST channel level (0 to 1). The settings store owns persistence. */
  setVolume(volume: number): void {
    this.volumeState = Math.min(Math.max(volume, 0), 1);
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.targetLevel(), this.context.currentTime, 0.05);
    }
  }

  /** Resumes a context the browser parked; call from a user gesture. */
  unlock(): void {
    const context = this.context;
    if (!context || context.state === 'running') return;
    void context.resume().catch(() => {});
  }

  /**
   * Creates the audio context if it does not exist yet and resumes it if the browser parked
   * it. Co-op guests need this before a remotely-triggered match start: a `start` on a
   * suspended context schedules silence, and the host's click cannot unlock it.
   */
  ensureAudioContext(): AudioContext | null {
    const context = this.ensureContext();
    if (context && context.state !== 'running') void context.resume().catch(() => {});
    return context;
  }

  /**
   * Starts the music on `track`. Safe to call twice: a running engine just changes track,
   * with the same crossfade a tier change would use.
   */
  start(track: OstTrack = OST_TRACK.MENU_THEME): void {
    if (this.running) {
      this.setTrack(track);
      return;
    }
    const context = this.ensureContext();
    if (!context || !this.master) {
      this.track = track;
      return;
    }
    this.running = true;
    this.track = track;
    const now = context.currentTime;
    rampGain(this.master.gain, this.targetLevel(), 0.8, now);
    this.startScheduler();
    this.openTrack(context, track, now);
  }

  /** Stops the music: the track fades out over 350ms and the master fades with it. */
  stop(): void {
    const context = this.context;
    this.running = false;
    this.stopScheduler();
    if (!context) return;
    const now = context.currentTime;
    if (this.current) this.retire(this.current, now);
    this.current = null;
    if (this.master) rampGain(this.master.gain, 0, 0.5, now);
  }

  /**
   * Applies the match state: the tier rule picks the track and the crossfade plays it.
   *
   * The render loop calls this on every frame, so the scene is fingerprinted first. A frame
   * the rule cannot see a difference in does no work at all — no rule evaluation, no
   * crossfade, and above all no audio node built for state that did not move.
   */
  updateScene(view: PublicMatchView | null, scene: BgmSceneInput): void {
    const key = bgmSceneKey(view, scene);
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    this.setTrack(bgmTrackFor(view, scene));
  }

  /**
   * Switches to `track` with the tier crossfade: the outgoing track ramps to silence over
   * 350ms while the incoming one ramps to its level over 450ms. Only one track is ever the
   * current one, so a domain that stays open across turns never stacks.
   */
  setTrack(track: OstTrack): void {
    this.track = track;
    const context = this.context;
    if (!context || !this.running || !this.master) return;
    if (this.current?.track === track) return;
    const now = context.currentTime;
    // Judgement cuts every other track almost at once, so no menu or battle music bleeds
    // under the courtroom. Leaving the courtroom keeps the usual 350ms fade.
    const fadeS = track === OST_TRACK.HIGURUMA_COURT_THEME ? COURT_ISOLATE_FADE_S : OST_FADE_OUT_S;
    if (this.current) this.retire(this.current, now, fadeS);
    this.openTrack(context, track, now);
  }

  /**
   * The buses of the mix. The music is otherwise only observable through an AudioContext, so
   * tests and the dev hook read levels from here.
   */
  debugBuses(): { readonly master: GainNode | null; readonly bus: GainNode | null } {
    return { master: this.master, bus: this.current?.bus ?? null };
  }

  /** Everything the tests and the debug hook need to see, without reaching into the graph. */
  debugState(): BgmState {
    return {
      running: this.running,
      track: this.track,
      playing: this.current?.track ?? null,
      tempo: this.current?.profile.tempo ?? 0,
      muted: this.mutedState,
      contextState: this.context?.state ?? null,
      lowHpActive: this.isLowHpActive,
    };
  }

  /** The low-HP tension layer's envelope, for the tests and the debug hook. */
  debugLowHp(): { readonly active: boolean; readonly gain: GainNode | null } {
    return { active: this.isLowHpActive, gain: this.lowHpTension?.gain ?? null };
  }

  /** Stops every voice and closes the device. The engine is unusable afterwards. */
  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    this.master = null;
    this.noise = null;
    this.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Graph

  private targetLevel(): number {
    return this.mutedState ? 0 : MASTER_LEVEL * this.volumeState;
  }

  private readStoredMute(): boolean {
    try {
      return this.storage?.getItem(BGM_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const context = this.factory();
    if (!context) return null;
    const master = context.createGain();
    // Silent until `start` fades it in, so the music never slams on.
    master.gain.value = 0;
    master.connect(createMasterOutput(context));
    this.context = context;
    this.master = master;
    this.noise = this.buildNoise(context);
    return context;
  }

  private buildNoise(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * NOISE_SECONDS);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private startScheduler(): void {
    if (this.scheduler !== null) return;
    this.scheduler = globalThis.setInterval(() => this.tick(), SCHEDULER_MS);
  }

  private stopScheduler(): void {
    if (this.scheduler === null) return;
    globalThis.clearInterval(this.scheduler);
    this.scheduler = null;
  }

  /** Builds `track`'s graph and fades it in. The new runtime becomes the current one. */
  private openTrack(context: AudioContext, track: OstTrack, now: number): void {
    const master = this.master;
    if (!master) return;
    const profile = OST_PROFILES[track];
    const bus = context.createGain();
    bus.gain.setValueAtTime(0, now);
    bus.connect(master);
    const duck = context.createGain();
    duck.connect(bus);
    const sources: AudioScheduledSourceNode[] = [];
    const padIn = this.buildPadChain(context, duck, sources, profile.pad > 0);

    if (profile.hiss && this.noise) {
      // Tape hiss: a looping noise bed, high-passed so it reads as texture rather than static.
      const hiss = context.createBufferSource();
      hiss.buffer = this.noise;
      hiss.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 4000;
      const gain = context.createGain();
      gain.gain.value = 0.015;
      hiss.connect(filter);
      filter.connect(gain);
      gain.connect(bus);
      hiss.start(now);
      sources.push(hiss);
    }
    let droneOsc: OscillatorNode | null = null;
    if (profile.drone && profile.droneChord) {
      this.buildOrganDrone(context, bus, profile, sources, now);
    } else if (profile.drone) {
      droneOsc = context.createOscillator();
      droneOsc.type = profile.droneWave ?? 'sine';
      if (profile.droneHz !== undefined) droneOsc.frequency.value = profile.droneHz;
      const gain = context.createGain();
      gain.gain.value = profile.droneWave === 'sawtooth' ? 0.12 : 0.22;
      droneOsc.connect(gain);
      // The drone is exempt from the sidechain, so it stays under the duck's gain path.
      if (profile.droneSweep) {
        // A slow low-pass sweep over the sawtooth: the filter opens and closes at the sweep rate.
        const lowpass = context.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 220;
        lowpass.Q.value = 3;
        const lfo = context.createOscillator();
        lfo.frequency.value = profile.droneSweep;
        const depth = context.createGain();
        depth.gain.value = 160;
        lfo.connect(depth);
        depth.connect(lowpass.frequency);
        lfo.start(now);
        sources.push(lfo);
        gain.connect(lowpass);
        lowpass.connect(bus);
      } else {
        gain.connect(bus);
      }
      droneOsc.start(now);
      sources.push(droneOsc);
    }

    // The survival track carries its own tension layer. It is started here, once per
    // track, and never from the render loop: the tier change is the only event that may
    // bring a heartbeat into existence.
    if (profile.heartbeat) this.startLowHpTension(context, now);

    rampGain(bus.gain, profile.level, OST_FADE_IN_S, now);
    this.current = {
      track,
      profile,
      bus,
      duck,
      padIn,
      sources,
      droneOsc,
      step: 0,
      nextStepAt: now + 0.05,
      nextTickAt: now + 0.05,
    };
    this.tick();
  }

  /** The pad path: a slow filter sweep feeding a stereo chorus into the duck. */
  private buildPadChain(
    context: AudioContext,
    duck: AudioNode,
    sources: AudioScheduledSourceNode[],
    active: boolean,
  ): AudioNode {
    const input = context.createGain();
    if (!active) return input;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.8;
    const sweep = context.createOscillator();
    sweep.frequency.value = 0.05;
    const sweepDepth = context.createGain();
    sweepDepth.gain.value = 420;
    sweep.connect(sweepDepth);
    sweepDepth.connect(filter.frequency);
    sweep.start();
    sources.push(sweep);
    input.connect(filter);

    // Dry signal plus two delayed copies panned apart, each on its own slow LFO: the chorus.
    const chorusIn = context.createGain();
    chorusIn.connect(duck);
    filter.connect(chorusIn);
    for (const [rate, pan] of [
      [0.7, -0.6],
      [0.9, 0.6],
    ] as const) {
      const delay = context.createDelay(0.05);
      delay.delayTime.value = 0.018;
      const lfo = context.createOscillator();
      lfo.frequency.value = rate;
      const lfoDepth = context.createGain();
      lfoDepth.gain.value = 0.004;
      lfo.connect(lfoDepth);
      lfoDepth.connect(delay.delayTime);
      lfo.start();
      sources.push(lfo);
      const wet = context.createGain();
      wet.gain.value = 0.5;
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      chorusIn.connect(delay);
      delay.connect(wet);
      wet.connect(panner);
      panner.connect(duck);
    }
    return input;
  }

  /**
   * A church-organ chord under one shared low-pass that sweeps slowly. The root is a sawtooth
   * for bite and the upper voices are triangles for body, so the chord sounds heavy and close.
   */
  private buildOrganDrone(
    context: AudioContext,
    bus: AudioNode,
    profile: OstProfile,
    sources: AudioScheduledSourceNode[],
    now: number,
  ): void {
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = profile.droneCutoffHz ?? 350;
    lowpass.Q.value = 3;
    lowpass.connect(bus);

    if (profile.droneSweep) {
      const lfo = context.createOscillator();
      lfo.frequency.value = profile.droneSweep;
      const depth = context.createGain();
      depth.gain.value = profile.droneSweepDepth ?? 70;
      lfo.connect(depth);
      depth.connect(lowpass.frequency);
      lfo.start(now);
      sources.push(lfo);
    }

    (profile.droneChord ?? []).forEach((hz, index) => {
      const osc = context.createOscillator();
      osc.type = index === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.value = hz;
      const gain = context.createGain();
      gain.gain.value = index === 0 ? 0.1 : 0.14;
      osc.connect(gain);
      gain.connect(lowpass);
      osc.start(now);
      sources.push(osc);
    });
  }

  /**
   * Starts the low-HP tension layer: a muffled lub-dub heartbeat over a dark sub-drone.
   *
   * Guarded by {@link isLowHpActive}: while a layer is sounding, every further request is
   * ignored, so the render loop asking on every frame can never stack a second heartbeat.
   * The layer feeds the master bus rather than the track bus: its envelope is its own, and
   * its 400ms release must not be shortened by a track crossfade.
   */
  private startLowHpTension(context: AudioContext, now: number): void {
    if (this.isLowHpActive) return;
    const master = this.master;
    if (!master) return;
    this.isLowHpActive = true;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(1, now + LOW_HP_TENSION.fadeS);
    gain.connect(master);

    // The drone: a 72Hz triangle that drifts slowly between about 65Hz and 80Hz. A
    // triangle keeps a little body above the fundamental; the low-pass trims those upper
    // harmonics, so the drone reads as a presence under the music rather than a note.
    const drone = context.createOscillator();
    drone.type = 'triangle';
    drone.frequency.setValueAtTime(LOW_HP_TENSION.droneHz, now);
    const drift = context.createOscillator();
    drift.type = 'sine';
    drift.frequency.setValueAtTime(LOW_HP_TENSION.droneDriftRate, now);
    const driftDepth = context.createGain();
    driftDepth.gain.setValueAtTime(LOW_HP_TENSION.droneDriftHz, now);
    drift.connect(driftDepth);
    driftDepth.connect(drone.frequency);
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(LOW_HP_TENSION.droneCutoffHz, now);
    lowpass.Q.setValueAtTime(0.7, now);
    const droneGain = context.createGain();
    droneGain.gain.setValueAtTime(LOW_HP_TENSION.droneGain, now);
    drone.connect(lowpass);
    lowpass.connect(droneGain);
    droneGain.connect(gain);
    drone.start(now);
    drift.start(now);

    this.lowHpTension = {
      gain,
      sources: [drone, drift],
      nodes: [gain, drone, drift, driftDepth, lowpass, droneGain],
      nextBeatAt: now + 0.05,
    };
  }

  /**
   * Ends the tension layer: a 400ms fade, then every source is stopped and every node is
   * disconnected, so the graph is left exactly as it was before the player's HP dropped.
   */
  private stopLowHpTension(now: number): void {
    const tension = this.lowHpTension;
    this.lowHpTension = null;
    this.isLowHpActive = false;
    if (!tension) return;
    const fadeS = LOW_HP_TENSION.fadeS;
    rampGain(tension.gain.gain, 0, fadeS, now);
    // Stopping on the audio clock keeps the cut exactly at the end of the fade, whatever the
    // main thread is doing; the timer below only releases the nodes afterwards.
    for (const source of tension.sources) {
      try {
        source.stop(now + fadeS);
      } catch {
        // Already stopped by an earlier teardown.
      }
    }
    globalThis.setTimeout(() => {
      for (const node of tension.nodes) {
        try {
          node.disconnect();
        } catch {
          // Already released: nothing left to free.
        }
      }
    }, fadeS * 1000 + 80);
  }

  /** Schedules the heartbeats that fall inside the lookahead window. Cheap to call often. */
  private tickHeartbeat(context: AudioContext): void {
    const tension = this.lowHpTension;
    if (!tension) return;
    const now = context.currentTime;
    // A tab that slept must not replay every missed beat as one burst.
    if (tension.nextBeatAt < now) tension.nextBeatAt = now + 0.05;
    while (tension.nextBeatAt < now + LOOKAHEAD_S) {
      const beat = tension.nextBeatAt;
      playThump(context, tension.gain, beat, LOW_HP_TENSION.lubHz, LOW_HP_TENSION.lubS, 0.5);
      playThump(
        context,
        tension.gain,
        beat + LOW_HP_TENSION.dubDelayS,
        LOW_HP_TENSION.dubHz,
        LOW_HP_TENSION.dubS,
        0.34,
      );
      tension.nextBeatAt += LOW_HP_TENSION.beatS;
    }
  }

  /** Fades a track out, then stops its persistent sources and frees its bus. */
  private retire(runtime: TrackRuntime, now: number, fadeS: number = OST_FADE_OUT_S): void {
    if (this.current === runtime) this.current = null;
    // HP rose, the match ended or another tier took over: the heartbeat leaves with its track.
    if (runtime.profile.heartbeat) this.stopLowHpTension(now);
    rampGain(runtime.bus.gain, 0, fadeS, now);
    globalThis.setTimeout(() => {
      for (const source of runtime.sources) {
        try {
          source.stop();
        } catch {
          // Already stopped: a second stop is not an error worth reporting.
        }
      }
      try {
        runtime.bus.disconnect();
      } catch {
        // Already disconnected by an earlier retire: nothing left to release.
      }
    }, fadeS * 1000 + 100);
  }

  /** Schedules the steps that fall inside the lookahead window. Cheap to call often. */
  private tick(): void {
    const context = this.context;
    if (!context || !this.running) return;
    const runtime = this.current;
    if (runtime) {
      // A tab that slept must not replay the missed steps as one burst.
      if (runtime.nextStepAt < context.currentTime) runtime.nextStepAt = context.currentTime + 0.05;
      const stepS = 60 / runtime.profile.tempo / 4;
      while (runtime.nextStepAt < context.currentTime + LOOKAHEAD_S) {
        this.scheduleStep(context, runtime, runtime.step, runtime.nextStepAt, stepS);
        runtime.step += 1;
        runtime.nextStepAt += stepS;
      }
    }
    this.tickHeartbeat(context);
  }

  /** Places every voice of one 16th-note step. */
  private scheduleStep(context: AudioContext, runtime: TrackRuntime, absolute: number, time: number, stepS: number): void {
    const noise = this.noise;
    if (!noise) return;
    const profile = runtime.profile;
    const step = absolute % STEPS_PER_BAR;
    const bar = Math.floor(absolute / STEPS_PER_BAR);
    const chord = profile.chords[bar % profile.chords.length] ?? [];
    const root = profile.bassRoots[bar % profile.bassRoots.length] ?? 0;
    const barS = stepS * STEPS_PER_BAR;

    if (step === 0) {
      if (profile.pad > 0) playPad(context, runtime.padIn, time, chord, barS, profile.pad, profile.padAttack ?? DEFAULT_PAD_ATTACK_S);
      if (runtime.droneOsc && root > 0 && profile.droneHz === undefined) runtime.droneOsc.frequency.setValueAtTime(root / 2, time);
    }

    if (profile.tick) {
      // Exact spacing, so the clock keeps time whatever the tempo.
      const interval = profile.tickS ?? TICK_INTERVAL_S;
      while (runtime.nextTickAt < time + stepS) {
        playClockTick(context, noise, runtime.bus, Math.max(runtime.nextTickAt, time));
        runtime.nextTickAt += interval;
      }
    }

    const kick = profile.kick[step] ?? 0;
    if (kick > 0) {
      // The kick sits on the bus, not the duck: it is the sound the duck reacts to.
      playKick(context, noise, runtime.bus, time, kick);
      if (profile.distortKick) playGrit(context, runtime.bus, time, kick);
      this.duckAt(runtime.duck, time);
    }
    const snare = profile.snare[step] ?? 0;
    if (snare > 0) playSnare(context, noise, runtime.bus, time, snare);
    const hat = profile.hat[step] ?? 0;
    if (hat > 0) playHat(context, noise, runtime.bus, time, hat);
    const gavel = profile.gavel?.[step] ?? 0;
    if (gavel > 0) playGavel(context, noise, runtime.bus, time, gavel);
    const reel = profile.reel?.[step] ?? 0;
    if (reel > 0) playReelClick(context, noise, runtime.bus, time, reel);
    const bass = profile.bass[step] ?? 0;
    if (bass > 0 && root > 0) playBass(context, runtime.duck, time, root, bass);
    const stab = profile.stab[step] ?? 0;
    if (stab > 0 && chord.length > 0) playStab(context, runtime.duck, time, chord, stab);
    const arp = profile.arp[step] ?? 0;
    if (arp > 0) playTone(context, runtime.bus, profile.arpWave, arp, time, 0.12, 0.05);
    if (profile.chime && (step === 0 || step === 6 || step === 11) && chord.length > 0) {
      playTone(context, runtime.bus, 'sine', (chord[0] ?? 0) * 4, time, 1.6, 0.06);
    }
    if (profile.bell && step === 0) {
      playTone(context, runtime.bus, 'sine', 880, time, 1.8, 0.12);
      playTone(context, runtime.bus, 'sine', 1760, time, 1.2, 0.04);
    }
    if (profile.clock && step % 4 === 0) {
      playNoise(context, noise, runtime.bus, { type: 'bandpass', hz: 4200, q: 6 }, time, 0.03, 0.12);
    }
    if (profile.crackle && Math.random() < 0.35) {
      playNoise(context, noise, runtime.bus, { type: 'highpass', hz: 3000, q: 0.7 }, time, 0.006, 0.04);
    }
  }

  /** The sidechain: on a kick the duck drops to -4dB and releases over about 110ms. */
  private duckAt(duck: GainNode, time: number): void {
    duck.gain.cancelScheduledValues(time);
    duck.gain.setValueAtTime(DUCK_GAIN, time);
    duck.gain.linearRampToValueAtTime(1, time + DUCK_RELEASE_S);
  }
}

/** The one music engine the match uses. Creating it touches no audio until something starts it. */
export const bgm = new AdaptiveBgmEngine();
